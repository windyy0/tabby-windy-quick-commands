import { isValidShortcut, normalizeShortcut, reservedTabbyShortcuts } from './shortcutManager'
import { pluginIdentity } from './pluginIdentity'

export type PluginHotkeyAction = 'toggleDrawer' | 'openSettings' | 'switchFocus' | 'toggleHints'
export type PluginHotkeyBinding = string | string[]

export interface PluginHotkeyExport {
    version: 1
    actions: Record<PluginHotkeyAction, PluginHotkeyBinding[]>
}

export interface PluginHotkeyDefinition {
    action: PluginHotkeyAction
    id: string
    title: string
    description: string
    scope: string
    defaults: PluginHotkeyBinding[]
}

export const reservedQuickCommandsShortcuts: Array<{ shortcut: string, name: string }> = [
    { shortcut: 'Ctrl+Enter', name: '执行当前选中命令' },
    { shortcut: 'Alt+Left', name: '切换到上一个分类' },
    { shortcut: 'Alt+Right', name: '切换到下一个分类' },
]

export const pluginHotkeyDefinitions: PluginHotkeyDefinition[] = [
    {
        action: 'toggleDrawer',
        id: pluginIdentity.toggleHotkeyId,
        title: '显示/隐藏快速命令',
        description: '在 Tabby 前台显示或收起快速命令抽屉。',
        scope: 'Tabby全局',
        defaults: [],
    },
    {
        action: 'openSettings',
        id: pluginIdentity.settingsHotkeyId,
        title: '打开快速命令设置',
        description: '直接打开“快速命令”设置标签页。',
        scope: 'Tabby全局',
        defaults: [],
    },
    {
        action: 'switchFocus',
        id: pluginIdentity.focusHotkeyId,
        title: '切换抽屉/终端焦点',
        description: '在抽屉打开时切换搜索框与活动终端焦点。',
        scope: '仅抽屉打开时',
        defaults: ['Escape'],
    },
    {
        action: 'toggleHints',
        id: pluginIdentity.hintsHotkeyId,
        title: '显示/隐藏快捷键提示',
        description: '在抽屉打开时显示或隐藏左侧快捷键提示。',
        scope: '仅抽屉打开时',
        defaults: ['Ctrl+Alt+H'],
    },
]

export function getPluginHotkeyDefinition (action: PluginHotkeyAction): PluginHotkeyDefinition {
    return pluginHotkeyDefinitions.find(item => item.action === action)!
}

export function readPluginHotkeyBindings (
    hotkeys: Record<string, unknown> | null | undefined,
    action: PluginHotkeyAction,
): PluginHotkeyBinding[] {
    const definition = getPluginHotkeyDefinition(action)
    const configured = readTabbyHotkeyBindings(hotkeys, definition.id)
    if (configured === null) {
        return cloneBindings(definition.defaults)
    }
    return configured
}

export function buildPluginHotkeyExport (hotkeys: Record<string, unknown> | null | undefined): PluginHotkeyExport {
    return {
        version: 1,
        actions: {
            toggleDrawer: readPluginHotkeyBindings(hotkeys, 'toggleDrawer'),
            openSettings: readPluginHotkeyBindings(hotkeys, 'openSettings'),
            switchFocus: readPluginHotkeyBindings(hotkeys, 'switchFocus'),
            toggleHints: readPluginHotkeyBindings(hotkeys, 'toggleHints'),
        },
    }
}

export function buildDefaultPluginHotkeyExport (): PluginHotkeyExport {
    return {
        version: 1,
        actions: {
            toggleDrawer: cloneBindings(getPluginHotkeyDefinition('toggleDrawer').defaults),
            openSettings: cloneBindings(getPluginHotkeyDefinition('openSettings').defaults),
            switchFocus: cloneBindings(getPluginHotkeyDefinition('switchFocus').defaults),
            toggleHints: cloneBindings(getPluginHotkeyDefinition('toggleHints').defaults),
        },
    }
}

export function parsePluginHotkeyExport (value: unknown): PluginHotkeyExport {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('插件快捷键配置无效。')
    }
    const record = value as Record<string, unknown>
    if (record.version !== 1 || !record.actions || typeof record.actions !== 'object' || Array.isArray(record.actions)) {
        throw new Error('插件快捷键配置版本无效。')
    }
    const actions = record.actions as Record<string, unknown>
    const normalized = {} as Record<PluginHotkeyAction, PluginHotkeyBinding[]>
    pluginHotkeyDefinitions.forEach(definition => {
        const bindings = actions[definition.action]
        if (bindings === undefined && definition.action === 'toggleHints') {
            normalized[definition.action] = cloneBindings(definition.defaults)
            return
        }
        if (!Array.isArray(bindings)) {
            throw new Error(`插件快捷键 ${definition.action} 无效。`)
        }
        normalized[definition.action] = normalizeBindings(bindings, true)
        const allowPlainEscape = definition.action === 'switchFocus'
        const invalid = normalized[definition.action].some(binding => (
            (Array.isArray(binding) ? binding : [binding])
                .some(stroke => !isValidShortcut(stroke, allowPlainEscape))
        ))
        if (invalid) {
            throw new Error(`插件快捷键 ${definition.action} 无效。`)
        }
    })
    return { version: 1, actions: normalized }
}

export function applyPluginHotkeyExport (
    hotkeys: Record<string, unknown>,
    value: PluginHotkeyExport,
): void {
    pluginHotkeyDefinitions.forEach(definition => {
        writeTabbyHotkeyBindings(hotkeys, definition.id, value.actions[definition.action])
    })
}

export function hasTabbyHotkeyConfiguration (
    hotkeys: Record<string, unknown> | null | undefined,
    id: string,
): boolean {
    if (!hotkeys) { return false }
    const tokens = id.split('.')
    let current: unknown = hotkeys
    for (const token of tokens) {
        if (!current || typeof current !== 'object' || Array.isArray(current) ||
            !Object.prototype.hasOwnProperty.call(current, token)) {
            return false
        }
        current = (current as Record<string, unknown>)[token]
    }
    return true
}

export function readTabbyHotkeyBindings (
    hotkeys: Record<string, unknown> | null | undefined,
    id: string,
): PluginHotkeyBinding[] | null {
    if (!hasTabbyHotkeyConfiguration(hotkeys, id)) { return null }
    let current: unknown = hotkeys
    for (const token of id.split('.')) {
        current = (current as Record<string, unknown>)[token]
    }
    if (typeof current === 'string') {
        return normalizeBindings([current])
    }
    return Array.isArray(current) ? normalizeBindings(current) : null
}

export function writeTabbyHotkeyBindings (
    hotkeys: Record<string, unknown>,
    id: string,
    bindings: PluginHotkeyBinding[],
): void {
    const tokens = id.split('.')
    let current = hotkeys
    tokens.slice(0, -1).forEach(token => {
        const value = current[token]
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            current[token] = {}
        }
        current = current[token] as Record<string, unknown>
    })
    current[tokens[tokens.length - 1]] = bindings.map(binding => pluginHotkeyBindingToTabby(binding))
}

export function migrateLegacySettingsHotkey (
    hotkeys: Record<string, unknown>,
    standardId: string,
    legacyId: string,
): boolean {
    const legacyBindings = readTabbyHotkeyBindings(hotkeys, legacyId)
    if (!legacyBindings?.length) { return false }
    const standardBindings = readTabbyHotkeyBindings(hotkeys, standardId)
    if (!standardBindings?.length) {
        writeTabbyHotkeyBindings(hotkeys, standardId, legacyBindings)
    }
    writeTabbyHotkeyBindings(hotkeys, legacyId, [])
    return true
}

export function pluginHotkeyBindingToTabby (
    binding: PluginHotkeyBinding,
    platform: string = process.platform,
): PluginHotkeyBinding {
    const serializeStroke = (stroke: string): string => normalizeShortcut(stroke)
        .split('+')
        .map(part => {
            if (part === 'Minus') { return '-' }
            if (part === 'Meta') {
                return platform === 'darwin' ? '⌘' : platform === 'win32' ? 'Win' : 'Super'
            }
            if (part === 'Alt' && platform === 'darwin') { return '⌥' }
            return part
        })
        .join('-')
    return Array.isArray(binding) ? binding.map(serializeStroke) : serializeStroke(binding)
}

export function formatPluginHotkeyBinding (binding: PluginHotkeyBinding): string {
    return Array.isArray(binding) ? binding.join(' → ') : binding
}

export function pluginHotkeyBindingId (binding: PluginHotkeyBinding): string {
    return (Array.isArray(binding) ? binding : [binding])
        .map(stroke => normalizeShortcut(stroke))
        .filter(Boolean)
        .join('$#!')
}

export function findPluginHotkeyConflict (
    hotkeys: Record<string, unknown> | null | undefined,
    commands: Array<{ name?: string, shortcut?: string }>,
    action: PluginHotkeyAction,
    binding: PluginHotkeyBinding,
): string {
    const identifier = pluginHotkeyBindingId(binding)
    if (!identifier) {
        return ''
    }
    const ownDefinition = getPluginHotkeyDefinition(action)
    for (const definition of pluginHotkeyDefinitions) {
        const matches = readPluginHotkeyBindings(hotkeys, definition.action)
            .filter(item => pluginHotkeyBindingId(item) === identifier).length
        if ((definition.id !== ownDefinition.id && matches) || (definition.id === ownDefinition.id && matches > 1)) {
            return `与插件操作“${definition.title}”冲突`
        }
    }
    if (!identifier.includes('$#!')) {
        const drawerShortcut = reservedQuickCommandsShortcuts.find(item => (
            normalizeShortcut(item.shortcut) === identifier
        ))
        if (drawerShortcut) {
            return `与抽屉操作“${drawerShortcut.name}”冲突`
        }
        const command = commands.find(item => item.shortcut && normalizeShortcut(item.shortcut) === identifier)
        if (command) {
            return `与命令“${command.name || '未命名命令'}”冲突`
        }
        const reserved = reservedTabbyShortcuts.find(item => normalizeShortcut(item.shortcut) === identifier)
        if (reserved) {
            return `与 Tabby 操作“${reserved.name}”冲突`
        }
    }
    const pluginIds = new Set(pluginHotkeyDefinitions.map(item => item.id))
    for (const item of flattenConfiguredHotkeys(hotkeys)) {
        if (!pluginIds.has(item.id) && pluginHotkeyBindingId(item.binding) === identifier) {
            return `与 Tabby 快捷键“${item.id}”冲突`
        }
    }
    return ''
}

function flattenConfiguredHotkeys (
    hotkeys: Record<string, unknown> | null | undefined,
    path = '',
): Array<{ id: string, binding: PluginHotkeyBinding }> {
    if (!hotkeys || typeof hotkeys !== 'object') {
        return []
    }
    const result: Array<{ id: string, binding: PluginHotkeyBinding }> = []
    Object.entries(hotkeys).forEach(([key, value]) => {
        if (key === '__nonStructural') { return }
        const id = path ? `${path}.${key}` : key
        if (typeof value === 'string') {
            normalizeBindings([value]).forEach(binding => result.push({ id, binding }))
        } else if (Array.isArray(value)) {
            normalizeBindings(value).forEach(binding => result.push({ id, binding }))
        } else if (value && typeof value === 'object') {
            result.push(...flattenConfiguredHotkeys(value as Record<string, unknown>, id))
        }
    })
    return result
}

function normalizeBindings (values: unknown[], strict = false): PluginHotkeyBinding[] {
    const result: PluginHotkeyBinding[] = []
    values.forEach(value => {
        if (typeof value === 'string') {
            const normalized = normalizeShortcut(value)
            if (normalized) {
                result.push(normalized)
            } else if (strict) {
                throw new Error('插件快捷键绑定无效。')
            }
            return
        }
        if (Array.isArray(value) && value.every(stroke => typeof stroke === 'string')) {
            const normalized = value.map(stroke => normalizeShortcut(stroke))
            if (strict && (!normalized.length || normalized.some(stroke => !stroke))) {
                throw new Error('插件快捷键绑定无效。')
            }
            const valid = normalized.filter(Boolean)
            if (valid.length) { result.push(valid.length === 1 ? valid[0] : valid) }
            return
        }
        if (strict) {
            throw new Error('插件快捷键绑定无效。')
        }
    })
    return result
}

function cloneBindings (bindings: PluginHotkeyBinding[]): PluginHotkeyBinding[] {
    return bindings.map(binding => Array.isArray(binding) ? [...binding] : binding)
}
