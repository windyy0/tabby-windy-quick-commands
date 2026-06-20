import { OutputMatchMode } from './types'

export interface OutputMatch {
    matched: boolean
    text: string
}

export function normalizeTerminalOutput (output: string): string {
    const withoutOsc = output.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    const withoutAnsi = withoutOsc.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    const normalized: string[] = []

    for (const character of withoutAnsi) {
        if (character === '\b') {
            normalized.pop()
        } else if (character === '\r') {
            normalized.push('\n')
        } else if (character !== '\x00') {
            normalized.push(character)
        }
    }

    return normalized.join('')
}

export function findOutputMatch (
    output: string,
    pattern: string,
    mode: OutputMatchMode,
): OutputMatch {
    if (!pattern) {
        return { matched: false, text: '' }
    }

    const normalized = normalizeTerminalOutput(output)
    if (mode === 'regex') {
        try {
            const match = normalized.match(new RegExp(pattern, 'i'))
            return { matched: Boolean(match), text: match?.[0] || '' }
        } catch {
            return { matched: false, text: '' }
        }
    }

    const index = normalized.toLowerCase().indexOf(pattern.toLowerCase())
    return index < 0
        ? { matched: false, text: '' }
        : { matched: true, text: normalized.slice(index, index + pattern.length) }
}

export function isValidOutputPattern (pattern: string, mode: OutputMatchMode): boolean {
    if (!pattern || mode === 'literal') {
        return true
    }
    try {
        new RegExp(pattern, 'i')
        return true
    } catch {
        return false
    }
}
