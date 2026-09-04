export type ActivityLogLevel = 'info' | 'warn' | 'error'
export type ActivityLogStatus = 'info' | 'success' | 'warning' | 'failure'
export type ActivityLogCategory = 'execution' | 'command' | 'category' | 'library' | 'settings' | 'system'
export type ActivityLogRetentionMode = 'count' | 'days' | 'size' | 'unlimited'
export type ActivityLogSizeUnit = 'MB' | 'GB'

export interface ActivityLogSubject {
    type: 'command' | 'category' | 'library' | 'settings' | 'system'
    id?: string
    name?: string
}

export type ActivityLogDetailValue = string | number | boolean | string[] | null

export interface ActivityLogEntry {
    id: string
    time: string
    level: ActivityLogLevel
    message: string
    category?: ActivityLogCategory
    action?: string
    status?: ActivityLogStatus
    subject?: ActivityLogSubject
    details?: Record<string, ActivityLogDetailValue>

    // Legacy execution fields are retained so existing logs and automation code
    // remain readable while new records use the structured fields above.
    commandId?: string
    commandName?: string
    commandText?: string
    line?: number
    mode?: string
    targetNames?: string[]
    durationMs?: number
}

export interface ActivityLogDraft extends Omit<ActivityLogEntry, 'id' | 'time' | 'level'> {
    id?: string
    time?: string
    level?: ActivityLogLevel
}

export interface ActivityLogRetentionSettings {
    mode: ActivityLogRetentionMode
    count: number
    days: number
    sizeMb: number
    warningSizeMb: number
    sizeUnit: ActivityLogSizeUnit
    warningSizeUnit: ActivityLogSizeUnit
}
