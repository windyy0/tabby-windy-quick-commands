import { buildTerminalPayload, normalizeCommandText } from './commandLibrary'
import { findOutputMatch, isValidOutputPattern, resolveAutomationRuleControl } from './outputAutomation'
import { OutputStreamLike, RecentOutputBufferRegistry } from './recentOutputBuffer'
import { AutomationLogEntry, QuickAutomationRule, QuickCommand } from './types'

export interface ExecutionTarget {
    title?: string
    profile?: {
        name?: string
    }
    frontend?: {
        focus: () => void
    }
    sendInput: (data: string) => void
    output$?: OutputStreamLike
    session?: {
        output$?: OutputStreamLike
    } | null
}

export interface AutomationRunnerCallbacks {
    getTargetKey: (target: ExecutionTarget) => string
    getTargetName: (target: ExecutionTarget) => string
    getCommand: (commandId: string) => QuickCommand | undefined
    isDangerous: (command: string) => boolean
    isStopped: () => boolean
    waitingRuleChanged: (ruleName?: string) => void
    log: (
        level: AutomationLogEntry['level'],
        message: string,
        commandId?: string,
        line?: number,
        context?: Pick<AutomationLogEntry, 'mode' | 'targetNames' | 'durationMs'>,
    ) => void
}

interface AutomationRuleResult {
    outcome: 'match' | 'error' | 'timeout' | 'stopped'
    matchedText: string
}

export class QuickCommandsAutomationRunner {
    private outputBuffers = new RecentOutputBufferRegistry()

    constructor (private callbacks: AutomationRunnerCallbacks) {}

    attach (targets: ExecutionTarget[], outputLimit: number): void {
        this.outputBuffers.detach()
        targets.forEach(target => {
            const stream = target.output$ || target.session?.output$
            if (stream) {
                this.outputBuffers.attach(this.callbacks.getTargetKey(target), stream, outputLimit)
            }
        })
    }

    detach (): void {
        this.outputBuffers.detach()
    }

    captureCursors (targets: ExecutionTarget[]): Map<string, number> {
        const cursors = new Map<string, number>()
        targets.forEach(target => {
            const key = this.callbacks.getTargetKey(target)
            const cursor = this.outputBuffers.captureCursor(key)
            if (cursor !== undefined) {
                cursors.set(key, cursor)
            }
        })
        return cursors
    }

    async run (
        command: QuickCommand,
        targets: ExecutionTarget[],
        candidateRules: QuickAutomationRule[],
        initialCursors?: Map<string, number>,
    ): Promise<boolean> {
        const rules = candidateRules.filter(rule => rule.enabled && (rule.waitFor || rule.errorPattern))
        if (!rules.length || this.callbacks.isStopped()) {
            return false
        }
        const availableTargets = targets.filter(target => {
            const available = this.outputBuffers.has(this.callbacks.getTargetKey(target))
            if (!available) {
                this.callbacks.log('warn', '当前会话不支持输出监听，已跳过输出触发器。', command.id, undefined, {
                    targetNames: [this.callbacks.getTargetName(target)],
                })
            }
            return available
        })
        const results = await Promise.all(availableTargets.map(target => this.runForTarget(
            command,
            rules,
            target,
            initialCursors?.get(this.callbacks.getTargetKey(target)),
        )))
        this.callbacks.waitingRuleChanged()
        return results.some(Boolean)
    }

    private async runForTarget (
        command: QuickCommand,
        rules: QuickAutomationRule[],
        target: ExecutionTarget,
        initialCursor?: number,
    ): Promise<boolean> {
        const key = this.callbacks.getTargetKey(target)
        let cursor = initialCursor ?? this.outputBuffers.getStartOffset(key) ?? 0

        for (const rule of rules) {
            if (this.callbacks.isStopped()) {
                return false
            }
            if (!isValidOutputPattern(rule.waitFor, rule.matchMode, rule.waitForLogic) ||
                !isValidOutputPattern(rule.errorPattern, rule.matchMode, rule.errorPatternLogic)) {
                this.callbacks.log('warn', `规则正则表达式无效，已跳过：${rule.name}`, command.id, undefined, {
                    targetNames: [this.callbacks.getTargetName(target)],
                })
                continue
            }

            const result = await this.waitForRule(rule, target, cursor, command.id)
            cursor = this.outputBuffers.getEndOffset(key) ?? cursor
            if (result.outcome === 'stopped') {
                return false
            }

            const control = this.executeRuleAction(rule, result.outcome, target, command.id)
            if (control === 'skipLineRules') {
                this.callbacks.log('info', `会话已在匹配后跳过该行剩余规则：${rule.name}`, command.id, undefined, {
                    targetNames: [this.callbacks.getTargetName(target)],
                })
                return false
            }
            if (control === 'stop') {
                const reason = result.outcome === 'timeout' ? '超时' : '匹配'
                this.callbacks.log('warn', `会话自动化已在${reason}后停止：${rule.name}`, command.id, undefined, {
                    targetNames: [this.callbacks.getTargetName(target)],
                })
                return true
            }
        }
        return false
    }

    private async waitForRule (
        rule: QuickAutomationRule,
        target: ExecutionTarget,
        cursor: number,
        commandId: string,
    ): Promise<AutomationRuleResult> {
        const timeout = Math.max(100, Number(rule.timeoutMs) || 10000)
        const started = Date.now()
        const targetName = this.callbacks.getTargetName(target)
        this.callbacks.waitingRuleChanged(rule.name)
        this.callbacks.log('info', `等待输出触发器：${rule.name}`, commandId, undefined, {
            targetNames: [targetName],
        })
        while (Date.now() - started < timeout) {
            if (this.callbacks.isStopped()) {
                return { outcome: 'stopped', matchedText: '' }
            }
            const output = this.outputBuffers.getSince(this.callbacks.getTargetKey(target), cursor)
            const errorMatch = findOutputMatch(output, rule.errorPattern, rule.matchMode, rule.errorPatternLogic)
            if (errorMatch.matched) {
                this.addRuleMatchLog('warn', '命中错误输出', rule, errorMatch.text, commandId, targetName)
                return { outcome: 'error', matchedText: errorMatch.text }
            }
            const successMatch = findOutputMatch(output, rule.waitFor, rule.matchMode, rule.waitForLogic)
            if (successMatch.matched) {
                this.addRuleMatchLog('info', '命中成功输出', rule, successMatch.text, commandId, targetName)
                return { outcome: 'match', matchedText: successMatch.text }
            }
            await this.delay(150)
        }
        this.callbacks.log('warn', `输出触发器超时：${rule.name}（${timeout}ms）`, commandId, undefined, {
            targetNames: [targetName],
        })
        return { outcome: 'timeout', matchedText: '' }
    }

    private addRuleMatchLog (
        level: AutomationLogEntry['level'],
        result: string,
        rule: QuickAutomationRule,
        matchedText: string,
        commandId: string,
        targetName: string,
    ): void {
        const snippet = matchedText.replace(/\s+/g, ' ').trim().slice(0, 120)
        const suffix = snippet ? `：${snippet}` : ''
        this.callbacks.log(level, `${result}：${rule.name}${suffix}`, commandId, undefined, {
            targetNames: [targetName],
        })
    }

    private executeRuleAction (
        rule: QuickAutomationRule,
        outcome: AutomationRuleResult['outcome'],
        target: ExecutionTarget,
        parentCommandId: string,
    ): 'continue' | 'skipLineRules' | 'stop' {
        const control = resolveAutomationRuleControl(rule, outcome)
        if (outcome === 'stopped') {
            return control
        }
        const action = outcome === 'match'
            ? rule.onMatchAction
            : outcome === 'error'
                ? rule.onErrorAction
                : rule.timeoutAction
        if (action !== 'stop') {
            this.executeCommandAction(rule, outcome, target, parentCommandId)
        }
        return control
    }

    private executeCommandAction (
        rule: QuickAutomationRule,
        outcome: Exclude<AutomationRuleResult['outcome'], 'stopped'>,
        target: ExecutionTarget,
        parentCommandId: string,
    ): void {
        const action = outcome === 'match'
            ? rule.onMatchAction
            : outcome === 'error'
                ? rule.onErrorAction
                : rule.timeoutAction
        if (action === 'command') {
            const commandId = outcome === 'match'
                ? rule.onMatchCommandId
                : outcome === 'error'
                    ? rule.onErrorCommandId
                    : rule.onTimeoutCommandId
            this.executeExistingCommand(commandId, target, parentCommandId)
        } else if (action === 'custom') {
            const command = outcome === 'match'
                ? rule.onMatchCommand
                : outcome === 'error'
                    ? rule.onErrorCommand
                    : rule.onTimeoutCommand
            const autoEnter = outcome === 'match'
                ? rule.onMatchAutoEnter
                : outcome === 'error'
                    ? rule.onErrorAutoEnter
                    : rule.onTimeoutAutoEnter
            this.executeCustomCommand(command, autoEnter, target, parentCommandId, rule.name)
        }
    }

    private executeExistingCommand (
        commandId: string,
        target: ExecutionTarget,
        parentCommandId: string,
    ): void {
        if (!commandId) {
            return
        }
        const command = this.callbacks.getCommand(commandId)
        if (!command) {
            this.callbacks.log('warn', `自动化目标命令不存在：${commandId}`, parentCommandId)
            return
        }
        if (this.callbacks.isDangerous(command.command)) {
            this.callbacks.log('warn', `自动化跳过高风险命令：${command.name}`, parentCommandId)
            return
        }
        target.sendInput(buildTerminalPayload(command.command, command.autoEnter))
        this.callbacks.log('info', `自动化已执行：${command.name}`, parentCommandId, undefined, {
            targetNames: [this.callbacks.getTargetName(target)],
        })
    }

    private executeCustomCommand (
        command: string,
        autoEnter: boolean,
        target: ExecutionTarget,
        parentCommandId: string,
        ruleName: string,
    ): void {
        const normalized = normalizeCommandText(command)
        if (!normalized.trim()) {
            return
        }
        if (this.callbacks.isDangerous(normalized)) {
            this.callbacks.log('warn', `自动化跳过高风险自定义命令：${ruleName}`, parentCommandId, undefined, {
                targetNames: [this.callbacks.getTargetName(target)],
            })
            return
        }
        target.sendInput(buildTerminalPayload(normalized, autoEnter))
        this.callbacks.log('info', `自动化已发送自定义命令：${ruleName}`, parentCommandId, undefined, {
            targetNames: [this.callbacks.getTargetName(target)],
        })
    }

    private delay (ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
    }
}
