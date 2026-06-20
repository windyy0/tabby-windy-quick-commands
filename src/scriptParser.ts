import { QuickCommand } from './types'

export type ScriptStepType = 'command' | 'comment'

export interface ScriptStep {
    type: ScriptStepType
    sourceLine: number
    text: string
    delay: number
    pauseAfter: boolean
}

export function parseScriptSteps (command: QuickCommand): ScriptStep[] {
    return command.command
        .split(/\r?\n/)
        .map((rawLine, index) => parseLine(
            rawLine,
            index + 1,
            getLineDelay(command, index),
            command.linePauses?.[index] === true,
        ))
        .filter(step => step.type !== 'comment' || step.text.length > 0)
}

export function getExecutableLineCount (command: QuickCommand): number {
    return parseScriptSteps(command)
        .filter(step => step.type === 'command')
        .length
}

function parseLine (rawLine: string, sourceLine: number, delay: number, pauseAfter: boolean): ScriptStep {
    const text = rawLine.trim()
    if (!text || text.startsWith('#')) {
        return {
            type: 'comment',
            sourceLine,
            text,
            delay: 0,
            pauseAfter: false,
        }
    }
    return {
        type: 'command',
        sourceLine,
        text: rawLine,
        delay,
        pauseAfter,
    }
}

function getLineDelay (command: QuickCommand, lineIndex: number): number {
    const lineDelay = command.lineDelays?.[lineIndex]
    if (typeof lineDelay === 'number' && Number.isFinite(lineDelay)) {
        return Math.max(0, lineDelay)
    }
    return Math.max(0, Number(command.lineDelay) || 0)
}
