import { QuickAutomationRule, QuickCommand } from './types'
import { normalizeShortcut } from './shortcutManager'

export interface ImportConflict {
    command: QuickCommand
    reason: string
    scope: 'existing' | 'file'
}

export interface ImportPreview {
    commands: QuickCommand[]
    added: QuickCommand[]
    overwritten: QuickCommand[]
    conflicts: ImportConflict[]
    customCategories: string[]
    categoryOrder: string[]
    sourceVersion: number
}

export interface ParsedImportPayload {
    commands: Array<Partial<QuickCommand>>
    customCategories: string[]
    categoryOrder: string[]
    version: number
}

export interface SanitizedAutomationReferences {
    commands: QuickCommand[]
    clearedReferences: number
}

export function normalizeCommandText (command: string): string {
    return command.replace(/(?:\r?\n[\t ]*)+$/, '')
}

export function buildTerminalPayload (command: string, autoEnter: boolean): string {
    const normalized = normalizeCommandText(command)
    if (!normalized.trim()) {
        return ''
    }
    const payload = normalized.split(/\r?\n/).join('\r')
    return autoEnter ? `${payload}\r` : payload
}

export function resolveSelectedCommand (commands: QuickCommand[], selectedCommandId: string | null): QuickCommand | null {
    return commands.find(command => command.id === selectedCommandId) || commands[0] || null
}

export const quickCommandsSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Tabby Windy Quick Commands Library',
    type: 'object',
    required: ['version', 'commands'],
    properties: {
        version: { type: 'number' },
        exportedAt: { type: 'string' },
        format: { type: 'string' },
        customCategories: { type: 'array', items: { type: 'string' } },
        categoryOrder: { type: 'array', items: { type: 'string' } },
        commands: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'command'],
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    category: { type: 'string' },
                    command: { type: 'string' },
                    autoEnter: { type: 'boolean' },
                    lineDelay: { type: 'number' },
                    lineDelays: { type: 'array', items: { type: 'number' } },
                    linePauses: { type: 'array', items: { type: 'boolean' } },
                    shortcut: { type: 'string' },
                    favorite: { type: 'boolean' },
                    pinned: { type: 'boolean' },
                    automationRules: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                enabled: { type: 'boolean' },
                                collapsed: { type: 'boolean' },
                                matchMode: { enum: ['literal', 'regex'] },
                                waitFor: { type: 'string' },
                                waitForLogic: { enum: ['single', 'any', 'all'] },
                                timeoutMs: { type: 'number' },
                                errorPattern: { type: 'string' },
                                errorPatternLogic: { enum: ['single', 'any', 'all'] },
                                onMatchAction: { enum: ['none', 'custom', 'command'] },
                                onMatchCommand: { type: 'string' },
                                onMatchAutoEnter: { type: 'boolean' },
                                onMatchCommandId: { type: 'string' },
                                onErrorAction: { enum: ['none', 'custom', 'command'] },
                                onErrorCommand: { type: 'string' },
                                onErrorAutoEnter: { type: 'boolean' },
                                onErrorCommandId: { type: 'string' },
                                onTimeoutCommand: { type: 'string' },
                                onTimeoutAutoEnter: { type: 'boolean' },
                                onTimeoutCommandId: { type: 'string' },
                                timeoutAction: { enum: ['continue', 'stop', 'custom', 'command'] },
                            },
                        },
                    },
                },
            },
        },
    },
}

export function parseImportPayload (text: string): ParsedImportPayload {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error('JSON 格式无效。')
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('只支持 v3 命令库对象，不支持旧版数组格式。')
    }
    const root = parsed as Record<string, unknown>
    if (root.format !== 'tabby-windy-quick-commands') {
        throw new Error('文件不是 Tabby Windy Quick Commands 命令库。')
    }
    const version = Number(root.version)
    if (version !== 3) {
        throw new Error(`只支持 v3 命令库，当前文件版本为 ${Number.isFinite(version) ? version : '未知'}。`)
    }
    const source = root.commands
    if (!Array.isArray(source)) {
        throw new Error('导入文件缺少 commands 数组。')
    }
    if (source.length > 5000) {
        throw new Error('导入文件包含的命令超过 5000 条。')
    }

    const ids = new Set<string>()
    source.forEach((value, index) => validateImportedCommand(value, index, ids))
    return {
        commands: source as Array<Partial<QuickCommand>>,
        customCategories: parseStringList(root.customCategories, 'customCategories'),
        categoryOrder: parseStringList(root.categoryOrder, 'categoryOrder'),
        version,
    }
}

export function normalizeCommandConfig (
    command: Partial<QuickCommand>,
    createId: () => string,
): QuickCommand {
    return {
        id: command.id || createId(),
        name: command.name || '未命名命令',
        description: command.description || '',
        category: command.category || '常用',
        command: normalizeCommandText(command.command || ''),
        autoEnter: command.autoEnter ?? true,
        lineDelay: Math.max(0, Number(command.lineDelay) || 0),
        lineDelays: Array.isArray(command.lineDelays)
            ? command.lineDelays.map(value => Math.max(0, Number(value) || 0))
            : [],
        linePauses: Array.isArray(command.linePauses)
            ? command.linePauses.map(value => value === true)
            : [],
        shortcut: normalizeShortcut(command.shortcut || ''),
        favorite: command.favorite ?? false,
        pinned: command.pinned ?? false,
        usageCount: Math.max(0, Number(command.usageCount) || 0),
        lastUsedAt: command.lastUsedAt || null,
        automationRules: normalizeAutomationRules(command.automationRules, createId),
    }
}

export function buildImportPreview (
    existing: QuickCommand[],
    imported: QuickCommand[],
    metadata: Pick<ParsedImportPayload, 'customCategories' | 'categoryOrder' | 'version'> = {
        customCategories: [],
        categoryOrder: [],
        version: 3,
    },
): ImportPreview {
    const existingById = new Map(existing.map(command => [command.id, command]))
    const existingByName = new Map(existing.map(command => [command.name.trim().toLowerCase(), command]))
    const existingShortcuts = new Map(existing
        .filter(command => command.shortcut)
        .map(command => [normalizeShortcut(command.shortcut), command]))
    const importedByName = new Map<string, QuickCommand>()
    const importedByShortcut = new Map<string, QuickCommand>()

    const added: QuickCommand[] = []
    const overwritten: QuickCommand[] = []
    const conflicts: ImportConflict[] = []

    imported.forEach(command => {
        const nameKey = command.name.trim().toLowerCase()
        const shortcutKey = command.shortcut ? normalizeShortcut(command.shortcut) : ''
        const internalNameConflict = importedByName.get(nameKey)
        if (internalNameConflict) {
            conflicts.push({ command, reason: `导入文件内名称已被“${internalNameConflict.name}”使用`, scope: 'file' })
            return
        }
        const internalShortcutConflict = shortcutKey ? importedByShortcut.get(shortcutKey) : null
        if (internalShortcutConflict) {
            conflicts.push({ command, reason: `导入文件内快捷键已被“${internalShortcutConflict.name}”使用`, scope: 'file' })
            return
        }
        importedByName.set(nameKey, command)
        if (shortcutKey) {
            importedByShortcut.set(shortcutKey, command)
        }
        if (existingById.has(command.id)) {
            overwritten.push(command)
            return
        }
        const shortcutConflict = shortcutKey ? existingShortcuts.get(shortcutKey) : null
        if (shortcutConflict) {
            conflicts.push({ command, reason: `快捷键已被“${shortcutConflict.name}”使用`, scope: 'existing' })
            return
        }
        const nameConflict = existingByName.get(nameKey)
        if (nameConflict) {
            conflicts.push({ command, reason: `名称已存在于“${nameConflict.category}”分类`, scope: 'existing' })
            return
        }
        added.push(command)
    })

    return {
        commands: imported,
        added,
        overwritten,
        conflicts,
        customCategories: metadata.customCategories,
        categoryOrder: metadata.categoryOrder,
        sourceVersion: metadata.version,
    }
}

export function applyImportPreview (
    existing: QuickCommand[],
    preview: ImportPreview,
    mode: 'merge' | 'replace',
): QuickCommand[] {
    if (mode === 'replace') {
        const fileConflictIds = new Set(preview.conflicts
            .filter(conflict => conflict.scope === 'file')
            .map(conflict => conflict.command.id))
        return preview.commands.filter(command => !fileConflictIds.has(command.id))
    }

    const importsById = new Map(preview.overwritten.map(command => [command.id, command]))
    const conflictIds = new Set(preview.conflicts.map(conflict => conflict.command.id))
    const kept = existing.map(command => importsById.get(command.id) || command)
    const added = preview.added.filter(command => !conflictIds.has(command.id))
    return [...kept, ...added]
}

export function sanitizeAutomationReferences (commands: QuickCommand[]): SanitizedAutomationReferences {
    const commandIds = new Set(commands.map(command => command.id))
    let clearedReferences = 0
    const cleaned = commands.map(command => ({
        ...command,
        automationRules: command.automationRules.map(rule => {
            const clearMissing = (commandId: string): string => {
                if (!commandId || commandIds.has(commandId)) {
                    return commandId
                }
                clearedReferences++
                return ''
            }
            return {
                ...rule,
                onMatchCommandId: clearMissing(rule.onMatchCommandId),
                onErrorCommandId: clearMissing(rule.onErrorCommandId),
                onTimeoutCommandId: clearMissing(rule.onTimeoutCommandId),
            }
        }),
    }))
    return { commands: cleaned, clearedReferences }
}

function validateImportedCommand (value: unknown, index: number, ids: Set<string>): void {
    const position = `第 ${index + 1} 条命令`
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${position}不是有效对象。`)
    }
    const command = value as Record<string, unknown>
    if (typeof command.name !== 'string' || !command.name.trim()) {
        throw new Error(`${position}缺少有效名称。`)
    }
    if (typeof command.command !== 'string') {
        throw new Error(`${position}缺少命令内容字段。`)
    }
    const optionalStringFields = ['description', 'category', 'shortcut', 'lastUsedAt']
    optionalStringFields.forEach(field => {
        if (command[field] !== undefined && command[field] !== null && typeof command[field] !== 'string') {
            throw new Error(`${position}的字段 ${field} 无效。`)
        }
    })
    const optionalBooleanFields = ['autoEnter', 'favorite', 'pinned']
    optionalBooleanFields.forEach(field => {
        if (command[field] !== undefined && typeof command[field] !== 'boolean') {
            throw new Error(`${position}的字段 ${field} 无效。`)
        }
    })
    if (command.lineDelays !== undefined && !Array.isArray(command.lineDelays)) {
        throw new Error(`${position}的逐行延迟格式无效。`)
    }
    if (command.linePauses !== undefined && (
        !Array.isArray(command.linePauses) ||
        command.linePauses.some(value => typeof value !== 'boolean')
    )) {
        throw new Error(`${position}的逐行暂停格式无效。`)
    }
    if (command.id !== undefined) {
        if (typeof command.id !== 'string' || !command.id.trim()) {
            throw new Error(`${position}的 ID 无效。`)
        }
        if (ids.has(command.id)) {
            throw new Error(`导入文件包含重复命令 ID：${command.id}。`)
        }
        ids.add(command.id)
    }
    if (command.automationRules !== undefined && !Array.isArray(command.automationRules)) {
        throw new Error(`${position}的输出触发器格式无效。`)
    }
    if (Array.isArray(command.automationRules)) {
        command.automationRules.forEach((rule, ruleIndex) => {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器格式无效。`)
            }
            const record = rule as Record<string, unknown>
            const stringFields = ['id', 'name', 'waitFor', 'errorPattern', 'onMatchCommand', 'onMatchCommandId', 'onErrorCommand', 'onErrorCommandId', 'onTimeoutCommand', 'onTimeoutCommandId']
            stringFields.forEach(field => {
                if (record[field] !== undefined && typeof record[field] !== 'string') {
                    throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器字段 ${field} 无效。`)
                }
            })
            const booleanFields = ['enabled', 'collapsed', 'onMatchAutoEnter', 'onErrorAutoEnter', 'onTimeoutAutoEnter']
            booleanFields.forEach(field => {
                if (record[field] !== undefined && typeof record[field] !== 'boolean') {
                    throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器字段 ${field} 无效。`)
                }
            })
            if (record.matchMode !== undefined && record.matchMode !== 'literal' && record.matchMode !== 'regex') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器匹配方式无效。`)
            }
            if (record.waitForLogic !== undefined && record.waitForLogic !== 'single' && record.waitForLogic !== 'any' && record.waitForLogic !== 'all') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器成功条件无效。`)
            }
            if (record.errorPatternLogic !== undefined && record.errorPatternLogic !== 'single' && record.errorPatternLogic !== 'any' && record.errorPatternLogic !== 'all') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器错误条件无效。`)
            }
            if (record.onMatchAction !== undefined && record.onMatchAction !== 'none' && record.onMatchAction !== 'custom' && record.onMatchAction !== 'command') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器成功动作无效。`)
            }
            if (record.onErrorAction !== undefined && record.onErrorAction !== 'none' && record.onErrorAction !== 'custom' && record.onErrorAction !== 'command') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器错误动作无效。`)
            }
            if (record.timeoutAction !== undefined && record.timeoutAction !== 'continue' && record.timeoutAction !== 'stop' && record.timeoutAction !== 'custom' && record.timeoutAction !== 'command') {
                throw new Error(`${position}的第 ${ruleIndex + 1} 条输出触发器超时动作无效。`)
            }
        })
    }
}

function parseStringList (value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`命令库缺少 ${field} 数组。`)
    }
    if (value.some(item => typeof item !== 'string')) {
        throw new Error(`命令库字段 ${field} 包含无效值。`)
    }
    return Array.from(new Set((value as string[]).map(item => item.trim()).filter(Boolean)))
}

function normalizeAutomationRules (
    rules: QuickAutomationRule[] | undefined,
    createId: () => string,
): QuickAutomationRule[] {
    if (!Array.isArray(rules)) {
        return []
    }
    return rules.map(rule => {
        const onMatchCommand = normalizeCommandText(rule.onMatchCommand || '')
        const onErrorCommand = normalizeCommandText(rule.onErrorCommand || '')
        const onTimeoutCommand = normalizeCommandText(rule.onTimeoutCommand || '')
        const onMatchCommandId = rule.onMatchCommandId || ''
        const onErrorCommandId = rule.onErrorCommandId || ''
        const onTimeoutCommandId = rule.onTimeoutCommandId || ''
        return {
            id: rule.id || createId(),
            name: rule.name || '输出匹配规则',
            enabled: rule.enabled ?? true,
            collapsed: rule.collapsed ?? false,
            matchMode: rule.matchMode === 'regex' ? 'regex' : 'literal',
            waitFor: rule.waitFor || '',
            waitForLogic: normalizePatternLogic(rule.waitForLogic),
            timeoutMs: Math.max(100, Number(rule.timeoutMs) || 10000),
            errorPattern: rule.errorPattern || '',
            errorPatternLogic: normalizePatternLogic(rule.errorPatternLogic),
            onMatchAction: normalizeCommandAction(rule.onMatchAction, onMatchCommandId, onMatchCommand),
            onMatchCommand,
            onMatchAutoEnter: rule.onMatchAutoEnter ?? true,
            onMatchCommandId,
            onErrorAction: normalizeCommandAction(rule.onErrorAction, onErrorCommandId, onErrorCommand),
            onErrorCommand,
            onErrorAutoEnter: rule.onErrorAutoEnter ?? true,
            onErrorCommandId,
            onTimeoutCommand,
            onTimeoutAutoEnter: rule.onTimeoutAutoEnter ?? true,
            onTimeoutCommandId,
            timeoutAction: normalizeTimeoutAction(rule.timeoutAction, onTimeoutCommandId, onTimeoutCommand),
        }
    })
}

function normalizePatternLogic (logic: unknown): 'single' | 'any' | 'all' {
    return logic === 'any' || logic === 'all' ? logic : 'single'
}

function normalizeCommandAction (action: unknown, commandId: string, command: string): 'none' | 'custom' | 'command' {
    if (action === 'custom' || action === 'command' || action === 'none') {
        return action
    }
    if (commandId) {
        return 'command'
    }
    if (command) {
        return 'custom'
    }
    return 'none'
}

function normalizeTimeoutAction (action: unknown, commandId: string, command: string): 'continue' | 'stop' | 'custom' | 'command' {
    if (action === 'stop' || action === 'custom' || action === 'command') {
        return action
    }
    if (commandId) {
        return 'command'
    }
    if (command) {
        return 'custom'
    }
    return 'continue'
}
