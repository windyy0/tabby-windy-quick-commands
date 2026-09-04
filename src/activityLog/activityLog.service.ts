import { PluginIdentity, pluginIdentity } from '../pluginIdentity'
import { applyActivityLogRetention, activityLogSizeWarning } from './activityLog.retention'
import { ActivityLogStorage } from './activityLog.storage'
import {
    ActivityLogDraft,
    ActivityLogEntry,
    ActivityLogLevel,
    ActivityLogRetentionSettings,
    ActivityLogStatus,
} from './activityLog.types'

export class ActivityLogService {
    readonly storage: ActivityLogStorage

    constructor (configPath: string | null, identity: PluginIdentity = pluginIdentity) {
        this.storage = new ActivityLogStorage(configPath, identity)
    }

    getEntries (): ActivityLogEntry[] {
        return this.storage.getEntries()
    }

    record (draft: ActivityLogDraft, retention: ActivityLogRetentionSettings): ActivityLogEntry {
        const status = draft.status || statusFromLevel(draft.level || 'info')
        const entry: ActivityLogEntry = {
            ...draft,
            id: draft.id || createActivityLogId(),
            time: draft.time || new Date().toISOString(),
            level: draft.level || levelFromStatus(status),
            category: draft.category || 'system',
            action: draft.action || 'system.event',
            status,
        }
        const current = this.storage.getEntries(true)
        const candidate = [...current, entry]
        const retained = applyActivityLogRetention(candidate, retention)
        if (retained.length === candidate.length) {
            this.storage.append(entry)
        } else {
            this.storage.setEntries(retained)
        }
        return entry
    }

    prune (retention: ActivityLogRetentionSettings): ActivityLogEntry[] {
        const current = this.storage.getEntries(true)
        const entries = applyActivityLogRetention(current, retention)
        if (entries.length !== current.length) {
            this.storage.setEntries(entries)
        }
        return entries
    }

    clear (): void {
        this.storage.clear()
    }

    ensureDirectory (): string | null {
        return this.storage.ensureDirectory()
    }

    hasSizeWarning (retention: ActivityLogRetentionSettings): boolean {
        return activityLogSizeWarning(this.storage.getSizeBytes(), retention)
    }
}

function statusFromLevel (level: ActivityLogLevel): ActivityLogStatus {
    return level === 'error' ? 'failure' : level === 'warn' ? 'warning' : 'info'
}

function levelFromStatus (status: ActivityLogStatus): ActivityLogLevel {
    return status === 'failure' ? 'error' : status === 'warning' ? 'warn' : 'info'
}

function createActivityLogId (): string {
    return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}
