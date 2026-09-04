import * as fs from 'fs'
import * as path from 'path'

import { PluginDataAccess } from '../pluginData'
import { pluginIdentity, PluginIdentity } from '../pluginIdentity'
import { ActivityLogCategory, ActivityLogEntry, ActivityLogLevel, ActivityLogStatus } from './activityLog.types'

export const activityLogSegmentSizeBytes = 10 * 1024 * 1024

const activityLogDirectoryName = 'activity-logs'
const legacyActivityLogFileName = 'logs.json'
const segmentFilePattern = /^activity-(\d{6})\.jsonl$/

export class ActivityLogStorage {
    readonly path: string | null
    readonly legacyPath: string | null
    private entries: ActivityLogEntry[] | null = null
    private dataAccess: PluginDataAccess

    constructor (configPath: string | null, readonly identity: PluginIdentity = pluginIdentity) {
        this.dataAccess = new PluginDataAccess(configPath, identity)
        const directory = configPath ? path.join(path.dirname(configPath), identity.dataDirectory) : null
        this.path = directory ? path.join(directory, activityLogDirectoryName) : null
        this.legacyPath = directory ? path.join(directory, legacyActivityLogFileName) : null
    }

    getEntries (reload = false): ActivityLogEntry[] {
        if (reload || !this.entries) {
            this.entries = this.readEntries()
        }
        return [...this.entries]
    }

    setEntries (entries: ActivityLogEntry[]): void {
        if (!this.dataAccess.isCurrent()) { return }
        this.entries = entries.map(normalizeActivityLogEntry).filter((entry): entry is ActivityLogEntry => Boolean(entry))
        this.writeEntries(this.entries)
        this.notifyChanged()
    }

    append (entry: ActivityLogEntry): void {
        if (!this.dataAccess.isCurrent()) { return }
        const normalized = normalizeActivityLogEntry(entry)
        if (!normalized || !this.path) { return }
        this.ensureMigrated()
        let written = false
        try {
            this.dataAccess.write(() => {
                fs.mkdirSync(this.path!, { recursive: true })
                const line = `${JSON.stringify(normalized)}\n`
                const names = this.segmentNames()
                const lastName = names[names.length - 1]
                const lastPath = lastName ? path.join(this.path!, lastName) : null
                const canAppend = lastPath && fs.statSync(lastPath).size + utf8ByteLength(line) <= activityLogSegmentSizeBytes
                if (canAppend) {
                    fs.appendFileSync(lastPath!, line, 'utf8')
                } else {
                    const lastNumber = lastName ? Number(segmentFilePattern.exec(lastName)?.[1]) || 0 : 0
                    fs.writeFileSync(path.join(this.path!, segmentFileName(lastNumber)), line, { encoding: 'utf8', flag: 'wx' })
                }
                written = true
            })
        } catch {
            // Activity logging must never prevent the requested user operation.
        }
        if (written) {
            this.entries = this.entries ? [...this.entries, normalized] : null
            this.notifyChanged()
        }
    }

    clear (): void {
        this.setEntries([])
    }

    ensureDirectory (): string | null {
        if (!this.path || !this.dataAccess.isCurrent()) { return null }
        try {
            this.dataAccess.write(() => fs.mkdirSync(this.path!, { recursive: true }))
            return this.path
        } catch {
            return null
        }
    }

    getSizeBytes (): number {
        this.ensureMigrated()
        return this.segmentNames().reduce((total, name) => {
            try {
                return total + fs.statSync(path.join(this.path!, name)).size
            } catch {
                return total
            }
        }, 0)
    }

    private readEntries (): ActivityLogEntry[] {
        this.ensureMigrated()
        const entries = this.readSegmentEntries()
        if (entries.length || !this.legacyPath || !fs.existsSync(this.legacyPath)) {
            return entries
        }
        // If migration could not acquire the writer lock, keep the old log
        // readable for this session instead of presenting an empty history.
        return this.readLegacyEntries()
    }

    private readSegmentEntries (): ActivityLogEntry[] {
        if (!this.path) { return [] }
        const entries: ActivityLogEntry[] = []
        for (const name of this.segmentNames()) {
            let content = ''
            try { content = fs.readFileSync(path.join(this.path, name), 'utf8') } catch { continue }
            for (const line of content.split(/\r?\n/)) {
                if (!line.trim()) { continue }
                try {
                    const entry = normalizeActivityLogEntry(JSON.parse(line))
                    if (entry) { entries.push(entry) }
                } catch {
                    // JSONL isolates damage to one record; later records remain readable.
                }
            }
        }
        return entries
    }

    private readLegacyEntries (): ActivityLogEntry[] {
        return this.parseLegacyEntries() || []
    }

    private parseLegacyEntries (): ActivityLogEntry[] | null {
        if (!this.legacyPath || !fs.existsSync(this.legacyPath)) { return null }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.legacyPath, 'utf8'))
            return Array.isArray(parsed)
                ? parsed.map(normalizeActivityLogEntry).filter((entry): entry is ActivityLogEntry => Boolean(entry))
                : null
        } catch {
            return null
        }
    }

    private ensureMigrated (): void {
        if (!this.path || !this.legacyPath || !fs.existsSync(this.legacyPath) || !this.dataAccess.isCurrent()) { return }
        try {
            this.dataAccess.write(() => {
                if (!fs.existsSync(this.legacyPath!)) { return }
                const legacyEntries = this.parseLegacyEntries()
                if (!legacyEntries) { return }
                const merged = new Map<string, ActivityLogEntry>()
                for (const entry of [...legacyEntries, ...this.readSegmentEntries()]) {
                    merged.set(entry.id, entry)
                }
                const entries = [...merged.values()].sort((left, right) => timeValue(left.time) - timeValue(right.time))
                this.writeSegmentsUnsafe(entries)
                fs.unlinkSync(this.legacyPath!)
            })
        } catch {
            // A concurrent writer or unavailable disk must not block the settings page.
        }
    }

    private writeEntries (entries: ActivityLogEntry[]): void {
        if (!this.path) { return }
        try {
            this.dataAccess.write(() => {
                this.writeSegmentsUnsafe(entries)
                // A successful write supersedes the old single-file format.
                if (this.legacyPath && fs.existsSync(this.legacyPath)) {
                    fs.unlinkSync(this.legacyPath)
                }
            })
        } catch {
            // Activity logging must never prevent the requested user operation.
        }
    }

    private writeSegmentsUnsafe (entries: ActivityLogEntry[]): void {
        if (!this.path) { return }
        fs.mkdirSync(this.path, { recursive: true })
        const segments = splitActivityLogSegments(entries)
        const activeNames = new Set<string>()
        segments.forEach((content, index) => {
            const name = segmentFileName(index)
            activeNames.add(name)
            fs.writeFileSync(path.join(this.path!, name), content, 'utf8')
        })
        for (const name of this.segmentNames()) {
            if (!activeNames.has(name)) {
                fs.unlinkSync(path.join(this.path, name))
            }
        }
    }

    private segmentNames (): string[] {
        if (!this.path || !fs.existsSync(this.path)) { return [] }
        try {
            return fs.readdirSync(this.path)
                .filter(name => segmentFilePattern.test(name))
                .sort()
        } catch {
            return []
        }
    }

    private notifyChanged (): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(this.identity.runtimeChangedEvent))
        }
    }
}

export function splitActivityLogSegments (
    entries: ActivityLogEntry[],
    maxBytes = activityLogSegmentSizeBytes,
): string[] {
    const limit = Math.max(1, Math.floor(maxBytes))
    const segments: string[] = []
    let lines: string[] = []
    let sizeBytes = 0
    for (const entry of entries) {
        const line = `${JSON.stringify(entry)}\n`
        const lineBytes = utf8ByteLength(line)
        if (lines.length && sizeBytes + lineBytes > limit) {
            segments.push(lines.join(''))
            lines = []
            sizeBytes = 0
        }
        lines.push(line)
        sizeBytes += lineBytes
    }
    if (lines.length) { segments.push(lines.join('')) }
    return segments
}

function segmentFileName (index: number): string {
    return `activity-${String(index + 1).padStart(6, '0')}.jsonl`
}

function utf8ByteLength (value: string): number {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(value).length
    }
    return unescape(encodeURIComponent(value)).length
}

function normalizeActivityLogEntry (value: unknown): ActivityLogEntry | null {
    if (!value || typeof value !== 'object') { return null }
    const source = value as Partial<ActivityLogEntry>
    if (typeof source.message !== 'string') { return null }
    const level: ActivityLogLevel = source.level === 'warn' || source.level === 'error' ? source.level : 'info'
    const status: ActivityLogStatus = source.status === 'success' || source.status === 'warning' ||
        source.status === 'failure' || source.status === 'info'
        ? source.status
        : level === 'error' ? 'failure' : level === 'warn' ? 'warning' : 'info'
    const category: ActivityLogCategory = isActivityLogCategory(source.category) ? source.category : 'execution'
    return {
        ...source,
        id: typeof source.id === 'string' && source.id ? source.id : createActivityLogId(),
        time: typeof source.time === 'string' && source.time ? source.time : new Date().toISOString(),
        level,
        message: source.message,
        category,
        action: typeof source.action === 'string' && source.action ? source.action : `${category}.event`,
        status,
    }
}

function isActivityLogCategory (value: unknown): value is ActivityLogCategory {
    return value === 'execution' || value === 'command' || value === 'category' ||
        value === 'library' || value === 'settings' || value === 'system'
}

function timeValue (value: string): number {
    const time = new Date(value).getTime()
    return Number.isFinite(time) ? time : 0
}

function createActivityLogId (): string {
    return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}
