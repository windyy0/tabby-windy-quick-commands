import { ActivityLogEntry, ActivityLogRetentionMode, ActivityLogRetentionSettings, ActivityLogSizeUnit } from './activityLog.types'

export const defaultActivityLogRetention: ActivityLogRetentionSettings = {
    mode: 'count',
    count: 200,
    days: 30,
    sizeMb: 10,
    warningSizeMb: 10,
    sizeUnit: 'MB',
    warningSizeUnit: 'MB',
}

export function normalizeActivityLogRetention (source: Record<string, unknown>): ActivityLogRetentionSettings {
    const mode = source.logRetentionMode
    return {
        mode: isRetentionMode(mode) ? mode : defaultActivityLogRetention.mode,
        count: clampNumber(source.logLimit, 20, 20000, defaultActivityLogRetention.count),
        days: clampNumber(source.logRetentionDays, 1, 3650, defaultActivityLogRetention.days),
        sizeMb: clampNumber(source.logSizeLimitMb, 1, 102400, defaultActivityLogRetention.sizeMb),
        warningSizeMb: clampNumber(source.logWarningSizeMb, 1, 102400, defaultActivityLogRetention.warningSizeMb),
        sizeUnit: normalizeSizeUnit(source.logSizeUnit, defaultActivityLogRetention.sizeUnit),
        warningSizeUnit: normalizeSizeUnit(source.logWarningSizeUnit, defaultActivityLogRetention.warningSizeUnit),
    }
}

export function applyActivityLogRetention (
    entries: ActivityLogEntry[],
    settings: ActivityLogRetentionSettings,
    now = Date.now(),
): ActivityLogEntry[] {
    if (!entries.length || settings.mode === 'unlimited') {
        return [...entries]
    }
    if (settings.mode === 'count') {
        return entries.slice(-settings.count)
    }
    if (settings.mode === 'days') {
        const cutoff = now - settings.days * 24 * 60 * 60 * 1000
        return entries.filter(entry => {
            const time = new Date(entry.time).getTime()
            return !Number.isFinite(time) || time >= cutoff
        })
    }
    return trimActivityLogsToBytes(entries, settings.sizeMb * 1024 * 1024)
}

export function estimateActivityLogBytes (entries: ActivityLogEntry[]): number {
    return entries.reduce((total, entry) => total + utf8ByteLength(`${JSON.stringify(entry)}\n`), 0)
}

export function activityLogSizeWarning (
    sizeBytes: number,
    settings: ActivityLogRetentionSettings,
): boolean {
    return sizeBytes >= settings.warningSizeMb * 1024 * 1024
}

export function activityLogSizeValue (sizeMb: number, unit: ActivityLogSizeUnit): number {
    return unit === 'GB' ? Math.round(sizeMb / 1024 * 100) / 100 : sizeMb
}

function trimActivityLogsToBytes (entries: ActivityLogEntry[], maxBytes: number): ActivityLogEntry[] {
    if (estimateActivityLogBytes(entries) <= maxBytes) {
        return [...entries]
    }

    // Keep the newest entry even when a single unusually large record exceeds
    // the configured limit. Dropping the event that triggered cleanup would be
    // more surprising than temporarily exceeding the target size.
    let low = 0
    let high = Math.max(0, entries.length - 1)
    while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (estimateActivityLogBytes(entries.slice(middle)) <= maxBytes) {
            high = middle
        } else {
            low = middle + 1
        }
    }
    return entries.slice(low)
}

function isRetentionMode (value: unknown): value is ActivityLogRetentionMode {
    return value === 'count' || value === 'days' || value === 'size' || value === 'unlimited'
}

function normalizeSizeUnit (value: unknown, fallback: ActivityLogSizeUnit): ActivityLogSizeUnit {
    return value === 'GB' ? 'GB' : value === 'MB' ? 'MB' : fallback
}

function clampNumber (value: unknown, min: number, max: number, fallback: number): number {
    const number = Number(value)
    return Math.max(min, Math.min(max, Number.isFinite(number) ? Math.round(number) : fallback))
}

function utf8ByteLength (value: string): number {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(value).length
    }
    return unescape(encodeURIComponent(value)).length
}
