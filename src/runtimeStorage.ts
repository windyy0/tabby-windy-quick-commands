import * as fs from 'fs'
import * as path from 'path'

import { AutomationLogEntry } from './types'

export interface CommandUsageStat {
    usageCount: number
    lastUsedAt: string | null
}

export type CommandUsageStats = Record<string, CommandUsageStat>

const runtimeChangedEvent = 'windy-quick-commands-runtime-changed'

export class QuickCommandsRuntimeStore {
    readonly logsPath: string | null
    readonly statsPath: string | null
    private logs: AutomationLogEntry[] | null = null
    private stats: CommandUsageStats | null = null

    constructor (configPath: string | null) {
        const directory = configPath
            ? path.join(path.dirname(configPath), 'windy-quick-commands')
            : null
        this.logsPath = directory ? path.join(directory, 'logs.json') : null
        this.statsPath = directory ? path.join(directory, 'command-stats.json') : null
    }

    getLogs (): AutomationLogEntry[] {
        if (!this.logs) {
            this.logs = this.readJson<AutomationLogEntry[]>(this.logsPath, [])
        }
        return [...this.logs]
    }

    setLogs (logs: AutomationLogEntry[]): void {
        this.logs = [...logs]
        this.writeJson(this.logsPath, this.logs)
        this.notifyChanged()
    }

    getStats (): CommandUsageStats {
        if (!this.stats) {
            this.stats = this.readJson<CommandUsageStats>(this.statsPath, {})
        }
        return { ...this.stats }
    }

    setStats (stats: CommandUsageStats): void {
        this.stats = { ...stats }
        this.writeJson(this.statsPath, this.stats)
        this.notifyChanged()
    }

    mergeLegacyLogs (logs: AutomationLogEntry[], limit: number): void {
        if (!logs.length) {
            return
        }
        const merged = new Map(this.getLogs().map(log => [log.id, log]))
        logs.forEach(log => merged.set(log.id, log))
        const next = [...merged.values()]
            .sort((a, b) => this.timeValue(a.time) - this.timeValue(b.time))
            .slice(-limit)
        this.setLogs(next)
    }

    mergeLegacyStats (stats: CommandUsageStats): void {
        const current = this.getStats()
        Object.entries(stats).forEach(([commandId, legacy]) => {
            const existing = current[commandId]
            current[commandId] = {
                usageCount: Math.max(existing?.usageCount || 0, legacy.usageCount || 0),
                lastUsedAt: this.latestTime(existing?.lastUsedAt, legacy.lastUsedAt),
            }
        })
        this.setStats(current)
    }

    private readJson<T> (filePath: string | null, fallback: T): T {
        if (!filePath || !fs.existsSync(filePath)) {
            return fallback
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
        } catch {
            return fallback
        }
    }

    private writeJson (filePath: string | null, value: unknown): void {
        if (!filePath) {
            return
        }
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        } catch {
            // Runtime data must not prevent command execution when the disk is unavailable.
        }
    }

    private notifyChanged (): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(runtimeChangedEvent))
        }
    }

    private latestTime (first: string | null | undefined, second: string | null | undefined): string | null {
        if (!first) {
            return second || null
        }
        if (!second) {
            return first
        }
        return this.timeValue(first) >= this.timeValue(second) ? first : second
    }

    private timeValue (value: string): number {
        const time = new Date(value).getTime()
        return Number.isFinite(time) ? time : 0
    }
}

