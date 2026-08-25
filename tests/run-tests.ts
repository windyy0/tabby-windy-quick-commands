import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
    applyImportPreview,
    buildTerminalPayload,
    buildImportPreview,
    normalizeCommandConfig,
    parseImportPayload,
    resolveSelectedCommand,
    sanitizeAutomationReferences,
} from '../src/commandLibrary'
import {
    findShortcutConflict,
    normalizeShortcut,
    normalizeShortcutKey,
    shortcutFromKeyboardEvent,
} from '../src/shortcutManager'
import { getDangerCheck } from '../src/safety'
import { getExecutableLineCount, parseScriptSteps } from '../src/scriptParser'
import { QuickCommandsRuntimeStore } from '../src/runtimeStorage'
import { shouldShowToolbarButton } from '../src/toolbarVisibility'
import { QuickCommandsPluginConfigStore } from '../src/pluginConfigStorage'
import { migrateLegacyPluginConfig, readLegacyPluginConfig, removeLegacyPluginConfig } from '../src/legacyConfigMigration'
import {
    findOutputMatch,
    isValidOutputPattern,
    normalizeTerminalOutput,
    resolveAutomationRuleControl,
} from '../src/outputAutomation'
import { getPluginLanguage, translatePluginText } from '../src/translations'
import { RecentOutputBufferRegistry } from '../src/recentOutputBuffer'
import { ExecutionTarget, QuickCommandsExecutionRunner } from '../src/executionRunner'
import {
    comparePluginVersions,
    formatPluginUpdateNotes,
    getNextPluginUpdateCheckDelay,
    isNewerPluginVersion,
} from '../src/pluginUpdate'
import { shouldHandleDelegatedAction } from '../src/delegatedClick'

let id = 0
const createId = (): string => `test-${++id}`

function assert (condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message)
    }
}

function command (patch: Record<string, unknown>) {
    return normalizeCommandConfig({
        id: String(patch.id || createId()),
        name: String(patch.name || '命令'),
        command: String(patch.command || 'echo ok'),
        shortcut: String(patch.shortcut || ''),
        category: String(patch.category || '常用'),
        lineDelay: Number(patch.lineDelay || 0),
        lineDelays: Array.isArray(patch.lineDelays) ? patch.lineDelays as number[] : undefined,
        linePauses: Array.isArray(patch.linePauses) ? patch.linePauses as boolean[] : undefined,
    }, createId)
}

function testImportPreview (): void {
    const existing = [
        command({ id: 'a', name: '构建', shortcut: 'Ctrl+Alt+B' }),
        command({ id: 'b', name: '状态', shortcut: 'Ctrl+Alt+S' }),
    ]
    const imported = [
        command({ id: 'a', name: '构建覆盖', shortcut: 'Ctrl+Alt+B' }),
        command({ id: 'c', name: '新增', shortcut: 'Ctrl+Alt+N' }),
        command({ id: 'd', name: '冲突', shortcut: 'Ctrl+Alt+S' }),
        command({ id: 'e', name: '新增', shortcut: 'Ctrl+Alt+E' }),
        command({ id: 'f', name: '内部快捷键冲突', shortcut: 'Ctrl+Alt+N' }),
    ]
    const preview = buildImportPreview(existing, imported)
    assert(preview.overwritten.length === 1, 'import preview should count overwritten commands')
    assert(preview.added.length === 1, 'import preview should count added commands')
    assert(preview.conflicts.length === 3, 'import preview should count existing and internal conflicts')

    const merged = applyImportPreview(existing, preview, 'merge')
    assert(merged.length === 3, 'merge should keep existing, overwrite by id, and add non-conflicts')
    assert(merged.some(item => item.name === '构建覆盖'), 'merge should overwrite matching ids')
    assert(!merged.some(item => item.name === '冲突'), 'merge should skip conflicts')

    assert(preview.conflicts.filter(conflict => conflict.scope === 'file').length === 2, 'preview should distinguish file conflicts')
    assert(preview.conflicts.filter(conflict => conflict.scope === 'existing').length === 1, 'preview should distinguish existing conflicts')

    const replaced = applyImportPreview(existing, preview, 'replace')
    assert(replaced.length === 3, 'replace should ignore existing conflicts but skip internal file conflicts')
    assert(replaced.some(item => item.name === '冲突'), 'replace should retain commands that only conflict with the old library')
}

function testTranslations (): void {
    assert(getPluginLanguage('zh-CN') === 'zh-CN', 'Simplified Chinese should use Chinese UI')
    assert(getPluginLanguage('zh-TW') === 'zh-CN', 'all Chinese locales should use Chinese UI')
    assert(getPluginLanguage('en-US') === 'en', 'English should use English UI')
    assert(getPluginLanguage('ja-JP') === 'en', 'unsupported locales should fall back to English')
    assert(translatePluginText('快速命令', 'zh-CN') === '快速命令', 'Chinese UI text should remain unchanged')
    assert(translatePluginText('显示/隐藏快速命令', 'en-US') === 'Show/hide Quick Commands', 'hotkey name should be translated')
    assert(translatePluginText('第 2 / 5 页', 'de-DE') === 'Page 2 / 5', 'dynamic page labels should be translated')
    assert(translatePluginText('2 条命令，3 条运行日志', 'en-US') === '2 commands, 3 runtime logs', 'dynamic counters should be translated as a complete sentence')
    assert(translatePluginText('确认永久删除选中的 3 条命令？运行日志将保留。', 'en-US') === 'Permanently delete the selected 3 commands? Runtime logs will be kept.', 'dynamic confirmations should be fully translated')
    assert(translatePluginText('执行后继续', 'en-US') === 'Continue', 'line setting continue label should fit its button')
    assert(translatePluginText('执行后暂停', 'en-US') === 'Pause', 'line setting pause label should fit its button')
    assert(translatePluginText('全部折叠', 'en-US') === 'Collapse all', 'bulk collapse action should be translated')
    assert(translatePluginText('全部', 'en-US') === 'All', 'all category should be translated')
    assert(translatePluginText('常用', 'en-US') === 'Frequent', 'frequent category should be translated')
    assert(translatePluginText('收藏', 'en-US') === 'Favorite', 'favorite category should be translated')
    assert(translatePluginText('第 2 行执行后：npm test', 'en-US') === 'After source line 2: npm test', 'line trigger labels should be translated')
    assert(translatePluginText('匹配后流程', 'en-US') === 'After-match flow', 'post-match flow label should be translated')
    assert(translatePluginText('全部行匹配', 'en-US') === 'Match all patterns', 'output pattern logic should be translated')
    assert(translatePluginText('输入要发送到终端的命令', 'en-US') === 'Enter the command to send to the terminal', 'custom automation command placeholder should be translated')
    assert(translatePluginText('确认删除该输出触发器规则？此操作不可撤销。', 'en-US') === 'Delete this output trigger rule? This action cannot be undone.', 'output trigger deletion should be translated')
    assert(translatePluginText('命令 1的第 2 条输出触发器错误动作无效。', 'en-US') === 'Command 1 output trigger 2 has an invalid error action.', 'output trigger validation errors should be translated')
    assert(translatePluginText('将“部署”移动到指定分类。', 'en-US') === 'Move "部署" to the selected category.', 'move dialog should translate dynamic command names')
    assert(translatePluginText('将选中的 3 条命令移动到', 'en-US') === 'Move the selected 3 commands to', 'batch move prompt should be translated')
    assert(translatePluginText('检查更新', 'en-US') === 'Check for updates', 'update controls should be translated')
    assert(translatePluginText('点击跳转到底部更新设置', 'en-US') === 'Click to jump to update settings at the bottom', 'update status jump tooltip should be translated')
    assert(translatePluginText('返回顶部', 'en-US') === 'Back to top', 'back-to-top update action should be translated')
    assert(translatePluginText('检查中…', 'en-US') === 'Checking…', 'update checking status should be translated')
    assert(translatePluginText('发现新版本 v1.5.2', 'en-US') === 'New version available v1.5.2', 'available update status should include the version in English')
    assert(translatePluginText('此版本未提供更新说明。', 'en-US') === 'No release notes were provided for this version.', 'missing historical notes should be translated')
    assert(translatePluginText('检查失败：请求失败（HTTP 503）。', 'en-US') === 'Update check failed: Request failed (HTTP 503).', 'update request errors should be translated')
}

function testUserContentLocalizationBoundary (): void {
    const drawerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'quickCommands.service.ts'), 'utf8')
    const settingsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'quickCommandsSettingsTab.component.ts'), 'utf8')
    const i18nSource = fs.readFileSync(path.join(process.cwd(), 'src', 'i18n.ts'), 'utf8')
    assert(drawerSource.includes('class="tqc-command-name" data-i18n-skip'), 'drawer command names should opt out of UI translation')
    assert(settingsSource.includes('<strong data-i18n-skip>{{ command.name }}</strong>'), 'settings command names should opt out of UI translation')
    assert(i18nSource.includes('if (this.isAttributeLocalizationSkipped(element))'), 'translation should skip attributes explicitly marked as user content')
    assert(i18nSource.includes("closest('[data-i18n-skip]')"), 'textarea placeholders should remain translatable while explicitly skipped attributes remain protected')
}

function testPluginVersionComparison (): void {
    assert(isNewerPluginVersion('1.6.0', '1.5.2'), 'minor updates should be detected')
    assert(!isNewerPluginVersion('1.5.2', '1.5.2'), 'equal versions should not be updates')
    assert(comparePluginVersions('2.0.0', '1.99.99') > 0, 'major versions should use numeric comparison')
    assert(comparePluginVersions('1.6.0-beta.2', '1.6.0-beta.1') > 0, 'prerelease identifiers should be compared')
    assert(comparePluginVersions('1.6.0', '1.6.0-beta.2') > 0, 'stable versions should sort after prereleases')
    const hour = 60 * 60 * 1000
    const now = new Date('2026-08-25T00:00:00Z').getTime()
    assert(getNextPluginUpdateCheckDelay('never', null, 0, now) === null, 'disabled checks should not schedule a timer')
    assert(getNextPluginUpdateCheckDelay('daily', null, 0, now) === 0, 'a first automatic check should run immediately')
    assert(
        getNextPluginUpdateCheckDelay('daily', '2026-08-20T00:00:00Z', now - hour, now) === 23 * hour,
        'a recent failed attempt should prevent rapid retries when the successful cache is stale',
    )
}

function testDelegatedDialogClicks (): void {
    assert(
        shouldHandleDelegatedAction('category-confirm', false, true),
        'dialog action buttons should reach the delegated click handler',
    )
    assert(
        shouldHandleDelegatedAction('category-cancel', true, true),
        'clicking the dialog backdrop itself should close the dialog',
    )
    assert(
        !shouldHandleDelegatedAction('category-cancel', true, false),
        'clicking dialog content should not trigger the backdrop action',
    )
}

function testPluginUpdateNotes (): void {
    const formatted = formatPluginUpdateNotes({
        'zh-CN': {
            title: '版本更新',
            sections: [
                { title: '新增', items: ['功能一', '功能二'] },
                { title: '空分组', items: [] },
            ],
            notice: '需要重启。',
        },
        en: {
            title: 'Version update',
            sections: [{ title: 'Added', items: ['Feature one'] }],
            notice: 'Restart required.',
        },
    }, 'zh-CN')
    assert(formatted.includes('版本更新'), 'update notes should include the title')
    assert(formatted.includes('新增\n• 功能一\n• 功能二'), 'update notes should format section items')
    assert(!formatted.includes('空分组'), 'update notes should omit empty sections')
    assert(formatted.includes('注意事项：需要重启。'), 'update notes should include the notice')
    const english = formatPluginUpdateNotes({
        'zh-CN': { title: '中文版', sections: [{ title: '新增', items: ['功能'] }] },
        en: { title: 'English notes', sections: [{ title: 'Added', items: ['Feature'] }], notice: 'Restart required.' },
    }, 'en')
    assert(english.includes('English notes'), 'English UI should select English update notes')
    assert(!english.includes('中文版'), 'English UI should not include Chinese update notes')
    assert(english.includes('Note: Restart required.'), 'English update notes should use an English notice label')
    const fallback = formatPluginUpdateNotes({
        'zh-CN': { title: '仅中文', sections: [{ title: '新增', items: ['功能'] }] },
    }, 'en')
    assert(fallback.includes('仅中文'), 'missing locales should fall back to the available update notes')
    assert(formatPluginUpdateNotes({
        title: '旧格式',
        sections: [{ title: '修复', items: ['问题'] }],
    }).includes('旧格式'), 'legacy single-language update notes should remain supported')
    assert(formatPluginUpdateNotes(null) === '', 'invalid update notes should be ignored')
}

function testImportValidation (): void {
    const parsed = parseImportPayload(JSON.stringify({
        format: 'tabby-windy-quick-commands',
        version: 3,
        customCategories: ['空分类', '空分类'],
        categoryOrder: ['开发', '空分类'],
        commands: [{ id: 'one', name: '测试', command: 'echo ok' }],
    }))
    assert(parsed.version === 3, 'import parser should preserve supported versions')
    assert(parsed.customCategories.length === 1, 'import parser should normalize category metadata')

    let legacyRejected = false
    try {
        parseImportPayload(JSON.stringify([
            { id: 'legacy', name: '旧格式', command: 'echo legacy' },
        ]))
    } catch {
        legacyRejected = true
    }
    assert(legacyRejected, 'import parser should reject legacy array payloads')

    let duplicateRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 3,
            customCategories: [],
            categoryOrder: [],
            commands: [
                { id: 'same', name: '一', command: 'echo one' },
                { id: 'same', name: '二', command: 'echo two' },
            ],
        }))
    } catch {
        duplicateRejected = true
    }
    assert(duplicateRejected, 'import parser should reject duplicate command ids')

    let futureRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 99,
            customCategories: [],
            categoryOrder: [],
            commands: [],
        }))
    } catch {
        futureRejected = true
    }
    assert(futureRejected, 'import parser should reject unsupported future versions')

    let invalidFieldRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 3,
            customCategories: [],
            categoryOrder: [],
            commands: [{
                name: '错误字段',
                command: 'echo ok',
                shortcut: 42,
            }],
        }))
    } catch {
        invalidFieldRejected = true
    }
    assert(invalidFieldRejected, 'import parser should reject invalid command field types')

    let invalidTriggerLineRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 3,
            customCategories: [],
            categoryOrder: [],
            commands: [{
                name: '错误触发行',
                command: 'echo ok',
                automationRules: [{ triggerLine: -1 }],
            }],
        }))
    } catch {
        invalidTriggerLineRejected = true
    }
    assert(invalidTriggerLineRejected, 'import parser should reject invalid automation trigger lines')

    const legacyTimeoutImport = parseImportPayload(JSON.stringify({
        format: 'tabby-windy-quick-commands',
        version: 3,
        customCategories: [],
        categoryOrder: [],
        commands: [{
            name: '旧版超时规则',
            command: 'echo ok',
            automationRules: [{ timeoutMs: 0 }],
        }],
    }))
    const migratedLegacyTimeout = normalizeCommandConfig(legacyTimeoutImport.commands[0], createId)
    assert(migratedLegacyTimeout.automationRules[0].timeoutMs === 10000, 'import parser should accept and migrate legacy zero timeouts')

    let negativeTimeoutRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 3,
            customCategories: [],
            categoryOrder: [],
            commands: [{
                name: '负数超时规则',
                command: 'echo ok',
                automationRules: [{ timeoutMs: -1 }],
            }],
        }))
    } catch {
        negativeTimeoutRejected = true
    }
    assert(negativeTimeoutRejected, 'import parser should still reject negative automation timeouts')

    const withMissingReference = normalizeCommandConfig({
        id: 'reference-source',
        name: '引用测试',
        command: 'echo ok',
        automationRules: [{
            id: 'rule',
            name: '规则',
            enabled: true,
            collapsed: false,
            triggerLine: 0,
            matchMode: 'literal',
            waitFor: 'ok',
            waitForLogic: 'single',
            timeoutMs: 1000,
            errorPattern: '',
            errorPatternLogic: 'single',
            matchFlow: 'continue',
            onMatchAction: 'command',
            onMatchCommand: '',
            onMatchAutoEnter: true,
            onMatchCommandId: 'missing-command',
            onErrorAction: 'none',
            onErrorCommand: '',
            onErrorAutoEnter: true,
            onErrorCommandId: '',
            onTimeoutCommand: '',
            onTimeoutAutoEnter: true,
            onTimeoutCommandId: '',
            timeoutAction: 'continue',
        }],
    }, createId)
    const sanitized = sanitizeAutomationReferences([withMissingReference])
    assert(sanitized.clearedReferences === 1, 'import should count missing automation references')
    assert(sanitized.commands[0].automationRules[0].onMatchCommandId === '', 'import should clear missing automation references')
}

function testShortcuts (): void {
    assert(normalizeShortcut('ctrl-shift-p') === 'Ctrl+Shift+P', 'shortcut normalization should accept hyphen separators')
    assert(normalizeShortcut('ctrl+arrowright') === 'Ctrl+Right', 'shortcut normalization should normalize arrow aliases')
    assert(normalizeShortcutKey('ArrowLeft') === 'Left', 'keyboard event keys should normalize arrow names')
    assert(shortcutFromKeyboardEvent({ key: 'k', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false } as KeyboardEvent) === 'Ctrl+Shift+K', 'keyboard events should produce executable shortcut strings')
    assert(shortcutFromKeyboardEvent({ key: 'K', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false } as KeyboardEvent) === '', 'shift-only letter shortcuts should be rejected to avoid typing conflicts')
    assert(shortcutFromKeyboardEvent({ key: 'F8', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent) === 'F8', 'function keys should work without modifiers')
    const commandConflict = findShortcutConflict(
        'Ctrl+Alt+K',
        [{ id: 'a', name: '已有命令', shortcut: 'Ctrl+Alt+K' }],
        'b',
    )
    assert(commandConflict?.kind === 'command', 'shortcut conflict should detect other commands')

    const tabbyConflict = findShortcutConflict('Ctrl+Shift+P', [], 'a')
    assert(tabbyConflict?.kind === 'tabby', 'shortcut conflict should detect reserved Tabby shortcuts')
}

function testDangerChecks (): void {
    const danger = getDangerCheck('rm -rf /tmp/demo')
    assert(danger.dangerous, 'rm -rf should be dangerous')
    assert(danger.requiresTypedConfirm, 'high risk commands should require typed confirmation')

    assert(getDangerCheck('rm -fr /tmp/demo').dangerous, 'combined rm flags should work in any order')
    assert(getDangerCheck('rm -r -f /tmp/demo').dangerous, 'separate recursive and force flags should be detected')
    assert(getDangerCheck('Remove-Item C:\\temp\\demo -Recurse -Force').dangerous, 'PowerShell recursive deletion should be detected')
    assert(getDangerCheck('dd if=/dev/zero of="/dev/sda" bs=1M').dangerous, 'quoted block-device writes should be detected')
    assert(getDangerCheck('dd if=/dev/zero of="\\\\.\\PhysicalDrive0"').dangerous, 'quoted Windows physical-drive writes should be detected')
    assert(getDangerCheck('git clean -f').dangerous, 'forced git clean should be detected without directory or ignored-file flags')
    assert(getDangerCheck('git clean --force').dangerous, 'long forced git clean options should be detected')
    assert(getDangerCheck('git -C "/tmp/demo repo" clean -f').dangerous, 'git clean should be detected after a global working-directory option')
    assert(getDangerCheck('git --work-tree=/tmp/demo clean --force').dangerous, 'git clean should be detected after long global options')
    assert(getDangerCheck('git clean -fdx').dangerous, 'destructive git clean should be detected')
    assert(getDangerCheck('git clean -fX').dangerous, 'forced ignored-file cleanup should be detected')
    assert(getDangerCheck('git clean -fd -- ./-notes').dangerous, 'git clean path names should not be mistaken for dry-run flags')
    assert(getDangerCheck('git clean --force --directories -- ./--dry-run').dangerous, 'git clean long-option path names should not disable detection')
    assert(getDangerCheck('git clean -fd -e -notes').dangerous, 'git clean exclude patterns should not be mistaken for dry-run flags')
    assert(getDangerCheck('git clean -fd -e -n').dangerous, 'git clean short exclude arguments should not be mistaken for dry-run options')
    assert(getDangerCheck('git clean -fd --exclude -n').dangerous, 'git clean long exclude arguments should not be mistaken for dry-run options')
    assert(getDangerCheck('git reset --hard HEAD~1').dangerous, 'hard git reset should be detected')
    assert(getDangerCheck('terraform destroy -auto-approve').dangerous, 'terraform destroy should be detected')
    assert(getDangerCheck('DROP TABLE users').dangerous, 'destructive database object removal should be detected')
    assert(getDangerCheck('docker volume prune').dangerous, 'docker resource pruning should be detected')
    assert(getDangerCheck('dd if=/dev/zero of=/dev/disk/by-uuid/1234').dangerous, 'disk UUID aliases should be detected')
    assert(getDangerCheck('dd if=/dev/zero of=/dev/disk/by-label/data').dangerous, 'disk label aliases should be detected')
    assert(getDangerCheck('dd if=/dev/zero of=/dev/vg0/root').dangerous, 'LVM volume paths should be detected')
    assert(getDangerCheck('dd if=/dev/zero of=/dev/root').dangerous, 'root block-device aliases should be detected')
    assert(getDangerCheck('busybox dd if=/dev/zero of=/dev/sda').dangerous, 'multicall dd wrappers should be detected')

    assert(!getDangerCheck('rm /tmp/demo.txt').dangerous, 'ordinary single-file removal should not require high-risk confirmation')
    assert(!getDangerCheck('dd if=/tmp/demo.img of=/dev/null').dangerous, 'writes to harmless pseudo-devices should not be marked dangerous')
    assert(!getDangerCheck('dd if=/tmp/demo.img of=/dev/stdout').dangerous, 'writes to standard streams should not be marked dangerous')
    assert(!getDangerCheck('dd if=/tmp/demo.img of=/dev/pts/1').dangerous, 'writes to terminal pseudo-devices should not be marked as disk writes')
    assert(!getDangerCheck('dd if=/tmp/demo.img of=/dev/sda_backup').dangerous, 'block-device names should require a complete path token match')
    assert(!getDangerCheck('git clean -ndx').dangerous, 'git clean dry runs should not be marked dangerous')
    assert(!getDangerCheck('git clean -nfdx').dangerous, 'combined git clean dry-run flags should not be marked dangerous')
    assert(!getDangerCheck('git clean --dry-run --force --directories').dangerous, 'long git clean dry-run flags should not be marked dangerous')
    assert(!getDangerCheck('echo git -C /tmp/demo clean -f').dangerous, 'git text passed to unrelated commands should not be treated as executable git')
    assert(!getDangerCheck('echo deploy').dangerous, 'ordinary commands should not be marked dangerous')
}

function testScriptParser (): void {
    const parsed = command({
        command: 'echo one\n# wait 1000\n# pause\n# comment\necho two',
        lineDelay: 250,
        lineDelays: [100],
        linePauses: [true],
    })
    const steps = parseScriptSteps(parsed)
    assert(steps.length === 5, 'script parser should keep source lines as command or comment steps')
    assert(steps[0].type === 'command' && steps[0].delay === 100 && steps[0].pauseAfter, 'script parser should apply visual line settings')
    assert(steps[1].type === 'comment' && steps[2].type === 'comment', 'wait and pause comments should no longer be directives')
    assert(steps[4].type === 'command' && steps[4].delay === 250 && !steps[4].pauseAfter, 'script parser should fall back to the default delay')
    assert(getExecutableLineCount(parsed) === 2, 'script parser should count executable lines')
}

function testToolbarButtonVisibility (): void {
    assert(shouldShowToolbarButton({}), 'toolbar button should be visible by default')
    assert(shouldShowToolbarButton({ showToolbarButton: true }), 'toolbar button should be visible when enabled')
    assert(!shouldShowToolbarButton({ showToolbarButton: false }), 'toolbar button should be hidden when disabled')
}

function testAutoEnterNormalization (): void {
    const disabled = normalizeCommandConfig({
        name: '不自动回车',
        command: 'echo pending',
        autoEnter: false,
    }, createId)
    assert(disabled.autoEnter === false, 'autoEnter false should remain disabled after normalization')
    assert(buildTerminalPayload('echo pending\n\n\n', false) === 'echo pending', 'disabled autoEnter should trim trailing blank lines without appending enter')
    assert(buildTerminalPayload('echo pending\n\n\n', true) === 'echo pending\r', 'enabled autoEnter should append exactly one enter')
    assert(buildTerminalPayload('\n\n', true) === '', 'blank commands should not produce enter input')
    assert(buildTerminalPayload('line 1\nline 2\nline 3', false) === 'line 1\rline 2\rline 3', 'multi-line payload should preserve 1-2-3 order using terminal enter separators')
    assert(buildTerminalPayload('line 1\nline 2\nline 3', true) === 'line 1\rline 2\rline 3\r', 'autoEnter should append one final enter after ordered lines')
}

function testVisibleCommandSelection (): void {
    const first = command({ id: 'visible-a', name: '可见命令 A' })
    const second = command({ id: 'visible-b', name: '可见命令 B' })
    assert(resolveSelectedCommand([first, second], 'visible-b')?.id === 'visible-b', 'visible selected command should be preserved')
    assert(resolveSelectedCommand([first, second], 'hidden-command')?.id === 'visible-a', 'hidden selected command should fall back to the first visible command')
    assert(resolveSelectedCommand([], 'hidden-command') === null, 'empty visible command list should have no selection')
}

function testOutputAutomation (): void {
    assert(findOutputMatch('server.ready', '.', 'literal').text === '.', 'literal output matching should not treat dots as regex wildcards')
    assert(findOutputMatch('ready', '^ready$', 'regex').matched, 'regex output matching should support regular expressions')
    assert(findOutputMatch('server started', 'ready\nstarted', 'literal', 'any').text === 'started', 'any-line matching should accept the first matched non-empty line')
    assert(findOutputMatch('login ok\nworkspace loaded', 'login ok\nworkspace loaded', 'literal', 'all').matched, 'all-line matching should require every non-empty line')
    assert(!findOutputMatch('login ok', 'login ok\nworkspace loaded', 'literal', 'all').matched, 'all-line matching should reject partial matches')
    assert(!findOutputMatch('ready', '[', 'regex').matched, 'invalid regex should never fall back to a broad literal match')
    assert(!isValidOutputPattern('[', 'regex'), 'invalid regex should be reported during configuration')
    assert(!isValidOutputPattern('ready\n[', 'regex', 'any'), 'invalid multi-line regex patterns should be reported during configuration')
    assert(normalizeTerminalOutput('\x1b[32mreaX\bdy\x1b[0m') === 'ready', 'terminal output matching should remove ANSI sequences and apply backspaces')

    const normalized = normalizeCommandConfig({
        name: '旧自动化规则',
        command: 'echo ready',
        automationRules: [{
            id: 'legacy-rule',
            name: '等待完成',
            waitFor: 'ready',
            timeoutMs: 0,
            errorPattern: '',
            onMatchCommandId: '',
            onErrorCommandId: '',
        } as any],
    }, createId)
    assert(normalized.automationRules[0].enabled, 'legacy automation rules should remain enabled after migration')
    assert(normalized.automationRules[0].triggerLine === 0, 'legacy automation rules should run after the whole command')
    assert(normalized.automationRules[0].matchMode === 'literal', 'legacy automation rules should migrate to literal matching')
    assert(normalized.automationRules[0].waitForLogic === 'single', 'legacy success matching should remain single-pattern')
    assert(normalized.automationRules[0].timeoutMs === 10000, 'legacy zero timeouts should migrate to the documented default')
    assert(normalized.automationRules[0].onMatchAction === 'none', 'legacy empty action should migrate to no action')
    assert(normalized.automationRules[0].onMatchAutoEnter, 'custom action auto-enter should default to enabled')
    assert(resolveAutomationRuleControl(normalized.automationRules[0], 'match') === 'continue', 'ordinary matches should continue automation')
    assert(resolveAutomationRuleControl(normalized.automationRules[0], 'stopped') === 'stop', 'manual stops should stop automation')

    const lineTriggered = normalizeCommandConfig({
        name: '逐行触发规则',
        command: 'echo one\necho two',
        automationRules: [{ triggerLine: 2 } as any],
    }, createId)
    assert(lineTriggered.automationRules[0].triggerLine === 2, 'line-triggered automation rules should preserve their source line')

    const lineMatchControl = normalizeCommandConfig({
        name: '逐行匹配控制',
        command: 'echo one\necho two',
        automationRules: [{ triggerLine: 2, matchFlow: 'nextLine' } as any],
    }, createId)
    assert(lineMatchControl.automationRules[0].matchFlow === 'nextLine', 'line-triggered rules should preserve skip-to-next-line match flow')
    assert(resolveAutomationRuleControl(lineMatchControl.automationRules[0], 'match') === 'skipLineRules', 'next-line match flow should skip remaining line rules')

    const wholeCommandMatchControl = normalizeCommandConfig({
        name: '整段匹配控制',
        command: 'echo one',
        automationRules: [{ triggerLine: 0, matchFlow: 'nextLine' } as any],
    }, createId)
    assert(wholeCommandMatchControl.automationRules[0].matchFlow === 'continue', 'whole-command rules should discard line-only match flow')

    const stopWholeCommandOnMatch = normalizeCommandConfig({
        name: '整段匹配后停止',
        command: 'echo one',
        automationRules: [{ triggerLine: 0, matchFlow: 'stop' } as any],
    }, createId)
    assert(stopWholeCommandOnMatch.automationRules[0].matchFlow === 'stop', 'whole-command rules should preserve stop-on-match flow')
    assert(resolveAutomationRuleControl(stopWholeCommandOnMatch.automationRules[0], 'match') === 'stop', 'stop match flow should stop execution')

    const stopOnMatch = normalizeCommandConfig({
        name: '匹配后停止',
        command: 'echo one\necho two',
        automationRules: [{ triggerLine: 2, matchFlow: 'stop' } as any],
    }, createId)
    assert(stopOnMatch.automationRules[0].matchFlow === 'stop', 'line-triggered rules should preserve stop-on-match flow')

    const outcomeSpecificStops = normalizeCommandConfig({
        name: '按匹配结果停止',
        command: 'echo one\necho two',
        automationRules: [{
            triggerLine: 1,
            onMatchAction: 'stop',
            onErrorAction: 'stop',
        } as any],
    }, createId)
    assert(outcomeSpecificStops.automationRules[0].onMatchAction === 'stop', 'success actions should preserve outcome-specific stop')
    assert(outcomeSpecificStops.automationRules[0].onErrorAction === 'stop', 'error actions should preserve outcome-specific stop')
    assert(resolveAutomationRuleControl(outcomeSpecificStops.automationRules[0], 'match') === 'stop', 'success stop actions should stop execution')
    assert(resolveAutomationRuleControl(outcomeSpecificStops.automationRules[0], 'error') === 'stop', 'error stop actions should stop execution')

    const timeoutStop = normalizeCommandConfig({
        name: '超时停止',
        command: 'echo one',
        automationRules: [{ timeoutAction: 'stop' } as any],
    }, createId)
    assert(resolveAutomationRuleControl(timeoutStop.automationRules[0], 'timeout') === 'stop', 'timeout stop actions should stop execution')

    const legacyLineErrorFlow = normalizeCommandConfig({
        name: '旧逐行错误流程',
        command: 'echo one\necho two',
        automationRules: [{ triggerLine: 2, onErrorAction: 'nextLine' } as any],
    }, createId)
    assert(legacyLineErrorFlow.automationRules[0].matchFlow === 'nextLine', 'legacy line error flow should migrate to match flow')

    const migratedAction = normalizeCommandConfig({
        name: '旧引用动作',
        command: 'echo ready',
        automationRules: [{
            waitFor: 'ready',
            onMatchCommandId: 'next-command',
            onErrorCommand: 'echo failed',
            onErrorAutoEnter: false,
        } as any],
    }, createId)
    assert(migratedAction.automationRules[0].onMatchAction === 'command', 'legacy command references should migrate to command actions')
    assert(migratedAction.automationRules[0].onErrorAction === 'custom', 'custom action text should migrate to custom actions')
    assert(!migratedAction.automationRules[0].onErrorAutoEnter, 'custom action auto-enter should preserve disabled values')
}

function testRecentOutputBuffer (): void {
    const registry = new RecentOutputBufferRegistry()
    let emit: (data: string) => void = () => undefined
    let unsubscribed = false
    registry.attach('terminal-1', {
        subscribe: handler => {
            emit = handler
            return { unsubscribe: () => { unsubscribed = true } }
        },
    }, 5)

    emit('abc')
    const cursor = registry.captureCursor('terminal-1')
    assert(cursor === 3, 'output buffer should expose the current stream cursor')
    emit('def')
    assert(registry.getSince('terminal-1', 0) === 'bcdef', 'output buffer should retain only the configured recent suffix')
    assert(registry.getSince('terminal-1', cursor || 0) === 'def', 'output buffer should return output emitted after a captured cursor')

    const nextCursor = registry.captureCursor('terminal-1') || 0
    emit('gh')
    assert(registry.getSince('terminal-1', nextCursor) === 'gh', 'output cursor offsets should survive buffer rollover')
    registry.detach()
    assert(unsubscribed, 'detaching output buffers should unsubscribe from terminal output')
    assert(!registry.has('terminal-1'), 'detaching output buffers should clear retained output')
}

function testRuntimeStorage (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windy-quick-commands-'))
    try {
        const store = new QuickCommandsRuntimeStore(path.join(directory, 'config.yaml'))
        store.setLogs([{
            id: 'log-1',
            time: '2026-06-18T00:00:00.000Z',
            level: 'info',
            message: '执行完成',
            commandId: 'command-1',
        }])
        store.setStats({
            'command-1': { usageCount: 3, lastUsedAt: '2026-06-18T00:00:00.000Z' },
        })
        const reloaded = new QuickCommandsRuntimeStore(path.join(directory, 'config.yaml'))
        assert(reloaded.getLogs().length === 1, 'runtime logs should persist in an independent file')
        assert(reloaded.getStats()['command-1']?.usageCount === 3, 'command stats should persist in an independent file')
        assert(store.logsPath !== store.statsPath, 'logs and command stats should use separate files')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

function testPluginConfigStorage (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windy-quick-config-'))
    try {
        const configPath = path.join(directory, 'config.yaml')
        const store = new QuickCommandsPluginConfigStore(configPath)
        const first = { commands: [{ id: 'a', name: 'A', command: 'echo a' }], drawerWidth: 560 }
        const second = {
            commands: [{ id: 'b', name: 'B', command: 'echo b' }],
            drawerWidth: 620,
            moveNavigateAfterMove: true,
            updateCheckInterval: 'weekly',
            ignoredUpdateVersion: '1.6.0',
        }
        store.set(first)
        store.set(second)
        assert(store.configPath !== null && fs.existsSync(store.configPath), 'plugin config should use an independent file')
        assert(store.backupPath !== null && fs.existsSync(store.backupPath), 'plugin config should keep a backup after replacement')
        const reloaded = new QuickCommandsPluginConfigStore(configPath).load({})
        assert(reloaded.drawerWidth === 620, 'plugin config should reload the latest saved value')
        const payload = store.exportPayload(second)
        const imported = store.parseImport(JSON.stringify(payload))
        assert(Array.isArray(imported.commands) && imported.commands.length === 1, 'full config export should be importable')
        assert(imported.moveNavigateAfterMove === true, 'move navigation preference should be importable')
        assert(imported.updateCheckInterval === 'weekly', 'update check interval should be importable')
        assert(imported.ignoredUpdateVersion === '1.6.0', 'ignored update version should be importable')
        const normalized = store.parseImport(JSON.stringify({
            format: 'tabby-windy-quick-commands-config',
            version: 1,
            config: {
                commands: [{
                    id: 'normalized',
                    name: '归一化',
                    command: 'echo ok',
                    automationRules: [{
                        id: 'rule-1',
                        timeoutMs: 0,
                        onMatchCommandId: 'missing-command',
                    }],
                }],
                customCategories: [' 开发 ', '开发'],
                categoryOrder: ['开发'],
                selectedCommandId: 'missing-command',
                executionMode: 'broadcast',
                targetMode: 'current',
                drawerWidth: 9999,
                recentOutputLimit: 999999,
                logLimit: 1,
            },
        }))
        const normalizedCommands = normalized.commands as any[]
        assert(normalizedCommands[0].automationRules[0].onMatchCommandId === '', 'full config import should clear missing automation references')
        assert(normalizedCommands[0].automationRules[0].timeoutMs === 10000, 'full config import should migrate legacy zero timeouts')
        assert((normalized.customCategories as string[]).length === 1, 'full config import should normalize category metadata')
        assert(normalized.selectedCommandId === 'normalized', 'full config import should repair missing command selection')
        assert(normalized.selectedCategory === '全部', 'full config import should repair missing category selection')
        assert(normalized.executionMode === 'paste', 'full config import should migrate legacy broadcast execution mode')
        assert(normalized.targetMode === 'all', 'full config import should migrate legacy broadcast target mode')
        assert(normalized.drawerWidth === 760, 'full config import should clamp drawer width')
        assert(normalized.recentOutputLimit === 50000, 'full config import should clamp output buffer size')
        assert(normalized.logLimit === 20, 'full config import should clamp log count')
        assert(!Object.prototype.hasOwnProperty.call(normalizedCommands[0], 'usageCount'), 'full config import should strip runtime command fields')

        let malformedRuleRejected = false
        try {
            store.parseImport(JSON.stringify({
                format: 'tabby-windy-quick-commands-config',
                version: 1,
                config: {
                    commands: [{
                        name: '错误规则',
                        command: 'echo ok',
                        automationRules: [{ onMatchCommand: {} }],
                    }],
                },
            }))
        } catch {
            malformedRuleRejected = true
        }
        assert(malformedRuleRejected, 'full config import should reject malformed nested automation fields')

        let malformedSettingRejected = false
        try {
            store.parseImport(JSON.stringify({
                format: 'tabby-windy-quick-commands-config',
                version: 1,
                config: {
                    commands: [{ name: '测试', command: 'echo ok' }],
                    showToolbarButton: 'yes',
                },
            }))
        } catch {
            malformedSettingRejected = true
        }
        assert(malformedSettingRejected, 'full config import should reject invalid top-level setting types')
        let rejected = false
        try {
            store.parseImport(JSON.stringify({ format: 'wrong', version: 1, config: second }))
        } catch {
            rejected = true
        }
        assert(rejected, 'plugin config import should reject unrelated JSON files')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

function testLegacyPluginConfigMigration (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windy-legacy-config-'))
    try {
        const configPath = path.join(directory, 'config.yaml')
        fs.writeFileSync(configPath, 'hotkeys: {}\nwindyCommandCenter:\n  drawerWidth: 700\n  commands: []\n', 'utf8')
        const rawLegacy = readLegacyPluginConfig(configPath) as Record<string, unknown>
        assert(rawLegacy.drawerWidth === 700, 'legacy config should be read structurally from Tabby YAML')
        assert(removeLegacyPluginConfig(configPath), 'legacy config node should be removed from Tabby YAML')
        assert(readLegacyPluginConfig(configPath) === undefined, 'removed legacy config should no longer be readable')
        assert(fs.existsSync(`${configPath}.windy-quick-commands.backup`), 'Tabby config should be backed up before cleanup')
        const pluginStore = new QuickCommandsPluginConfigStore(configPath)
        const runtimeStore = new QuickCommandsRuntimeStore(configPath)
        const migrated = migrateLegacyPluginConfig({
            commands: [{
                id: 'legacy-command',
                name: '旧命令',
                command: 'echo legacy',
                usageCount: 4,
                lastUsedAt: '2026-06-19T00:00:00.000Z',
            }],
            automationLogs: [{
                id: 'legacy-log',
                time: '2026-06-19T00:00:00.000Z',
                level: 'info',
                message: '旧日志',
            }],
            drawerWidth: 700,
        }, pluginStore, runtimeStore)
        const config = pluginStore.load({})
        assert(migrated, 'legacy plugin config should be recognized')
        assert(Array.isArray(config.commands) && config.commands.length === 1, 'legacy commands should move to plugin config')
        assert(!(config.commands as any[])[0].usageCount, 'runtime command stats should be removed from plugin config')
        assert(runtimeStore.getStats()['legacy-command']?.usageCount === 4, 'legacy usage stats should move to runtime storage')
        assert(runtimeStore.getLogs().length === 1, 'legacy logs should move to runtime storage')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

async function testExecutionRunner (): Promise<void> {
    const sent: string[] = []
    const logs: string[] = []
    const outputHandlers: Array<(data: string) => void> = []
    const target: ExecutionTarget = {
        title: '测试终端',
        sendInput: data => {
            sent.push(data)
            outputHandlers.forEach(handler => handler('service ready'))
        },
        output$: {
            subscribe: handler => {
                outputHandlers.push(handler)
                return {
                    unsubscribe: () => {
                        const index = outputHandlers.indexOf(handler)
                        if (index >= 0) {
                            outputHandlers.splice(index, 1)
                        }
                    },
                }
            },
        },
    }
    const automatedCommand = normalizeCommandConfig({
        id: 'runner-command',
        name: '运行器测试',
        command: 'echo ready',
        autoEnter: true,
        automationRules: [{
            id: 'runner-rule',
            name: '等待服务',
            enabled: true,
            triggerLine: 0,
            waitFor: 'service ready',
            timeoutMs: 200,
        } as any],
    }, createId)
    let latestState = null as ReturnType<QuickCommandsExecutionRunner['start']> | null
    const runner = new QuickCommandsExecutionRunner({
        getTargetKey: () => 'target-1',
        getTargetName: item => item.title || '终端',
        getCommand: () => undefined,
        isDangerous: () => false,
        log: (_level, message) => logs.push(message),
        warn: (_message, error) => {
            throw error
        },
        stateChanged: state => {
            latestState = state
        },
    })

    latestState = runner.start(automatedCommand, 'paste')
    const stopped = await runner.execute(automatedCommand, [target], 'paste', 'stop', 1000)
    assert(!stopped, 'execution runner should complete a normal command')
    assert(sent.length === 1 && sent[0] === 'echo ready\r', 'execution runner should build the terminal payload')
    assert(logs.some(message => message.includes('命中成功输出')), 'execution runner should match buffered output rules')

    runner.pause()
    assert(latestState?.paused, 'execution runner should expose paused state')
    runner.resume()
    assert(!latestState?.paused, 'execution runner should resume paused state')
    runner.stop()
    assert(latestState?.stopped, 'execution runner should expose stopped state')
    runner.dispose()
    assert(outputHandlers.length === 0, 'execution runner should detach terminal output subscriptions')

    sent.length = 0
    const lineCommand = normalizeCommandConfig({
        id: 'runner-lines',
        name: '逐行运行器测试',
        command: 'echo one\n# comment\necho two',
        autoEnter: true,
        lineDelay: 0,
    }, createId)
    latestState = runner.start(lineCommand, 'line')
    await runner.execute(lineCommand, [target], 'line', 'stop', 1000)
    assert(sent.length === 2, 'execution runner should skip comments and send executable lines')
    assert(sent[0] === 'echo one\r' && sent[1] === 'echo two\r', 'line execution should preserve command order')
    runner.dispose()
}

const colorEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)
const style = (code: string, text: string): string => colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text
const tests: Array<[string, () => void | Promise<void>]> = [
    ['中英文界面', testTranslations],
    ['用户内容本地化边界', testUserContentLocalizationBoundary],
    ['插件版本比较', testPluginVersionComparison],
    ['弹窗委托点击', testDelegatedDialogClicks],
    ['插件更新说明', testPluginUpdateNotes],
    ['命令导入预览', testImportPreview],
    ['导入数据校验', testImportValidation],
    ['快捷键处理', testShortcuts],
    ['危险命令检查', testDangerChecks],
    ['逐行脚本解析', testScriptParser],
    ['工具栏按钮显示', testToolbarButtonVisibility],
    ['自动回车处理', testAutoEnterNormalization],
    ['可见命令选择', testVisibleCommandSelection],
    ['输出触发器', testOutputAutomation],
    ['终端输出缓冲', testRecentOutputBuffer],
    ['运行数据存储', testRuntimeStorage],
    ['插件配置存储', testPluginConfigStorage],
    ['旧配置迁移', testLegacyPluginConfigMigration],
    ['命令执行运行器', testExecutionRunner],
]

async function runTests (): Promise<void> {
    const startedAt = Date.now()
    console.log(`\n${style('1;36', '========================================')}`)
    console.log(style('1;36', '  Tabby Windy Quick Commands - Tests'))
    console.log(style('1;36', '========================================'))

    for (const [name, run] of tests) {
        const testStartedAt = Date.now()
        try {
            await run()
            console.log(`${style('1;32', '[PASS]')} ${name} ${style('2', `(${Date.now() - testStartedAt} ms)`)}`)
        } catch (error) {
            console.error(`${style('1;31', '[FAIL]')} ${name}`)
            console.error(style('31', error instanceof Error ? error.message : String(error)))
            throw error
        }
    }

    console.log(style('1;32', '----------------------------------------'))
    console.log(style('1;32', `  ALL TESTS PASSED  ${tests.length}/${tests.length}  (${Date.now() - startedAt} ms)`))
    console.log(`${style('1;32', '----------------------------------------')}\n`)
}

void runTests().catch(() => {
    process.exitCode = 1
})
