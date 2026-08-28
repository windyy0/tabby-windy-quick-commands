import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

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
import { buildDefaultSettingsConfig, QuickCommandsPluginConfigStore } from '../src/pluginConfigStorage'
import { createDefaultQuickCommandsConfig, defaultQuickCommandsConfig } from '../src/defaults'
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
    getUpdateComparisonVersion,
} from '../src/pluginUpdate'
import { shouldHandleDelegatedAction } from '../src/delegatedClick'
import { getPluginIdentity } from '../src/pluginIdentity'
import { PluginDataAccess } from '../src/pluginData'

function testBuildIsolation (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wqc-channels-'))
    try {
        const configPath = path.join(directory, 'config.yaml')
        const originalYaml = 'windyCommandCenter:\n  commands: []\nhotkeys: {}\n'
        fs.writeFileSync(configPath, originalYaml)
        const stable = getPluginIdentity(false)
        const test = getPluginIdentity(true)
        const stableStore = new QuickCommandsPluginConfigStore(configPath, stable)
        const testStore = new QuickCommandsPluginConfigStore(configPath, test)
        const stableRuntime = new QuickCommandsRuntimeStore(configPath, stable)
        const testRuntime = new QuickCommandsRuntimeStore(configPath, test)
        const events: string[] = []
        const originalWindow = (global as any).window
        const originalCustomEvent = (global as any).CustomEvent
        ;(global as any).window = { dispatchEvent: (event: { type: string }) => events.push(event.type) }
        ;(global as any).CustomEvent = class { constructor (public type: string) {} }
        try {
            stableStore.set({ commands: [{ id: 'same-id', command: 'echo stable' }] })
            const stableBytes = fs.readFileSync(stableStore.configPath!, 'utf8')
            testStore.set({ commands: [{ id: 'same-id', command: 'echo test' }] })
            testStore.set({ commands: [] })
            stableRuntime.setStats({ 'same-id': { usageCount: 8, lastUsedAt: null } })
            testRuntime.setStats({ 'same-id': { usageCount: 2, lastUsedAt: null } })
            testRuntime.setLogs([{ id: 'test-log', time: '2026-08-27', level: 'info', message: 'test' }])
            assert(fs.readFileSync(stableStore.configPath!, 'utf8') === stableBytes, 'test saves must preserve stable config bytes')
            assert(new QuickCommandsRuntimeStore(configPath).getStats()['same-id'].usageCount === 8, 'stats with identical command IDs must remain separate')
            assert(stableRuntime.getLogs().length === 0, 'test logs must not appear in stable storage')
            assert(testStore.backupPath !== stableStore.backupPath && fs.existsSync(testStore.backupPath!), 'test backups must stay in the test directory')
            assert(events.filter(event => event === stable.configChangedEvent).length === 1, 'test writes must not dispatch stable config events')
            assert(events.includes(test.configChangedEvent) && events.includes(test.runtimeChangedEvent), 'test writes must dispatch their own events')
            assert(!migrateLegacyPluginConfig(readLegacyPluginConfig(configPath, test), testStore, testRuntime), 'dev migration must not read stable legacy data')
            assert(!migrateLegacyPluginConfig({ commands: [] }, testStore, stableRuntime), 'migration must reject mismatched storage namespaces')
            assert(fs.readFileSync(configPath, 'utf8') === originalYaml, 'test operations must preserve Tabby config.yaml')
        } finally {
            ;(global as any).window = originalWindow
            ;(global as any).CustomEvent = originalCustomEvent
        }
        const namespace = require('../../scripts/dev-namespace-loader.cjs')
        assert(namespace('.tqc-root { --tqc-width: 5px } #wqc-help quick-commands-settings-tab') === '.tqc-dev-root { --tqc-dev-width: 5px } #wqc-dev-help quick-commands-dev-settings-tab', 'test markup and CSS must use matching isolated names')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

function testTestDataScripts (): void {
    if (process.platform !== 'win32') {
        console.log('  Windows PowerShell data script checks skipped on this platform')
        return
    }
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'tests/test-tabby-installation.ps1'], {
        encoding: 'utf8', windowsHide: true,
    })
    assert(result.status === 0, `dev data script checks failed: ${result.error || ''}\n${result.stdout}\n${result.stderr}`)
}

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
    assert(translatePluginText('新命令', 'en-US') === 'New command', 'new command default name should be translated')
    assert(translatePluginText('第 2 行执行后：npm test', 'en-US') === 'After source line 2: npm test', 'line trigger labels should be translated')
    assert(translatePluginText('匹配后流程', 'en-US') === 'After-match flow', 'post-match flow label should be translated')
    assert(translatePluginText('全部行匹配', 'en-US') === 'Match all patterns', 'output pattern logic should be translated')
    assert(translatePluginText('输入要发送到终端的命令', 'en-US') === 'Enter the command to send to the terminal', 'custom automation command placeholder should be translated')
    assert(translatePluginText('恢复默认配置', 'en-US') === 'Restore defaults', 'restore-defaults action should be translated')
    assert(translatePluginText('重置插件数据', 'en-US') === 'Reset plugin data', 'destructive reset entry should be translated')
    assert(translatePluginText('确认重置', 'en-US') === 'Confirm reset', 'reset confirmation must not imply restarting Tabby')
    assert(translatePluginText('插件本地缓存', 'en-US') === 'Local plugin cache', 'reset cache scope should be translated')
    assert(translatePluginText('仅清空下方显示的当前插件数据目录，不影响 Tabby 配置和其他插件。', 'en-US') === "Only this plugin's data directory shown below is cleared. Tabby configuration and other plugins are not affected.", 'reset directory scope must be explicit in both languages')
    assert(translatePluginText('当前 Tabby 窗口不会重启。请在操作后重启，以免继续使用旧数据。', 'en-US') === 'The current Tabby window will not restart automatically. Please restart Tabby afterward to avoid using stale data.', 'reset result should explain that restart is manual and recommended afterward')
    assert(translatePluginText('返回', 'en-US') === 'Back', 'the second reset page must have a translated Back button')
    assert(translatePluginText('当前插件仍有命令正在执行，请停止执行后再重置插件数据。', 'en-US') === 'A command is still running in this plugin. Stop execution before resetting.', 'reset blockers must be localized')
    assert(translatePluginText('导入完整配置', 'en-US') === 'Import full configuration', 'full configuration import action should be translated')
    assert(translatePluginText('该文件只包含命令。', 'en-US') === 'This file contains commands only.', 'commands-only import message first line should be translated')
    assert(translatePluginText('是否将命令合并到当前命令库？', 'en-US') === 'Merge them into the current command library?', 'commands-only import message second line should be translated')
    assert(translatePluginText('该文件包含命令和插件配置，请选择要导入的内容。', 'en-US') === 'This file contains commands and plugin settings. Choose what to import.', 'full import message first line should be translated')
    assert(translatePluginText('导入完整配置会替换当前命令和设置。', 'en-US') === 'Importing the full configuration replaces the current commands and settings.', 'full import message second line should be translated')
    assert(translatePluginText('导入', 'en-US') === 'Import', 'settings import action should be translated')
    assert(translatePluginText('导出', 'en-US') === 'Export', 'settings export action should be translated')
    assert(translatePluginText('导入规则', 'en-US') === 'Import rules', 'import preview rules heading should be translated')
    assert(translatePluginText('冲突详情', 'en-US') === 'Conflict details', 'import preview conflict heading should be translated')
    assert(translatePluginText('另有 3 条冲突未显示。', 'en-US') === '3 more conflicts are not shown.', 'hidden import conflicts should be translated')
    assert(translatePluginText('到指定分类。', 'en-US') === 'to the selected category.', 'move dialog suffix should be translated')
    assert(translatePluginText('该分类包含', 'en-US') === 'This category contains', 'category deletion count prefix should be translated')
    assert(translatePluginText('条命令', 'en-US') === 'commands', 'category deletion command unit should be translated')
    assert(translatePluginText('确认删除该输出触发器规则？此操作不可撤销。', 'en-US') === 'Delete this output trigger rule? This action cannot be undone.', 'output trigger deletion should be translated')
    assert(translatePluginText('命令 1的第 2 条输出触发器错误动作无效。', 'en-US') === 'Command 1 output trigger 2 has an invalid error action.', 'output trigger validation errors should be translated')
    assert(translatePluginText('将“部署”移动到指定分类。', 'en-US') === 'Move "部署" to the selected category.', 'move dialog should translate dynamic command names')
    assert(translatePluginText('将选中的 3 条命令移动到', 'en-US') === 'Move the selected 3 commands to', 'batch move prompt should be translated')
    assert(translatePluginText('检查更新', 'en-US') === 'Check for updates', 'update controls should be translated')
    assert(translatePluginText('Dev 读取正式版的版本信息和更新历史，不会安装正式包。', 'en-US') === 'Dev reads stable release information and history without installing the stable package.', 'Dev update source notice must be translated independently')
    assert(translatePluginText('更新本地代码后，请在源码目录运行：', 'en-US') === 'After updating your local source, run this in the source directory:', 'Dev local installation notice must be translated independently')
    assert(translatePluginText('然后重启 Tabby。', 'en-US') === 'Then restart Tabby.', 'local installation instructions must be fully translated')
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
    assert(drawerSource.includes("return this.i18n.text('新命令')"), 'new command draft should use the current interface language')
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
    assert(!isNewerPluginVersion('1.7.0', getUpdateComparisonVersion('1.7.0-dev.local', true)), 'a local Dev suffix must not cause a same-version update')
    assert(isNewerPluginVersion('1.8.0', getUpdateComparisonVersion('1.7.0-dev.local', true)), 'Dev must detect newer stable versions')
    assert(!isNewerPluginVersion('1.6.0', getUpdateComparisonVersion('1.7.0-dev.local', true)), 'Dev must not offer a downgrade')
    assert(getUpdateComparisonVersion('1.7.0-beta.2-dev.local+build', true) === '1.7.0-beta.2+build', 'only the local Dev suffix should be stripped')
    assert(getUpdateComparisonVersion('1.7.0-dev.local', false) === '1.7.0-dev.local', 'stable version comparison must remain unchanged')
    assert(getUpdateComparisonVersion('1.7.0-dev.local.1', true) === '1.7.0-dev.local.1', 'genuine prerelease suffixes must not be stripped')
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
        version: 1,
        kind: 'commands',
        customCategories: ['空分类', '空分类'],
        categoryOrder: ['开发', '空分类'],
        commands: [{ id: 'one', name: '测试', command: 'echo ok' }],
    }))
    assert(parsed.version === 1 && parsed.kind === 'commands', 'import parser should preserve the supported file type and version')
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

    let oldVersionRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 3,
            kind: 'commands',
            customCategories: [],
            categoryOrder: [],
            commands: [],
        }))
    } catch {
        oldVersionRejected = true
    }
    assert(oldVersionRejected, 'import parser should reject the old v3 command-library format')

    let duplicateRejected = false
    try {
        parseImportPayload(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 1,
            kind: 'commands',
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
            kind: 'commands',
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
            version: 1,
            kind: 'commands',
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
            version: 1,
            kind: 'commands',
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
        version: 1,
        kind: 'commands',
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
            version: 1,
            kind: 'commands',
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

function testPluginDataReset (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windy-reset-'))
    try {
        const configPath = path.join(directory, 'profile with spaces', 'config.yaml')
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, 'language: en-US\n')
        for (const devBuild of [false, true]) {
            const identity = getPluginIdentity(devBuild)
            const store = new QuickCommandsPluginConfigStore(configPath, identity)
            const peer = new QuickCommandsPluginConfigStore(configPath, getPluginIdentity(!devBuild))
            peer.set({ commands: [{ name: 'Other channel', command: 'echo keep' }] })
            const peerBytes = fs.readFileSync(peer.configPath!, 'utf8')
            store.initialize(createDefaultQuickCommandsConfig('zh-CN'))
            store.set({ commands: [{ name: 'Private command', command: 'echo secret' }] })
            const stale = new QuickCommandsPluginConfigStore(configPath, identity)
            stale.load({})
            const runtime = new QuickCommandsRuntimeStore(configPath, identity)
            runtime.setLogs([{ id: 'old', time: '2026-08-27', level: 'info', message: 'Old log' }])
            runtime.setStats({ old: { usageCount: 9, lastUsedAt: null } })
            const dataDirectory = store.dataAccess.directory!
            fs.writeFileSync(path.join(dataDirectory, 'update-cache.json'), '{"old":true}')
            fs.mkdirSync(path.join(dataDirectory, 'extra'))
            fs.writeFileSync(path.join(dataDirectory, 'extra', 'other-data.txt'), 'old user data')
            const before = fs.readFileSync(store.configPath!, 'utf8')
            const release = stale.dataAccess.beginExecution()
            let failure = ''
            try { store.reset(createDefaultQuickCommandsConfig('en')) } catch (error) { failure = (error as Error).message }
            assert(failure.includes('命令正在执行') && fs.readFileSync(store.configPath!, 'utf8') === before, 'an execution in any store must prevent reset without modifying data')
            release()

            const link = path.join(dataDirectory, 'linked-data')
            fs.symlinkSync(peer.dataAccess.directory!, link, 'junction')
            failure = ''
            try { store.reset(createDefaultQuickCommandsConfig('en')) } catch (error) { failure = (error as Error).message }
            assert(failure.includes('符号链接') && fs.readFileSync(store.configPath!, 'utf8') === before, 'links must be rejected before any deletion')
            fs.unlinkSync(link)

            const lockPath = path.join(path.dirname(configPath), `.${identity.dataDirectory}.lock-${process.pid}-test-peer`)
            const releaseWhileLocked = store.dataAccess.beginExecution()
            fs.writeFileSync(lockPath, String(process.pid))
            assert(new QuickCommandsPluginConfigStore(configPath, identity).load({}).commands !== undefined, 'opening a reader must not require the active writer lock')
            failure = ''
            try { store.reset(createDefaultQuickCommandsConfig('en')) } catch (error) { failure = (error as Error).message }
            assert(failure.includes('其他窗口使用') && fs.readFileSync(store.configPath!, 'utf8') === before, 'a live writer lock must prevent reset')
            releaseWhileLocked()
            releaseWhileLocked()
            assert(!fs.readdirSync(dataDirectory).some(name => name.startsWith('.execution-')), 'execution cleanup must finish even while another window owns the writer lock, and repeated cleanup must be harmless')
            assert(fs.readFileSync(lockPath, 'utf8') === String(process.pid), 'execution cleanup must not bypass or remove another writer lock')
            fs.unlinkSync(lockPath)

            const nativeFs = require('fs')
            const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true })
            assert(exited.status === 0, 'dead-owner fixture must exit successfully')
            const deadPid = Number(exited.stdout)
            let deadOwner = false
            try { process.kill(deadPid, 0) } catch (error) { deadOwner = (error as NodeJS.ErrnoException).code === 'ESRCH' }
            assert(deadOwner, 'stale-lock fixture must belong to an exited process')
            const staleLock = path.join(path.dirname(configPath), `.${identity.dataDirectory}.lock-${deadPid}-stale`)
            fs.writeFileSync(staleLock, '')
            const originalUnlink = nativeFs.unlinkSync
            let checkedCompetingWriter = false
            try {
                nativeFs.unlinkSync = (target: string) => {
                    if (target === staleLock && !checkedCompetingWriter) {
                        checkedCompetingWriter = true
                        // Another cleaner already removed the captured stale
                        // claim, then a new writer attempts to acquire its own.
                        originalUnlink(staleLock)
                        let entered = false
                        let blocked = false
                        try { stale.dataAccess.write(() => { entered = true }) } catch (error) { blocked = (error as Error).message.includes('其他窗口使用') }
                        assert(blocked && !entered, 'a writer racing stale cleanup must observe the cleaner\'s already-published claim')
                    }
                    originalUnlink(target)
                }
                store.dataAccess.write(() => {
                    const claims = fs.readdirSync(path.dirname(configPath)).filter(name => name.startsWith(`.${identity.dataDirectory}.lock-`))
                    assert(claims.length === 1, 'the active writer must retain its own claim after stale cleanup races')
                })
            } finally { nativeFs.unlinkSync = originalUnlink }
            assert(checkedCompetingWriter && !fs.existsSync(staleLock), 'dead owner cleanup must tolerate another cleaner removing the same claim')
            let actionFailed = false
            try { store.dataAccess.write(() => { throw new Error('writer action failed') }) } catch { actionFailed = true }
            assert(actionFailed && !fs.readdirSync(path.dirname(configPath)).some(name => name.startsWith(`.${identity.dataDirectory}.lock-`)), 'failed actions must release their own claims')

            const originalRemove = nativeFs.rmSync
            const originalWrite = nativeFs.writeFileSync
            const resetReads: string[] = []
            try {
                const tryReadDuringReset = (stage: string) => {
                    let errorMessage = ''
                    try { new QuickCommandsPluginConfigStore(configPath, identity).load({}) } catch (error) { errorMessage = (error as Error).message }
                    assert(errorMessage.includes('其他窗口使用'), `readers must not adopt an unfinished reset generation: ${stage}`)
                    resetReads.push(stage)
                }
                nativeFs.rmSync = (target: string, options: unknown) => {
                    if (target === dataDirectory) { tryReadDuringReset('before deleting old config') }
                    originalRemove(target, options)
                }
                nativeFs.writeFileSync = (target: string | number, value: unknown, options: unknown) => {
                    if (target === store.configPath) { tryReadDuringReset('before writing new config') }
                    originalWrite(target, value, options)
                }
                store.reset(createDefaultQuickCommandsConfig('en'))
            } finally {
                nativeFs.rmSync = originalRemove
                nativeFs.writeFileSync = originalWrite
            }
            assert(resetReads.length === 2, 'reset must reject readers both before deletion and while rebuilding the new config')
            assert(JSON.stringify(fs.readdirSync(dataDirectory).sort()) === JSON.stringify(['.data-generation', 'plugin-config.json']), 'reset must remove backups, logs, stats, cache and arbitrary data, leaving only fresh config and its generation marker')
            const fresh = store.load({}) as any
            assert(fresh.commands.length === 1 && fresh.commands[0].name === 'Example command' && fresh.commands[0].favorite && !fresh.commands[0].pinned, 'reset must use the shared localized first-use defaults')
            const freshBytes = fs.readFileSync(store.configPath!, 'utf8')
            failure = ''
            try { stale.set({ commands: [{ name: 'Stale write' }] }) } catch (error) { failure = (error as Error).message }
            assert(failure.includes('已在其他窗口重置'), 'pre-reset config stores must not resurrect deleted data')
            runtime.setLogs([{ id: 'stale', time: '', level: 'info', message: 'stale' }])
            runtime.setStats({ old: { usageCount: 99, lastUsedAt: null } })
            assert(!fs.existsSync(runtime.logsPath!) && !fs.existsSync(runtime.statsPath!), 'stale runtime caches must not be written back')
            assert(fs.readFileSync(store.configPath!, 'utf8') === freshBytes && fs.readFileSync(peer.configPath!, 'utf8') === peerBytes, 'reset must preserve new config and the other channel')
            assert(fs.readFileSync(configPath, 'utf8') === 'language: en-US\n', 'reset must not modify Tabby configuration')

            // Lease release is independent of the reset lock and may happen
            // between the tree listing and its per-file safety check.
            const releaseDuringPreflight = store.dataAccess.beginExecution()
            const originalStat = nativeFs.lstatSync
            try {
                nativeFs.lstatSync = (target: string, ...args: unknown[]) => {
                    if (path.basename(target).startsWith('.execution-')) {
                        nativeFs.lstatSync = originalStat
                        releaseDuringPreflight()
                    }
                    return originalStat(target, ...args)
                }
                store.reset(createDefaultQuickCommandsConfig('en'))
            } finally { nativeFs.lstatSync = originalStat }
            const newerRelease = store.dataAccess.beginExecution()
            releaseDuringPreflight()
            assert(fs.readdirSync(dataDirectory).filter(name => name.startsWith('.execution-')).length === 1, 'a late repeated release after reset must never remove a newer execution lease')
            newerRelease()
            store.reset(createDefaultQuickCommandsConfig('zh-CN'))
            assert((store.load({}).commands as any[])[0].name === '示例命令', 'a second explicit reset must create defaults in the newly selected language')

            try {
                nativeFs.rmSync = () => { throw new Error('simulated locked file') }
                failure = ''
                try { store.reset(createDefaultQuickCommandsConfig('zh-CN')) } catch (error) { failure = (error as Error).message }
                assert(failure.includes('部分数据可能已删除') && failure.includes('simulated locked file'), 'failed deletion must report its stage and preserve the original error')
                assert(!store.dataAccess.isCurrent(), 'even a failed reset must invalidate old writers before partial deletion can occur')
            } finally { nativeFs.rmSync = originalRemove }
            const recovered = new QuickCommandsPluginConfigStore(configPath, identity)
            recovered.reset(createDefaultQuickCommandsConfig('en'))
            assert((recovered.load({}).commands as any[])[0].name === 'Example command', 'a fresh store must recover from an interrupted reset marker and allow retrying')
            assert(!store.dataAccess.isCurrent(), 'recovering a failed reset must not reactivate old stores')
        }
        // Independent JS runtimes contend on real files, not mocked lock calls.
        const concurrentPath = path.join(directory, 'concurrent', 'config.yaml')
        new QuickCommandsPluginConfigStore(concurrentPath).set({ counter: 0 })
        const concurrent = spawnSync(process.execPath, ['-e', `
            const { Worker } = require('worker_threads')
            const worker = \`
                const { workerData } = require('worker_threads')
                const fs = require('fs')
                const path = require('path')
                const { PluginDataAccess } = require(workerData.modulePath)
                const access = new PluginDataAccess(workerData.configPath)
                const counterPath = path.join(access.directory, 'plugin-config.json')
                const criticalPath = path.join(access.directory, 'active-writer')
                const delay = new Int32Array(new SharedArrayBuffer(4))
                for (let count = 0, attempts = 0; count < 40; attempts++) {
                    if (attempts > 2000) throw new Error('writer made no progress')
                    try {
                        access.write(() => {
                            const fd = fs.openSync(criticalPath, 'wx')
                            try {
                                const value = JSON.parse(fs.readFileSync(counterPath, 'utf8'))
                                Atomics.wait(delay, 0, 0, 2)
                                fs.writeFileSync(counterPath, JSON.stringify({ counter: value.counter + 1 }))
                            } finally { fs.closeSync(fd); fs.unlinkSync(criticalPath) }
                        })
                        count++
                    } catch (error) {
                        if (!error.message.includes('其他窗口使用')) throw error
                        Atomics.wait(delay, 0, 0, 2 + Math.random() * 5)
                    }
                }
            \`
            Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
                const thread = new Worker(worker, { eval: true, workerData: { modulePath: process.argv[1], configPath: process.argv[2] } })
                thread.on('error', reject)
                thread.on('exit', code => code === 0 ? resolve() : reject(new Error('worker exited: ' + code)))
            }))).catch(error => { console.error(error); process.exitCode = 1 })
        `, path.resolve(__dirname, '../src/pluginData.js'), concurrentPath], { encoding: 'utf8', timeout: 20000, windowsHide: true })
        assert(concurrent.status === 0, `concurrent writers must never overlap: ${concurrent.stderr || concurrent.error || ''}`)
        assert(new QuickCommandsPluginConfigStore(concurrentPath).load({}).counter === 160, 'all successful concurrent increments must persist without lost writes')
        let invalid = false
        try { new PluginDataAccess(null).reset({}) } catch { invalid = true }
        assert(invalid, 'reset requires an actual data directory')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

function testPluginConfigStorage (): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windy-quick-config-'))
    try {
        const configPath = path.join(directory, 'config.yaml')
        const store = new QuickCommandsPluginConfigStore(configPath)
        for (const devBuild of [false, true]) {
            const identity = getPluginIdentity(devBuild)
            for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', null]) {
                const localizedPath = path.join(directory, `${devBuild}-${locale}`, 'config.yaml')
                const localizedStore = new QuickCommandsPluginConfigStore(localizedPath, identity)
                const defaults = createDefaultQuickCommandsConfig(locale)
                const chinese = getPluginLanguage(locale) === 'zh-CN'
                const category = chinese ? '默认' : 'Default'
                // A pre-ready read must not lock in Tabby's temporary English locale.
                localizedStore.load(createDefaultQuickCommandsConfig('en'))
                localizedStore.initialize(defaults)
                const fresh = localizedStore.load({}) as any
                assert(fresh.customCategories.length === 1 && fresh.customCategories[0] === category, 'initial category must use the resolved interface language')
                assert(fresh.commands[0].category === category && fresh.commands[0].name === (chinese ? '示例命令' : 'Example command'), 'sample command and category must use the same language')
                assert(fresh.commands[0].description === (chinese ? '输出一条示例消息，可修改为自己的命令' : 'Print an example message; edit this to use your own command'), 'sample description must use the initial language')
                const bytes = fs.readFileSync(localizedStore.configPath!, 'utf8')
                const opposite = createDefaultQuickCommandsConfig(chinese ? 'en' : 'zh-CN')
                const restarted = new QuickCommandsPluginConfigStore(localizedPath, identity)
                restarted.initialize(opposite)
                assert(JSON.stringify(restarted.load(opposite)) === JSON.stringify(fresh), 'restart in another language must preserve initialized user data')
                assert(fs.readFileSync(localizedStore.configPath!, 'utf8') === bytes, 'language changes must not rewrite saved data')
                defaults.commands[0].name = 'Edited template'
                assert(fresh.commands[0].name !== defaults.commands[0].name, 'initialization must clone the supplied defaults')
            }
            const freshStore = new QuickCommandsPluginConfigStore(configPath, identity)
            const fresh = freshStore.load(defaultQuickCommandsConfig)
            const examples = fresh.commands as any[]
            assert(examples.length === 1 && examples[0].category === '默认', 'new profiles must have one example in the default category')
            assert(examples[0].command === 'echo Hello Tabby' && examples[0].favorite && !examples[0].pinned, 'the example must only echo text, be favorited and not pinned')
            assert(fresh.selectedCommandId === examples[0].id, 'initial selection must point to the example')
            for (const saved of [
                { commands: [{ id: 'build-start', name: '用户保留的命令', category: '开发', command: 'echo custom' }], customCategories: ['开发', 'Git', '诊断'] },
                { commands: [], customCategories: [] },
            ]) {
                freshStore.set(saved)
                const bytes = fs.readFileSync(freshStore.configPath!, 'utf8')
                const existing = new QuickCommandsPluginConfigStore(configPath, identity)
                existing.initialize(createDefaultQuickCommandsConfig('en'))
                const loaded = existing.load(createDefaultQuickCommandsConfig('en'))
                assert(JSON.stringify(loaded) === JSON.stringify(saved), 'updated defaults must preserve existing libraries, including empty ones')
                assert(fs.readFileSync(freshStore.configPath!, 'utf8') === bytes, 'loading with new defaults must not rewrite user data')
            }
            fs.writeFileSync(freshStore.configPath!, '{broken json')
            freshStore.initialize(createDefaultQuickCommandsConfig('en'))
            assert(fs.readFileSync(freshStore.configPath!, 'utf8') === '{broken json', 'a damaged existing config must not be overwritten with new starter data')
            fs.unlinkSync(freshStore.configPath!)
            const backupBytes = fs.readFileSync(freshStore.backupPath!, 'utf8')
            freshStore.initialize(createDefaultQuickCommandsConfig('en'))
            assert(!freshStore.exists() && fs.readFileSync(freshStore.backupPath!, 'utf8') === backupBytes, 'a remaining backup must not be mistaken for a fresh profile')
        }
        assert(defaultQuickCommandsConfig.commands[0].name === '示例命令', 'localized defaults must not mutate shared templates')
        const first = { commands: [{ id: 'a', name: 'A', command: 'echo a' }], drawerWidth: 560 }
        const second = {
            commands: [{ id: 'b', name: 'B', command: 'echo b' }],
            customCategories: [],
            categoryOrder: [],
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
        assert(payload.format === 'tabby-windy-quick-commands' && payload.version === 1 && payload.kind === 'config', 'configuration export should use the unified v1 file protocol')
        const imported = store.parseImport(JSON.stringify(payload))
        const drawerImported = parseImportPayload(JSON.stringify(payload))
        assert(drawerImported.kind === 'config' && drawerImported.commands.length === 1, 'drawer import should extract commands from full configuration files')
        assert(Array.isArray(imported.commands) && imported.commands.length === 1, 'full config export should be importable')
        assert(imported.moveNavigateAfterMove === true, 'move navigation preference should be importable')
        assert(imported.updateCheckInterval === 'weekly', 'update check interval should be importable')
        assert(imported.ignoredUpdateVersion === '1.6.0', 'ignored update version should be importable')
        const commandsFile = store.parseImportFile(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 1,
            kind: 'commands',
            commands: [{ id: 'commands-only', name: '仅命令', command: 'echo commands' }],
            customCategories: ['导入分类'],
            categoryOrder: ['导入分类'],
        }))
        assert(commandsFile.kind === 'commands' && commandsFile.commands.length === 1, 'settings import should accept command-library files')
        const normalized = store.parseImport(JSON.stringify({
            format: 'tabby-windy-quick-commands',
            version: 1,
            kind: 'config',
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
                format: 'tabby-windy-quick-commands',
                version: 1,
                kind: 'config',
                config: {
                    commands: [{
                        name: '错误规则',
                        command: 'echo ok',
                        automationRules: [{ onMatchCommand: {} }],
                    }],
                    customCategories: [],
                    categoryOrder: [],
                },
            }))
        } catch {
            malformedRuleRejected = true
        }
        assert(malformedRuleRejected, 'full config import should reject malformed nested automation fields')

        let malformedSettingRejected = false
        try {
            store.parseImport(JSON.stringify({
                format: 'tabby-windy-quick-commands',
                version: 1,
                kind: 'config',
                config: {
                    commands: [{ name: '测试', command: 'echo ok' }],
                    customCategories: [],
                    categoryOrder: [],
                    showToolbarButton: 'yes',
                },
            }))
        } catch {
            malformedSettingRejected = true
        }
        assert(malformedSettingRejected, 'full config import should reject invalid top-level setting types')
        let rejected = false
        try {
            store.parseImport(JSON.stringify({ format: 'wrong', version: 1, kind: 'config', config: second }))
        } catch {
            rejected = true
        }
        assert(rejected, 'plugin config import should reject unrelated JSON files')

        const restored = buildDefaultSettingsConfig({
            commands: [{ id: 'kept', name: '保留', command: 'echo kept', automationRules: [{ id: 'kept-rule' }] }],
            customCategories: ['保留分类'],
            categoryOrder: ['保留分类'],
            drawerWidth: 720,
            updateCheckInterval: 'never',
        }, {
            commands: [{ id: 'default', name: '默认', command: 'echo default' }],
            customCategories: [],
            categoryOrder: [],
            selectedCommandId: 'default',
            selectedCategory: '开发',
            drawerWidth: 560,
            updateCheckInterval: 'daily',
        })
        assert((restored.commands as any[])[0].id === 'kept', 'restoring defaults should preserve user commands and rules')
        assert((restored.customCategories as string[])[0] === '保留分类', 'restoring defaults should preserve custom categories')
        assert(restored.drawerWidth === 560 && restored.updateCheckInterval === 'daily', 'restoring defaults should reset plugin settings')
        assert(restored.selectedCommandId === 'kept' && restored.selectedCategory === '全部', 'restoring defaults should repair selection for preserved commands')
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

        const devIdentity = getPluginIdentity(true)
        const devConfigPath = path.join(directory, 'dev-config.yaml')
        const legacyYaml = 'windyCommandCenter:\n  drawerWidth: 700\nwindyCommandCenterDev:\n  drawerWidth: 620\n  commands:\n    - id: legacy-dev\n      name: Dev command\n      command: echo dev\n      usageCount: 2\n'
        fs.writeFileSync(devConfigPath, legacyYaml)
        const devPluginStore = new QuickCommandsPluginConfigStore(devConfigPath, devIdentity)
        const devRuntimeStore = new QuickCommandsRuntimeStore(devConfigPath, devIdentity)
        assert(migrateLegacyPluginConfig(readLegacyPluginConfig(devConfigPath, devIdentity), devPluginStore, devRuntimeStore), 'dev must support the same migration flow in its own namespace')
        assert(devPluginStore.load({}).drawerWidth === 620, 'dev must migrate its own settings')
        assert(devRuntimeStore.getStats()['legacy-dev'].usageCount === 2, 'dev must migrate usage statistics')
        assert(removeLegacyPluginConfig(devConfigPath, devIdentity), 'dev migration must clean its legacy namespace')
        assert((readLegacyPluginConfig(devConfigPath) as any).drawerWidth === 700, 'dev cleanup must retain stable legacy settings')

        fs.writeFileSync(devConfigPath, legacyYaml)
        const cleanup = spawnSync(process.execPath, [
            'scripts/cleanup-tabby-config.cjs', devConfigPath, devPluginStore.configPath!,
            devIdentity.legacyConfigKey, devIdentity.dataDirectory,
        ], { encoding: 'utf8', windowsHide: true })
        assert(cleanup.status === 0, `installer legacy cleanup failed: ${cleanup.stderr}`)
        assert(readLegacyPluginConfig(devConfigPath, devIdentity) === undefined, 'installer must clean only the selected legacy namespace')
        assert((readLegacyPluginConfig(devConfigPath) as any).drawerWidth === 700, 'installer dev cleanup must retain stable legacy data')
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
    ['恢复初始状态与数据隔离', testPluginDataReset],
    ['旧配置迁移', testLegacyPluginConfigMigration],
    ['开发版数据隔离', testBuildIsolation],
    ['开发版数据脚本', testTestDataScripts],
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
