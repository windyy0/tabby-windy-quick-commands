import { buildTerminalPayload } from './commandLibrary'
import { ExecutionTarget, QuickCommandsAutomationRunner } from './automationRunner'
import { parseScriptSteps, ScriptStep } from './scriptParser'
import {
    AutomationLogEntry,
    ExecutionMode,
    FailureStrategy,
    QuickCommand,
} from './types'

export { ExecutionTarget } from './automationRunner'

export interface ExecutionRunState {
    commandId: string
    startedAt: string
    currentStep: number
    totalSteps: number
    sourceLine: number
    paused: boolean
    stopped: boolean
    waitingManual: boolean
    waitingRuleName?: string
    manualResolver?: () => void
}

export interface ExecutionRunnerCallbacks {
    getTargetKey: (target: ExecutionTarget) => string
    getTargetName: (target: ExecutionTarget) => string
    getCommand: (commandId: string) => QuickCommand | undefined
    isDangerous: (command: string) => boolean
    log: (
        level: AutomationLogEntry['level'],
        message: string,
        commandId?: string,
        line?: number,
        context?: Pick<AutomationLogEntry, 'mode' | 'targetNames' | 'durationMs'>,
    ) => void
    warn: (message: string, error: unknown) => void
    stateChanged: (state: ExecutionRunState, pendingFailureMessage: string) => void
}

export class QuickCommandsExecutionRunner {
    private state?: ExecutionRunState
    private pendingFailureMessage = ''
    private automationRunner: QuickCommandsAutomationRunner

    constructor (private callbacks: ExecutionRunnerCallbacks) {
        this.automationRunner = new QuickCommandsAutomationRunner({
            ...callbacks,
            isStopped: () => this.state?.stopped === true,
            waitingRuleChanged: ruleName => {
                if (this.state) {
                    this.state.waitingRuleName = ruleName
                    this.notifyStateChanged()
                }
            },
        })
    }

    start (command: QuickCommand, mode: ExecutionMode): ExecutionRunState {
        if (this.state) {
            throw new Error('A quick command is already running.')
        }
        this.pendingFailureMessage = ''
        this.state = {
            commandId: command.id,
            startedAt: new Date().toISOString(),
            currentStep: 0,
            totalSteps: mode === 'line' ? Math.max(parseScriptSteps(command).length, 1) : 1,
            sourceLine: 0,
            paused: false,
            stopped: false,
            waitingManual: false,
        }
        return this.state
    }

    async execute (
        command: QuickCommand,
        targets: ExecutionTarget[],
        mode: ExecutionMode,
        failureStrategy: FailureStrategy,
        outputLimit: number,
    ): Promise<boolean> {
        if (!this.state) {
            throw new Error('Quick command execution has not been started.')
        }
        this.automationRunner.attach(targets, outputLimit)
        try {
            if (mode === 'line') {
                await this.executeLineByLine(command, targets, failureStrategy)
            } else {
                this.executeBlock(command, targets)
            }
            const afterCommandRules = command.automationRules.filter(rule => rule.triggerLine === 0)
            await this.automationRunner.run(command, targets, afterCommandRules)
            return this.state?.stopped === true
        } finally {
            this.automationRunner.detach()
        }
    }

    pause (): void {
        if (!this.state) {
            return
        }
        this.state.paused = true
        this.notifyStateChanged()
    }

    resume (): void {
        if (!this.state) {
            return
        }
        if (this.state.waitingManual) {
            this.resolveManualFailure(false)
            return
        }
        this.state.paused = false
        this.pendingFailureMessage = ''
        this.notifyStateChanged()
    }

    stop (): void {
        if (!this.state) {
            return
        }
        this.state.stopped = true
        this.state.paused = false
        this.state.waitingManual = false
        const resolver = this.state.manualResolver
        this.state.manualResolver = undefined
        this.pendingFailureMessage = ''
        resolver?.()
        this.notifyStateChanged()
    }

    resolveManualFailure (stop: boolean): void {
        if (!this.state) {
            return
        }
        this.state.stopped = stop
        this.state.paused = false
        this.state.waitingManual = false
        const resolver = this.state.manualResolver
        this.state.manualResolver = undefined
        this.pendingFailureMessage = ''
        resolver?.()
        this.notifyStateChanged()
    }

    getDuration (): number | undefined {
        if (!this.state?.startedAt) {
            return undefined
        }
        const startedAt = new Date(this.state.startedAt).getTime()
        return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined
    }

    dispose (): void {
        this.automationRunner.detach()
        const resolver = this.state?.manualResolver
        if (this.state) {
            this.state.manualResolver = undefined
        }
        resolver?.()
        this.state = undefined
        this.pendingFailureMessage = ''
    }

    private executeBlock (command: QuickCommand, targets: ExecutionTarget[]): void {
        const payload = buildTerminalPayload(command.command, command.autoEnter)
        targets.forEach(target => target.sendInput(payload))
    }

    private async executeLineByLine (
        command: QuickCommand,
        targets: ExecutionTarget[],
        failureStrategy: FailureStrategy,
    ): Promise<void> {
        const steps = parseScriptSteps(command)
        if (this.state) {
            this.state.totalSteps = Math.max(steps.length, 1)
        }

        for (let index = 0; index < steps.length; index++) {
            const step = steps[index]
            if (this.state?.stopped) {
                this.callbacks.log('warn', '执行已停止。', command.id)
                return
            }
            await this.waitWhilePaused()
            if (this.state) {
                this.state.currentStep = index + 1
                this.state.sourceLine = step.sourceLine
                this.notifyStateChanged()
            }
            await this.executeStep(command, targets, step, failureStrategy)
        }
    }

    private async executeStep (
        command: QuickCommand,
        targets: ExecutionTarget[],
        step: ScriptStep,
        failureStrategy: FailureStrategy,
    ): Promise<void> {
        if (step.type !== 'command') {
            return
        }

        try {
            const rules = command.automationRules.filter(rule => rule.triggerLine === step.sourceLine)
            const outputCursors = this.automationRunner.captureCursors(targets)
            const payload = buildTerminalPayload(step.text, command.autoEnter)
            targets.forEach(target => target.sendInput(payload))
            this.callbacks.log('info', `已发送第 ${step.sourceLine} 行。`, command.id, step.sourceLine)
            const [, stoppedByRule] = await Promise.all([
                this.delayWithControl(step.delay),
                this.automationRunner.run(command, targets, rules, outputCursors),
            ])
            if (stoppedByRule && this.state) {
                this.state.stopped = true
                this.callbacks.log('warn', `第 ${step.sourceLine} 行的输出规则已停止后续逐行执行。`, command.id, step.sourceLine)
            }
            if (step.pauseAfter && !this.state?.stopped) {
                this.pause()
                this.callbacks.log('info', `第 ${step.sourceLine} 行执行后暂停，等待继续。`, command.id, step.sourceLine)
                await this.waitWhilePaused()
            }
        } catch (error) {
            await this.handleStepFailure(command, step, error, failureStrategy)
        }
    }

    private async handleStepFailure (
        command: QuickCommand,
        step: ScriptStep,
        error: unknown,
        failureStrategy: FailureStrategy,
    ): Promise<void> {
        this.callbacks.warn('Line execution failed', error)
        this.callbacks.log('error', `第 ${step.sourceLine} 行发送失败。`, command.id, step.sourceLine)
        if (failureStrategy === 'continue') {
            return
        }
        if (failureStrategy === 'stop') {
            throw error
        }

        this.pendingFailureMessage = `第 ${step.sourceLine} 行发送失败，需要手动确认后继续。`
        if (this.state) {
            this.state.waitingManual = true
            this.state.paused = true
            this.notifyStateChanged()
        }
        await new Promise<void>(resolve => {
            if (this.state) {
                this.state.manualResolver = resolve
            } else {
                resolve()
            }
        })
        if (this.state?.stopped) {
            throw error
        }
    }

    private async waitWhilePaused (): Promise<void> {
        while (this.state?.paused && !this.state.stopped) {
            await this.delay(120)
        }
    }

    private async delayWithControl (ms: number): Promise<void> {
        const started = Date.now()
        while (Date.now() - started < ms) {
            if (this.state?.stopped) {
                return
            }
            await this.waitWhilePaused()
            await this.delay(Math.min(120, ms - (Date.now() - started)))
        }
    }

    private notifyStateChanged (): void {
        if (this.state) {
            this.callbacks.stateChanged(this.state, this.pendingFailureMessage)
        }
    }

    private delay (ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
    }
}
