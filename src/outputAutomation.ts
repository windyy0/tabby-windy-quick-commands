import { OutputMatchMode, OutputPatternLogic } from './types'

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
    logic: OutputPatternLogic = 'single',
): OutputMatch {
    const patterns = splitOutputPatterns(pattern, logic)
    if (!patterns.length) {
        return { matched: false, text: '' }
    }

    const normalized = normalizeTerminalOutput(output)
    const matches = patterns.map(item => findSingleOutputMatch(normalized, item, mode))
    if (logic === 'all') {
        const matched = matches.every(match => match.matched)
        return {
            matched,
            text: matched ? matches.map(match => match.text).filter(Boolean).join(' / ') : '',
        }
    }
    return matches.find(match => match.matched) || { matched: false, text: '' }
}

function findSingleOutputMatch (
    normalized: string,
    pattern: string,
    mode: OutputMatchMode,
): OutputMatch {
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

export function isValidOutputPattern (
    pattern: string,
    mode: OutputMatchMode,
    logic: OutputPatternLogic = 'single',
): boolean {
    if (!pattern || mode === 'literal') {
        return true
    }
    return splitOutputPatterns(pattern, logic).every(item => {
        try {
            new RegExp(item, 'i')
            return true
        } catch {
            return false
        }
    })
}

function splitOutputPatterns (pattern: string, logic: OutputPatternLogic): string[] {
    if (logic === 'single') {
        return pattern ? [pattern] : []
    }
    return pattern
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean)
}
