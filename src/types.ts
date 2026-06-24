export type ExecutionMode = 'paste' | 'line'
export type TargetMode = 'current' | 'all'
export type FailureStrategy = 'continue' | 'stop' | 'manual'
export type ImportMode = 'merge' | 'replace'
export type OutputMatchMode = 'literal' | 'regex'
export type OutputPatternLogic = 'single' | 'any' | 'all'
export type AutomationCommandAction = 'none' | 'custom' | 'command'
export type AutomationTimeoutAction = 'continue' | 'stop' | 'custom' | 'command'

export interface QuickAutomationRule {
    id: string
    name: string
    enabled: boolean
    collapsed: boolean
    matchMode: OutputMatchMode
    waitFor: string
    waitForLogic: OutputPatternLogic
    timeoutMs: number
    errorPattern: string
    errorPatternLogic: OutputPatternLogic
    onMatchAction: AutomationCommandAction
    onMatchCommand: string
    onMatchAutoEnter: boolean
    onMatchCommandId: string
    onErrorAction: AutomationCommandAction
    onErrorCommand: string
    onErrorAutoEnter: boolean
    onErrorCommandId: string
    onTimeoutCommand: string
    onTimeoutAutoEnter: boolean
    onTimeoutCommandId: string
    timeoutAction: AutomationTimeoutAction
}

export interface QuickCommand {
    id: string
    name: string
    description: string
    category: string
    command: string
    autoEnter: boolean
    lineDelay: number
    lineDelays: number[]
    linePauses: boolean[]
    shortcut: string
    favorite: boolean
    pinned: boolean
    usageCount: number
    lastUsedAt: string | null
    automationRules: QuickAutomationRule[]
}

export interface QuickCommandsConfig {
    commands: QuickCommand[]
    customCategories: string[]
    categoryOrder: string[]
    selectedCommandId: string | null
    selectedCategory: string
    executionMode: ExecutionMode
    targetMode: TargetMode
    failureStrategy: FailureStrategy
    drawerWidth: number
    showToolbarButton: boolean
    requireConfirmBeforeExecute: boolean
    confirmBroadcast: boolean
    exportFileName: string
    basicInfoCollapsed: boolean
    moreSettingsCollapsed: boolean
    previewCollapsed: boolean
    recentOutputLimit: number
    logLimit: number
    automationLogs: AutomationLogEntry[]
}

export interface AutomationLogEntry {
    id: string
    time: string
    level: 'info' | 'warn' | 'error'
    message: string
    commandId?: string
    commandName?: string
    commandText?: string
    line?: number
    mode?: string
    targetNames?: string[]
    durationMs?: number
}
