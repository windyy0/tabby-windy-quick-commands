export interface ShortcutConflict {
    kind: 'command' | 'tabby'
    name: string
}

export const reservedTabbyShortcuts: Array<{ shortcut: string, name: string }> = [
    { shortcut: 'Ctrl+Shift+P', name: 'Tabby 命令面板' },
    { shortcut: 'Ctrl+Shift+E', name: 'Tabby 配置选择器' },
    { shortcut: 'Ctrl+Shift+W', name: '关闭标签页' },
    { shortcut: 'Ctrl+Shift+Z', name: '重新打开标签页' },
    { shortcut: 'Ctrl+Tab', name: '下一个标签页' },
    { shortcut: 'Ctrl+Shift+Tab', name: '上一个标签页' },
    { shortcut: 'Ctrl+Shift+Right', name: '下一个标签页' },
    { shortcut: 'Ctrl+Shift+Left', name: '上一个标签页' },
    { shortcut: 'Ctrl+Shift+S', name: '向右分屏' },
    { shortcut: 'Ctrl+Shift+D', name: '向下分屏' },
    { shortcut: 'Ctrl+Alt+T', name: '切换配置' },
    { shortcut: 'Ctrl+Alt+Enter', name: '最大化面板' },
    { shortcut: 'F11', name: '全屏' },
    { shortcut: 'Alt+1', name: '切换到标签 1' },
    { shortcut: 'Alt+2', name: '切换到标签 2' },
    { shortcut: 'Alt+3', name: '切换到标签 3' },
    { shortcut: 'Alt+4', name: '切换到标签 4' },
    { shortcut: 'Alt+5', name: '切换到标签 5' },
    { shortcut: 'Alt+6', name: '切换到标签 6' },
    { shortcut: 'Alt+7', name: '切换到标签 7' },
    { shortcut: 'Alt+8', name: '切换到标签 8' },
    { shortcut: 'Alt+9', name: '切换到标签 9' },
    { shortcut: 'Alt+0', name: '切换到标签 10' },
]

export function shortcutFromKeyboardEvent (event: KeyboardEvent): string {
    const key = normalizeShortcutEventKey(event)
    if (!key) {
        return ''
    }

    const functionKey = /^F\d{1,2}$/.test(key)
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !functionKey) {
        return ''
    }

    const parts: string[] = []
    if (event.ctrlKey) {
        parts.push('Ctrl')
    }
    if (event.altKey) {
        parts.push('Alt')
    }
    if (event.shiftKey) {
        parts.push('Shift')
    }
    if (event.metaKey) {
        parts.push('Meta')
    }

    parts.push(key)
    return normalizeShortcut(parts.join('+'))
}

export function isValidShortcut (shortcut: string, allowPlainEscape = false): boolean {
    const normalized = normalizeShortcut(shortcut)
    if (!normalized) {
        return false
    }

    const parts = normalized.split('+').filter(Boolean)
    if (new Set(parts).size !== parts.length) {
        return false
    }
    const modifiers = new Set(['Ctrl', 'Alt', 'Shift', 'Meta'])
    const primaryKeys = parts.filter(part => !modifiers.has(part))
    if (primaryKeys.length !== 1) {
        return false
    }

    const primaryKey = primaryKeys[0]
    const functionKey = /^F([1-9]|1\d|2[0-4])$/.test(primaryKey)
    if (/^F\d+$/i.test(primaryKey) && !functionKey) {
        return false
    }
    if (functionKey) {
        return true
    }
    if (allowPlainEscape && primaryKey === 'Escape' && parts.length === 1) {
        return true
    }
    return parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Meta')
}

export function normalizeShortcutKey (key: string): string {
    if (!key || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
        return ''
    }
    if (key === ' ') {
        return 'Space'
    }
    const mapped = normalizeSpecialKey(key)
    if (mapped) {
        return mapped
    }
    if (key.length === 1) {
        return key.toUpperCase()
    }
    return key
}

export function normalizeShortcut (shortcut: string): string {
    let source = shortcut.trim()
    // Tabby serializes the Minus key as the final dash in values such as
    // "Ctrl--". Preserve it before converting dash-separated modifiers.
    if (source === '-') {
        source = 'Minus'
    } else {
        source = source.replace(/\+-(?=$)/, '+Minus').replace(/--(?=$)/, '-Minus')
    }
    return source
        .replace(/[－–—-]/g, '+')
        .split('+')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const lower = part.toLowerCase()
            if (lower === 'ctrl' || lower === 'control' || lower === '^') {
                return 'Ctrl'
            }
            if (lower === 'alt' || lower === 'option' || lower === '⌥') {
                return 'Alt'
            }
            if (lower === 'shift' || lower === '⇧') {
                return 'Shift'
            }
            if (
                lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === '⌘' ||
                lower === 'win' || lower === 'windows' || lower === 'super'
            ) {
                return 'Meta'
            }
            if (lower === 'esc') {
                return 'Escape'
            }
            const mapped = normalizeSpecialKey(part)
            if (mapped) {
                return mapped
            }
            if (part.length === 1) {
                return part.toUpperCase()
            }
            return part[0]?.toUpperCase() + part.slice(1)
        })
        .join('+')
}

function normalizeSpecialKey (key: string): string {
    const lower = key.toLowerCase()
    const aliases: Record<string, string> = {
        arrowup: 'Up',
        up: 'Up',
        arrowdown: 'Down',
        down: 'Down',
        arrowleft: 'Left',
        left: 'Left',
        arrowright: 'Right',
        right: 'Right',
        escape: 'Escape',
        esc: 'Escape',
        delete: 'Delete',
        del: 'Delete',
        backspace: 'Backspace',
        enter: 'Enter',
        return: 'Enter',
        tab: 'Tab',
        pageup: 'PageUp',
        pagedown: 'PageDown',
        home: 'Home',
        end: 'End',
        insert: 'Insert',
        ins: 'Insert',
        space: 'Space',
        '-': 'Minus',
        _: 'Minus',
        minus: 'Minus',
        hyphen: 'Minus',
        '+': '=',
        plus: '=',
        equal: '=',
        equals: '=',
    }
    return aliases[lower] || ''
}

function normalizeShortcutEventKey (event: KeyboardEvent): string {
    const codeAliases: Record<string, string> = {
        Comma: ',',
        Period: '.',
        Slash: '/',
        Backslash: '\\',
        IntlBackslash: '`',
        Minus: 'Minus',
        Equal: '=',
        Semicolon: ';',
        Quote: "'",
        BracketLeft: '[',
        BracketRight: ']',
    }
    if (event.code && codeAliases[event.code]) {
        return codeAliases[event.code]
    }
    if (event.code?.startsWith('Numpad')) {
        return event.code
    }
    return normalizeShortcutKey(event.key)
}

export function flattenHotkeysConfig (hotkeys: unknown, path = ''): Array<{ shortcut: string, name: string }> {
    if (!hotkeys || typeof hotkeys !== 'object') {
        return []
    }

    const result: Array<{ shortcut: string, name: string }> = []
    Object.entries(hotkeys as Record<string, unknown>).forEach(([key, value]) => {
        if (key === '__nonStructural') {
            return
        }
        const name = path ? `${path}.${key}` : key
        if (typeof value === 'string') {
            const shortcut = normalizeShortcut(value)
            if (shortcut) {
                result.push({ shortcut, name })
            }
            return
        }
        if (Array.isArray(value)) {
            value
                .filter((item): item is string => typeof item === 'string')
                .map(item => normalizeShortcut(item))
                .filter(Boolean)
                .forEach(shortcut => result.push({ shortcut, name }))
            return
        }
        result.push(...flattenHotkeysConfig(value, name))
    })
    return result
}

export function findShortcutConflict (
    shortcut: string,
    commandShortcuts: Array<{ id: string, name: string, shortcut: string }>,
    currentCommandId: string,
    tabbyHotkeys: Array<{ shortcut: string, name: string }> = [],
): ShortcutConflict | null {
    const normalized = normalizeShortcut(shortcut)
    if (!normalized) {
        return null
    }

    const command = commandShortcuts.find(item => (
        item.id !== currentCommandId &&
        item.shortcut &&
        normalizeShortcut(item.shortcut) === normalized
    ))
    if (command) {
        return { kind: 'command', name: command.name }
    }

    const builtin = [...reservedTabbyShortcuts, ...tabbyHotkeys]
        .find(item => normalizeShortcut(item.shortcut) === normalized)
    if (builtin) {
        return { kind: 'tabby', name: builtin.name }
    }

    return null
}
