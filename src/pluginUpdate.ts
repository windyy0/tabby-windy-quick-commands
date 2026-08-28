import { PluginLanguage } from './translations'

export type UpdateCheckInterval = 'daily' | 'weekly' | 'never'

const updateCheckIntervalMs: Record<Exclude<UpdateCheckInterval, 'never'>, number> = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
}

export function getNextPluginUpdateCheckDelay (
    interval: UpdateCheckInterval,
    cachedCheckedAt: string | null | undefined,
    lastAttemptAt: number,
    now = Date.now(),
): number | null {
    if (interval === 'never') {
        return null
    }
    const parsedCheckedAt = cachedCheckedAt ? new Date(cachedCheckedAt).getTime() : 0
    const checkedAt = Number.isFinite(parsedCheckedAt) && parsedCheckedAt > 0 ? parsedCheckedAt : 0
    const attemptedAt = Number.isFinite(lastAttemptAt) && lastAttemptAt > 0 ? lastAttemptAt : 0
    return Math.max(0, Math.max(checkedAt, attemptedAt) + updateCheckIntervalMs[interval] - now)
}

export interface PluginUpdateNotesSection {
    title: string
    items: string[]
}

export interface PluginUpdateNotesDocument {
    title?: string
    sections?: PluginUpdateNotesSection[]
    notice?: string
}

export interface LocalizedPluginUpdateNotesDocument {
    'zh-CN'?: PluginUpdateNotesDocument
    en?: PluginUpdateNotesDocument
}

interface ParsedVersion {
    core: number[]
    prerelease: Array<number | string>
}

function parseVersion (version: string): ParsedVersion | null {
    const normalized = String(version || '').trim().replace(/^v/i, '').split('+', 1)[0]
    const [coreText, prereleaseText = ''] = normalized.split('-', 2)
    const parts = coreText.split('.')
    if (!parts.length || parts.some(part => !/^\d+$/.test(part))) {
        return null
    }
    const core = parts.map(part => Number(part))
    while (core.length < 3) {
        core.push(0)
    }
    const prerelease = prereleaseText
        ? prereleaseText.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)
        : []
    return { core, prerelease }
}

/** Compares npm-style semantic versions without accepting version ranges. */
export function comparePluginVersions (left: string, right: string): number {
    const a = parseVersion(left)
    const b = parseVersion(right)
    if (!a || !b) {
        return String(left).localeCompare(String(right), 'en', { numeric: true })
    }
    const coreLength = Math.max(a.core.length, b.core.length)
    for (let index = 0; index < coreLength; index++) {
        const difference = (a.core[index] || 0) - (b.core[index] || 0)
        if (difference) {
            return difference > 0 ? 1 : -1
        }
    }
    if (!a.prerelease.length || !b.prerelease.length) {
        if (a.prerelease.length === b.prerelease.length) {
            return 0
        }
        return a.prerelease.length ? -1 : 1
    }
    const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length)
    for (let index = 0; index < prereleaseLength; index++) {
        const aPart = a.prerelease[index]
        const bPart = b.prerelease[index]
        if (aPart === undefined || bPart === undefined) {
            return aPart === bPart ? 0 : aPart === undefined ? -1 : 1
        }
        if (aPart === bPart) {
            continue
        }
        if (typeof aPart === 'number' && typeof bPart === 'string') {
            return -1
        }
        if (typeof aPart === 'string' && typeof bPart === 'number') {
            return 1
        }
        return aPart > bPart ? 1 : -1
    }
    return 0
}

export function isNewerPluginVersion (candidate: string, current: string): boolean {
    return comparePluginVersions(candidate, current) > 0
}

/** Local Dev builds compare against their source version, while keeping genuine prereleases. */
export function getUpdateComparisonVersion (version: string, devBuild: boolean): string {
    return devBuild ? version.replace(/-dev\.local(?=\+|$)/, '') : version
}

function selectPluginUpdateNotes (
    value: unknown,
    language: PluginLanguage,
): { document: Record<string, unknown>; language: PluginLanguage } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    const root = value as Record<string, unknown>
    const hasLocalizedDocuments = Object.prototype.hasOwnProperty.call(root, 'zh-CN') ||
        Object.prototype.hasOwnProperty.call(root, 'en')
    if (!hasLocalizedDocuments) {
        return { document: root, language }
    }
    const fallbackLanguage: PluginLanguage = language === 'zh-CN' ? 'en' : 'zh-CN'
    const selectedLanguage = root[language] ? language : fallbackLanguage
    const selected = root[selectedLanguage]
    return selected && typeof selected === 'object' && !Array.isArray(selected)
        ? { document: selected as Record<string, unknown>, language: selectedLanguage }
        : null
}

export function formatPluginUpdateNotes (value: unknown, language: PluginLanguage = 'zh-CN'): string {
    const selected = selectPluginUpdateNotes(value, language)
    if (!selected) {
        return ''
    }
    const { document } = selected
    const lines: string[] = []
    const title = typeof document.title === 'string' ? document.title.trim() : ''
    if (title) {
        lines.push(title)
    }
    if (Array.isArray(document.sections)) {
        document.sections.forEach(sectionValue => {
            if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
                return
            }
            const section = sectionValue as Record<string, unknown>
            const sectionTitle = typeof section.title === 'string' ? section.title.trim() : ''
            const items = Array.isArray(section.items)
                ? section.items
                    .filter((item): item is string => typeof item === 'string')
                    .map(item => item.trim())
                    .filter(Boolean)
                : []
            if (!sectionTitle || !items.length) {
                return
            }
            if (lines.length) {
                lines.push('')
            }
            lines.push(sectionTitle, ...items.map(item => `• ${item}`))
        })
    }
    const notice = typeof document.notice === 'string' ? document.notice.trim() : ''
    if (notice) {
        if (lines.length) {
            lines.push('')
        }
        lines.push(selected.language === 'zh-CN' ? `注意事项：${notice}` : `Note: ${notice}`)
    }
    return lines.join('\n')
}
