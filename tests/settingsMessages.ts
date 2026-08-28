import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import * as ts from 'typescript'
import * as commandLibrary from '../src/commandLibrary'
import { defaultQuickCommandsConfig } from '../src/defaults'
import { buildDefaultSettingsConfig } from '../src/pluginConfigStorage'
import { translatePluginText } from '../src/translations'

// Run the real controller with isolated host services and a deterministic clock.
export async function testSettingsMessages (): Promise<void> {
    let now = 0
    let nextTimer = 0
    const timers = new Map<number, { at: number, run: () => void }>()
    const advance = (milliseconds: number): void => {
        now += milliseconds
        for (const [id, timer] of Array.from(timers)) {
            if (timer.at <= now) {
                timers.delete(id)
                timer.run()
            }
        }
    }
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'quickCommandsSettingsTab.component.ts'), 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2017,
            module: ts.ModuleKind.CommonJS,
            experimentalDecorators: true,
        },
    })
    const sandbox = {
        exports: {} as any,
        Error,
        require: (name: string): any => {
            if (name === '@angular/core') {
                return {
                    Component: (metadata: unknown) => (target: any) => { target.testMetadata = metadata; return target },
                    HostListener: () => () => undefined,
                }
            }
            if (name === './commandLibrary') { return commandLibrary }
            if (name === './configProvider') { return { createDefaultQuickCommandsConfig: () => ({}), defaultQuickCommandsConfig } }
            if (name === './pluginConfigStorage') { return { buildDefaultSettingsConfig } }
            if (name === './pluginIdentity') { return { pluginIdentity: { packageName: 'tabby-windy-quick-commands' } } }
            return {}
        },
        setTimeout: (run: () => void, delay: number): number => {
            const id = nextTimer++
            timers.set(id, { at: now + delay, run })
            return id
        },
        clearTimeout: (id: number): void => { timers.delete(id) },
    }
    vm.runInNewContext(compiled.outputText, sandbox)
    const Settings = sandbox.exports.QuickCommandsSettingsTabComponent
    const template = Settings.testMetadata.template as string
    assert.ok(template.includes('class="wqc-help-tooltip wqc-config-message-tooltip"'), 'message details must reuse the shared help tooltip style')
    assert.ok(!template.includes('[attr.title]="configMessageDetail'), 'message details must not use the native browser tooltip')
    assert.ok(template.includes('[attr.tabindex]="configMessageDetail ? 0 : null"'), 'details must be reachable by keyboard only when present')
    assert.ok(template.includes('[attr.aria-describedby]="configMessageDetail ? \'wqc-config-message-detail\' : null"'), 'the detail trigger must reference its tooltip')
    const clone = (value: any): any => JSON.parse(JSON.stringify(value))

    for (const language of ['zh-CN', 'en']) {
        let saved: any = { commands: [], exportFileName: 'original' }
        let failSave = false
        let changes = 0
        const settings: any = Object.create(Settings.prototype)
        Object.assign(settings, {
            configMessage: '', configMessageDetail: '', configMessageTimer: null,
            pluginConfig: clone(saved), savedConfigSnapshot: JSON.stringify(saved),
            pluginConfigStore: {
                set: (config: any): void => {
                    if (failSave) { throw new Error('Disk full') }
                    saved = clone(config)
                },
                load: () => clone(saved),
                exportPayload: (config: any) => clone(config),
                dataAccess: { isCurrent: () => true },
                parseImportFile: (text: string) => JSON.parse(text),
            },
            pluginUpdate: { checkInterval: 'daily' },
            i18n: { language, text: (text: string) => translatePluginText(text, language) },
            changeDetector: { detectChanges: () => changes++ },
            subscriptions: { unsubscribe: () => undefined },
            stopLocalizing: null,
            downloadJson: () => undefined,
        })

        settings.showConfigMessage('first', 'detail')
        assert.equal(timers.size, 1)
        advance(59_999)
        assert.equal(settings.configMessage, 'first', 'message must survive until one minute')
        advance(1)
        assert.equal(settings.configMessage, '')
        assert.equal(settings.configMessageDetail, '')
        assert.equal(settings.configMessageTimer, null)
        assert.equal(changes, 1, 'expiry must update the view')

        settings.showConfigMessage('old', 'old detail')
        advance(20_000)
        settings.showConfigMessage('new')
        assert.equal(timers.size, 1, 'replacement must cancel the old timer')
        assert.equal(settings.configMessageDetail, '', 'replacement must clear old details')
        advance(40_000)
        assert.equal(settings.configMessage, 'new', 'the old deadline must not dismiss a new message')
        advance(19_999)
        assert.equal(settings.configMessage, 'new')
        advance(1)
        assert.equal(settings.configMessage, '')

        settings.showConfigMessage('manual', 'details')
        settings.dismissConfigMessage()
        assert.equal(settings.configMessage, '')
        assert.equal(settings.configMessageDetail, '')
        assert.equal(timers.size, 0)
        const changesAfterDismiss = changes
        advance(60_000)
        assert.equal(changes, changesAfterDismiss, 'dismissal must cancel pending view updates')

        settings.pendingConfigImport = { config: { commands: [], exportFileName: 'imported' } }
        settings.importPendingFullConfig()
        assert.equal(settings.configMessage, '导入成功')
        assert.equal(settings.pendingConfigImport, null)
        assert.equal(saved.exportFileName, 'imported')
        settings.setString('exportFileName', { target: { value: 'edited' } })
        assert.equal(settings.configMessage, '导入成功', 'unrelated saves must not dismiss messages')

        settings.pendingConfigImport = {
            commands: [{ id: 'imported', name: 'Test', command: 'echo test' }],
            customCategories: [], categoryOrder: [], version: 1,
        }
        settings.importPendingCommands()
        assert.equal(settings.configMessage, '导入成功')
        assert.equal(saved.commands.length, 1)
        assert.equal(settings.pendingConfigImport, null)

        failSave = true
        const pending = { config: { commands: [], exportFileName: 'not-saved' } }
        settings.pendingConfigImport = pending
        settings.importPendingFullConfig()
        assert.equal(settings.configMessage, '导入失败')
        assert.ok(settings.configMessageDetail.includes('Disk full'))
        assert.equal(settings.pendingConfigImport, pending, 'failed imports must remain retryable')
        assert.equal(saved.exportFileName, 'edited', 'failed imports must not report success or replace saved data')
        settings.pendingConfigImport = { commands: [], customCategories: [], categoryOrder: [], version: 1 }
        settings.importPendingCommands()
        assert.equal(settings.configMessage, '导入失败')
        failSave = false

        settings.setNumber('drawerWidth', { target: { value: '740' } }, 420, 760)
        const beforeRestore = clone(saved)
        settings.openResetDefaultsConfirm()
        failSave = true
        settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '恢复失败')
        assert.ok(settings.configMessageDetail.includes('Disk full'))
        assert.equal(settings.resetDefaultsConfirmOpen, false, 'restore results must not be hidden behind the confirmation dialog')
        assert.deepEqual(saved, beforeRestore, 'failed restore must preserve saved settings and commands')
        assert.deepEqual(clone(settings.root), beforeRestore, 'failed restore must roll back displayed settings')
        assert.equal(translatePluginText(settings.configMessage, language), language === 'en' ? 'Restore failed' : '恢复失败')

        failSave = false
        settings.openResetDefaultsConfirm()
        settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '恢复成功')
        assert.ok(settings.configMessageDetail.includes('重启 Tabby'), 'restart instructions must remain available in the details')
        assert.equal(settings.resetDefaultsConfirmOpen, false)
        assert.equal(saved.drawerWidth, defaultQuickCommandsConfig.drawerWidth)
        assert.deepEqual(saved.commands, beforeRestore.commands, 'restore defaults must preserve commands and triggers')
        assert.deepEqual(saved.customCategories, beforeRestore.customCategories)
        assert.equal(translatePluginText(settings.configMessage, language), language === 'en' ? 'Defaults restored' : '恢复成功')
        assert.equal(timers.size, 1, 'restore success must replace the previous failure notification')
        advance(59_999)
        assert.equal(settings.configMessage, '恢复成功')
        advance(1)
        assert.equal(settings.configMessage, '')

        settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '', 'restore must still require confirmation')
        settings.openResetDefaultsConfirm()
        settings.openResetInitialConfirm()
        settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '', 'data reset confirmation must not invoke ordinary restore')
        settings.closeResetDefaultsConfirm()

        for (const file of [
            { size: 1, text: async () => '{invalid' },
            { size: 6 * 1024 * 1024, text: async () => '{}' },
            { size: 1, text: async () => { throw new Error('Read failed') } },
        ]) {
            const input = { files: [file], value: 'selected.json' }
            await settings.importPluginConfig({ target: input })
            assert.equal(settings.configMessage, '导入失败')
            assert.ok(settings.configMessageDetail)
            assert.equal(input.value, '', 'the same file must be selectable again')
        }
        assert.equal(translatePluginText('导入成功', language), language === 'en' ? 'Import successful' : '导入成功')
        assert.equal(translatePluginText(settings.configMessage, language), language === 'en' ? 'Import failed' : '导入失败')
        assert.equal(translatePluginText('关闭提示', language), language === 'en' ? 'Dismiss notification' : '关闭提示')

        settings.exportPluginConfig()
        assert.equal(settings.configMessage, '已触发插件配置文件下载，请检查下载目录。')
        assert.equal(settings.configMessageDetail, '')
        assert.equal(timers.size, 1)
        settings.ngOnDestroy()
        assert.equal(timers.size, 0, 'leaving settings must cancel the one-minute timer')
        const changesAfterDestroy = changes
        advance(60_000)
        assert.equal(changes, changesAfterDestroy, 'destroyed views must not be updated')
    }
}
