import { ActivityLogCategory, ActivityLogEntry, ActivityLogLevel } from './activityLog.types'

export interface ActivityLogQuery {
    text: string
    category: 'all' | ActivityLogCategory
    level: 'all' | ActivityLogLevel
}

export function filterActivityLogs (entries: ActivityLogEntry[], query: ActivityLogQuery): ActivityLogEntry[] {
    const text = query.text.trim().toLowerCase()
    return [...entries].reverse().filter(entry => {
        if (query.category !== 'all' && (entry.category || 'execution') !== query.category) {
            return false
        }
        if (query.level !== 'all' && entry.level !== query.level) {
            return false
        }
        if (!text) { return true }
        return activityLogSearchText(entry).includes(text)
    })
}

export function activityLogSearchText (entry: ActivityLogEntry): string {
    const details = entry.details
        ? Object.values(entry.details).reduce<Array<string | number | boolean | null>>((all, value) => (
            [...all, ...(Array.isArray(value) ? value : [value])]
        ), [])
        : []
    return [
        entry.message,
        entry.action,
        entry.subject?.name,
        entry.commandName,
        entry.commandText,
        entry.mode,
        ...(entry.targetNames || []),
        ...details,
    ].filter(value => value !== undefined && value !== null).join(' ').toLowerCase()
}
