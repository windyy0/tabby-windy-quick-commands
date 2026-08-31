import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import * as ts from 'typescript'
import * as commandLibrary from '../src/commandLibrary'
import { defaultQuickCommandsConfig } from '../src/defaults'
import { buildDefaultSettingsConfig } from '../src/pluginConfigStorage'
import { translatePluginText } from '../src/translations'
import * as pluginHotkeys from '../src/pluginHotkeys'
import * as shortcutManager from '../src/shortcutManager'

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
                    Optional: () => () => undefined,
                }
            }
            if (name === './commandLibrary') { return commandLibrary }
            if (name === './configProvider') { return { createDefaultQuickCommandsConfig: () => ({}), defaultQuickCommandsConfig } }
            if (name === './pluginConfigStorage') { return { buildDefaultSettingsConfig } }
            if (name === './pluginIdentity') { return { pluginIdentity: { packageName: 'tabby-windy-quick-commands' } } }
            if (name === './pluginHotkeys') { return pluginHotkeys }
            if (name === './shortcutManager') { return shortcutManager }
            return {}
        },
        setTimeout: (run: () => void, delay: number): number => {
            const id = nextTimer++
            timers.set(id, { at: now + delay, run })
            return id
        },
        clearTimeout: (id: number): void => { timers.delete(id) },
    }
    ;(sandbox as any).window = { setTimeout: (run: () => void): number => { run(); return 0 } }
    vm.runInNewContext(compiled.outputText, sandbox)
    const Settings = sandbox.exports.QuickCommandsSettingsTabComponent
    const template = Settings.testMetadata.template as string
    const styles = (Settings.testMetadata.styles as string[]).join('\n')
    const settingsListRule = styles.match(/\.wqc-settings-list \{([^}]*)\}/)?.[1] || ''
    assert.ok(template.includes('class="wqc-help-tooltip wqc-config-message-tooltip"'), 'message details must reuse the shared help tooltip style')
    assert.ok(!template.includes('[attr.title]="configMessageDetail'), 'message details must not use the native browser tooltip')
    assert.ok(template.includes('[attr.tabindex]="configMessageDetail ? 0 : null"'), 'details must be reachable by keyboard only when present')
    assert.ok(template.includes('[attr.aria-describedby]="configMessageDetail ? \'wqc-config-message-detail\' : null"'), 'the detail trigger must reference its tooltip')
    assert.ok(template.indexOf('class="wqc-back-to-top"') < template.indexOf('>更新历史</button>'), 'Back to top must sit to the left of update history')
    assert.ok(template.indexOf('wqc-update-now') < template.indexOf('class="wqc-update-expand"'), 'Update now must sit to the left of the expand control')
    assert.ok(template.includes('class="wqc-update-button-hint" *ngIf="!updateDetailsExpanded"'), 'the inline update action must disappear when details expand')
    assert.ok(template.includes('class="wqc-hotkey-summary-row"'), 'shortcut settings must use a compact one-line summary')
    assert.ok(template.includes('class="wqc-config-dialog wqc-hotkey-dialog"'), 'shortcut management must open in a dedicated dialog')
    assert.ok(!template.includes('集中管理插件操作和命令快捷键，修改完成后统一保存。'), 'the shortcut dialog must not retain the redundant subtitle')
    assert.ok(template.includes('class="wqc-help wqc-hotkey-rules"') && template.indexOf('wqc-hotkey-rules') < template.indexOf('wqc-hotkey-dialog-close'), 'shortcut rules must appear beside and before the close button')
    assert.ok(template.includes('F1–F24 可以单独绑定，也可以与 Shift、Ctrl、Alt 或 Meta 组合。') && template.includes('不支持仅用 Shift 与普通键组合。'), 'shortcut rules must distinguish Shift plus function keys from Shift-only regular-key combinations')
    assert.ok(!template.includes('录制器每次录入一个单段组合') && !template.includes('多段快捷键会继续保留'), 'shortcut rules must omit internal key-sequence compatibility details')
    assert.ok(template.includes('切换焦点还可以单独使用 Escape。') && !template.includes('只按修饰键不会完成录制'), 'shortcut rules must keep the Escape exception without redundant capture behavior')
    assert.ok(template.includes('class="wqc-hotkey-table"'), 'the shortcut dialog must compare every action in one compact table')
    assert.ok(template.includes('class="form-control wqc-hotkey-search-input"'), 'the shortcut dialog must provide a search field')
    assert.ok(template.includes('class="wqc-hotkey-search-field"') && template.indexOf('wqc-hotkey-search-input') < template.indexOf('wqc-hotkey-restore-all'), 'Restore default must sit to the right of shortcut search')
    assert.ok(template.includes('let item of filteredPluginHotkeyDefinitions'), 'the shortcut table must render filtered plugin actions')
    assert.ok(template.includes('class="wqc-hotkey-group-row wqc-command-hotkey-group"'), 'command shortcuts must be separated from plugin actions')
    assert.ok(template.includes('class="wqc-hotkey-group-toggle"'), 'the command shortcut group must use a compact expandable header')
    assert.ok(template.includes('class="wqc-hotkey-group-toggle-action"') && template.includes("commandHotkeySectionExpanded ? '收起' : '展开'"), 'the command shortcut toggle must label its current action before the chevron')
    assert.ok(template.includes('<ng-container *ngIf="commandHotkeyRowsVisible">'), 'command shortcut rows must be collapsible')
    assert.ok(template.includes('let command of filteredCommandHotkeyCommands'), 'the shortcut dialog must list command shortcuts from the command data source')
    assert.ok(template.includes('(click)="startCommandHotkeyCapture(command.id, $event)"'), 'command shortcuts must be editable in the shortcut dialog')
    assert.equal((template.match(/class="wqc-hotkey-capture-preview"/g) || []).length, 2, 'plugin and command shortcut rows must share the live capture preview')
    assert.equal((template.match(/aria-live="polite"/g) || []).length, 2, 'live shortcut previews must announce pressed keys accessibly')
    assert.ok(template.includes("recordingHotkeyAction === item.action ? '录制中…' : '添加'") && template.includes("recordingCommandHotkeyId === command.id ? '录制中…'"), 'recording action buttons must expose the active capture state')
    assert.ok(template.includes('(click)="openCommandFromHotkeyDialog(command.id)"'), 'command shortcut rows must provide an open-command action')
    assert.ok(!template.includes('class="wqc-hotkey-card"'), 'the old always-expanded shortcut cards must be removed')
    assert.ok(!template.includes('修改后立即保存') && !template.includes('wqc-hotkey-dialog-actions'), 'shortcut settings must not retain the redundant immediate-save footer')
    assert.ok(!template.includes('(click)="savePluginHotkeyDialog()"') && !template.includes('(click)="closePluginHotkeyDialog()">取消</button>'), 'shortcut settings must not expose obsolete Save or Cancel actions')
    assert.ok(template.includes('<div class="wqc-update-actions">\n                <span class="wqc-update-button-hint"'), 'expanded details must retain the original primary and secondary action layout')
    assert.ok(template.includes('<button class="btn btn-secondary" type="button" [disabled]="updateState.ignored"'), 'expanded details must retain the ignore-update action beside Update now')
    assert.equal((template.match(/class="wqc-help-tooltip wqc-update-disabled-tooltip"/g) || []).length, 2, 'both disabled Update now buttons must reuse the shared tooltip style')
    assert.ok(!template.includes('[attr.title]="updateInstallDisabledHint'), 'disabled Update now hints must not use inconsistent native browser tooltips')
    assert.equal((template.match(/\[attr\.tabindex\]="updateInstallDisabledHint \? 0 : null"/g) || []).length, 2, 'disabled Update now hints must also be keyboard reachable')
    assert.ok(styles.includes('.wqc-update-button-hint:hover .wqc-update-disabled-tooltip') && styles.includes('.wqc-update-button-hint:focus-within .wqc-update-disabled-tooltip'), 'disabled Update now hints must share hover and focus behavior')
    assert.ok(styles.includes('.wqc-update-actions .wqc-update-disabled-tooltip {') && styles.includes('left: 0;\n        right: auto;'), 'the expanded Update now hint must open to the right instead of clipping on the left')
    assert.ok(styles.includes('.wqc-update-now:hover:not(:disabled)') && styles.includes('.wqc-update-now:active:not(:disabled)'), 'collapsed Update now must provide hover and pressed feedback')
    assert.ok(styles.includes('.wqc-update-now-expanded:hover:not(:disabled)') && styles.includes('.wqc-update-now-expanded:active:not(:disabled)'), 'expanded Update now must provide hover and pressed feedback')
    assert.ok(styles.includes('.wqc-hotkey-row-actions .btn {') && styles.includes('justify-content: center;'), 'shortcut edit button labels must be centered')
    assert.ok(styles.includes('table-layout: fixed;') && styles.includes('.wqc-hotkey-table thead th:nth-child(4) { width: 12%; }'), 'the shortcut table must enforce deterministic column widths')
    assert.ok(styles.includes('.wqc-hotkey-table thead th:nth-child(1) { width: 30%; }') && styles.includes('.wqc-hotkey-table thead th:nth-child(3) { width: 20%; }'), 'function and current-shortcut columns must use visibly reduced fixed widths')
    assert.ok(styles.includes('.wqc-hotkey-table th.wqc-hotkey-action-column {') && styles.includes('.wqc-hotkey-row-actions {\n        justify-content: center;'), 'the shortcut action header and controls must be centered')
    assert.ok(styles.includes('.wqc-hotkey-table th,\n      .wqc-hotkey-table td {') && styles.includes('text-align: center;'), 'shortcut table headers and cells must be centered')
    assert.equal((template.match(/class="wqc-hotkey-function-content"/g) || []).length, 2, 'plugin and command function text must share the centered alignment container')
    assert.ok(styles.includes('.wqc-hotkey-function-content {') && styles.includes('width: calc(100% - 16px);') && styles.includes('margin: 0 auto;') && styles.includes('text-align: left;'), 'function text groups must use one centered inset width so every row shares the same left edge')
    assert.ok(styles.includes('.wqc-hotkey-bindings {\n        justify-content: center;'), 'multiple shortcut bindings must remain centered within the shortcut column')
    assert.ok(styles.includes('.wqc-hotkey-capture-preview {') && styles.includes('.wqc-hotkey-binding-captured {'), 'shortcut capture must provide live and completed visual feedback')
    assert.ok(!styles.includes('.wqc-hotkey-debug-columns'), 'temporary shortcut column guides must be removed after spacing review')
    assert.ok(template.includes('class="wqc-hotkey-conflict-detail"') && template.includes('class="wqc-help-tooltip wqc-hotkey-conflict-tooltip"'), 'conflict rows must use a compact label with an accessible detail control')
    assert.equal((template.match(/class="wqc-hotkey-conflict-detail"/g) || []).length, 2, 'plugin and command conflicts must share the detail control')
    assert.ok(template.includes('class="wqc-hotkey-command-floating-tooltip"') && !template.includes('[attr.title]="hotkeyDialogDirty'), 'open-command help must use a floating custom tooltip outside the scrollable table')
    assert.ok(template.includes('(mouseenter)="showHotkeyCommandTooltip($event)"') && template.includes('(scroll)="hideHotkeyCommandTooltip()"'), 'open-command help must track pointer focus and dismiss when the table scrolls')
    assert.ok(styles.includes('.wqc-hotkey-command-floating-tooltip {') && styles.includes('position: fixed;') && styles.includes('z-index: 1100;'), 'open-command help must escape table clipping in a fixed overlay layer')
    assert.ok(template.includes('<h4>操作与输入</h4>') && !template.includes('<h4>交互与焦点</h4>'), 'input behavior must use plain-language terminology instead of focus jargon')
    assert.ok(source.includes('this.pluginHotkeyDraftDirty') && source.includes('this.reloadPluginHotkeyDraft()') && source.includes('this.commandHotkeyDraftDirty') && source.includes('this.reloadCommandHotkeyDraft()'), 'external configuration changes must refresh open shortcut-dialog drafts')
    assert.ok(template.includes('<span class="wqc-setting-label">打开抽屉后输入位置</span>') && template.includes('<span class="wqc-setting-label">发送命令后输入位置</span>') && template.includes('<span class="wqc-setting-label">快捷键提示</span>'), 'input settings must use the requested concise labels')
    assert.ok(!template.includes('<span class="wqc-setting-label">打开抽屉后</span>') && !template.includes('<span class="wqc-setting-label">发送命令后</span>') && !template.includes('<span class="wqc-setting-label">键盘操作与输入位置提示</span>'), 'obsolete input setting labels must be removed')
    assert.equal((template.match(/class="wqc-segmented"/g) || []).length, 6, 'input and confirmation behavior must use six consistent segmented controls')
    assert.ok(template.includes('setInitialFocusValue(\'drawer\')') && template.includes("setBooleanValue('confirmBroadcast', true)"), 'segmented controls must persist their explicit values directly')
    assert.ok(template.indexOf('wqc-config-section') < template.indexOf('openExportPluginConfig()') && template.indexOf('openExportPluginConfig()') < template.indexOf('wqc-hotkey-section'), 'configuration export entry must remain in the plugin configuration section')
    assert.ok(!template.includes('class="wqc-settings-list wqc-config-options"'), 'export filename must not occupy a permanent settings row')
    assert.ok(template.includes('*ngIf="exportConfigDialogOpen"') && template.includes('class="wqc-config-dialog wqc-export-dialog"'), 'configuration export must open a dedicated filename dialog')
    assert.ok(template.includes('(click)="openExportPluginConfig()"') && template.includes('(click)="confirmExportPluginConfig()"'), 'configuration export must separate opening the dialog from confirming the download')
    assert.ok(template.includes("<code data-i18n-skip>{{ '{date}' }}</code>") && !template.includes('；{date}'), 'the date placeholder must be escaped for Angular JIT templates')
    assert.ok(template.indexOf('<h4>操作与输入</h4>') < template.indexOf('面板宽度') && template.indexOf('面板宽度') < template.indexOf('<h4>执行</h4>'), 'drawer width must live under operation and input')
    assert.ok(template.includes('确认与安全') && template.includes('不额外确认') && template.includes('始终确认') && !template.includes('>按普通规则</button>'), 'broadcast confirmation settings must read as explicit choices')
    assert.ok(template.includes('aria-label="查看按需确认说明"') && template.includes('选择“按需”时，依旧会触发“高风险命令保护”和“发送到所有会话”规则。'), 'as-needed execution confirmation must explain which independent rules still apply')
    assert.ok(settingsListRule.includes('display: flex;') && settingsListRule.includes('flex-direction: column;') && settingsListRule.includes('overflow: visible;') && !/background\s*:|border(?:-radius)?\s*:/.test(settingsListRule), 'setting lists must use a borderless one-setting-per-row layout')
    const settingRowRule = styles.match(/\.wqc-setting-row \{([^}]*)\}/)?.[1] || ''
    assert.ok(settingRowRule.includes('grid-template-columns: minmax(190px, 240px) minmax(280px, 420px);') && settingRowRule.includes('min-height: 44px;') && !/border(?:-bottom)?\s*:/.test(settingRowRule), 'setting rows must align labels and controls compactly without separators')
    assert.ok(template.includes('class="wqc-settings-subgrid"') && styles.includes('.wqc-settings-subgrid {\n        display: block;'), 'line execution and advanced settings must remain vertically grouped')
    assert.ok(styles.includes('.wqc-setting-row:hover {') && styles.includes('.wqc-setting-row:focus-within {'), 'setting rows must use hover and active-field tint instead of static dividers')
    assert.equal((template.match(/type="number"/g) || []).length, 3, 'settings must expose the expected three numeric inputs')
    assert.equal((template.match(/wqc-number-input/g) || []).length, 3, 'all settings numeric inputs must share one visual treatment')
    assert.equal((template.match(/\(wheel\)="releaseNumberWheel\(\$event\)"/g) || []).length, 3, 'all settings numeric inputs must release focus before wheel scrolling')
    assert.ok(template.includes('step="20" title=""'), 'drawer width must suppress native hover text while retaining numeric constraints')
    assert.ok(styles.includes('.wqc-number-input::-webkit-inner-spin-button,') && styles.includes('-moz-appearance: textfield;'), 'all settings numeric inputs must hide native browser steppers')
    const drawerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'quickCommands.service.ts'), 'utf8')
    const drawerStyles = fs.readFileSync(path.join(process.cwd(), 'src', 'quickCommands.css'), 'utf8')
    assert.equal((drawerSource.match(/<input[^>\n]+type="number"/g) || []).length, 3, 'drawer must expose the expected three numeric inputs')
    assert.ok(drawerSource.includes('this.bindNumberInputWheel(this.root)') && drawerSource.includes("element.addEventListener('wheel', () => element.blur(), { passive: true })"), 'drawer numeric inputs must blur without consuming page wheel scrolling')
    assert.ok(!drawerSource.includes('const direction = event.deltaY < 0 ? 1 : -1') && drawerSource.includes("event.key === 'ArrowUp' || event.key === 'ArrowDown'"), 'line delay must remove wheel stepping while retaining keyboard stepping')
    assert.ok(drawerStyles.includes('.tqc-input[type="number"]::-webkit-inner-spin-button,') && drawerStyles.includes('-moz-appearance: textfield;'), 'all drawer numeric inputs must hide native browser steppers')
    assert.equal((template.match(/class="wqc-help wqc-setting-help"/g) || []).length, 3, 'all long setting help messages must use viewport-safe placement')
    assert.ok(styles.includes('.wqc-setting-help {\n        position: static;') && styles.includes('left: 8px;\n        right: auto;') && styles.includes('width: min(420px, calc(100vw - 64px));'), 'setting help must align to the row instead of overflowing to the left of its icon')
    assert.ok(styles.includes('.wqc-segmented button.wqc-selected {'), 'segmented controls must retain a clear selected state after removing list cards')
    assert.ok(styles.includes('@media (max-width: 760px)') && styles.includes('grid-template-columns: minmax(150px, 200px) minmax(0, 1fr);') && styles.includes('@media (max-width: 520px)') && styles.includes('grid-template-columns: minmax(0, 1fr);\n          row-gap: 6px;'), 'setting rows must narrow their label column and stack on small screens')
    assert.ok(template.includes('class="wqc-update-card-check"'), 'the original top update check and status must remain available')
    assert.ok(template.includes('*ngIf="showUpdateCheckStatus && updateStatusLabel"'), 'manual update status must stay hidden until requested')
    assert.ok(template.includes('(click)="dismissUpdateCheckStatus()"'), 'manual update status must provide a dismiss control')

    let finishUpdateCheck: (() => void) | undefined
    const updateCheck = new Promise<void>(resolve => { finishUpdateCheck = resolve })
    let updateCheckChanges = 0
    const updateStatusSettings: any = Object.create(Settings.prototype)
    Object.assign(updateStatusSettings, {
        showUpdateCheckStatus: false,
        updateCheckStatusTimer: null,
        pluginUpdate: { checkNow: () => updateCheck },
        changeDetector: { detectChanges: () => updateCheckChanges++ },
    })
    updateStatusSettings.checkForUpdates()
    assert.equal(updateStatusSettings.showUpdateCheckStatus, false, 'the original top check must not reveal the bottom temporary status')
    assert.equal(timers.size, 0, 'the original top check must not start a temporary-status timer')
    updateStatusSettings.checkForUpdatesWithStatus()
    assert.equal(updateStatusSettings.showUpdateCheckStatus, true, 'manual checks must reveal their status immediately')
    assert.equal(timers.size, 0, 'the expiry countdown must wait for the query to finish')
    finishUpdateCheck!()
    await updateCheck
    await Promise.resolve()
    assert.equal(timers.size, 1, 'a completed query must start one status expiry countdown')
    advance(29_999)
    assert.equal(updateStatusSettings.showUpdateCheckStatus, true, 'completed status must remain visible for 30 seconds')
    advance(1)
    assert.equal(updateStatusSettings.showUpdateCheckStatus, false)
    assert.equal(updateStatusSettings.updateCheckStatusTimer, null)
    assert.equal(updateCheckChanges, 1, 'status expiry must update the view')

    updateStatusSettings.showUpdateCheckStatus = true
    updateStatusSettings.updateCheckStatusTimer = setTimeout(() => undefined, 30_000)
    updateStatusSettings.dismissUpdateCheckStatus()
    assert.equal(updateStatusSettings.showUpdateCheckStatus, false)
    assert.equal(timers.size, 0, 'manual dismissal must cancel status expiry')

    const disabledHintSettings: any = Object.create(Settings.prototype)
    Object.assign(disabledHintSettings, {
        pluginUpdate: { canInstallUpdate: false },
        updateState: { status: 'available' },
        i18n: { text: (text: string) => text },
    })
    assert.ok(disabledHintSettings.updateInstallDisabledHint.includes('Dev'), 'Dev builds must explain why online update is disabled')
    disabledHintSettings.pluginUpdate.canInstallUpdate = true
    disabledHintSettings.updateState.status = 'installing'
    assert.ok(disabledHintSettings.updateInstallDisabledHint.includes('正在安装'))
    disabledHintSettings.updateState.status = 'restart'
    assert.ok(disabledHintSettings.updateInstallDisabledHint.includes('重启 Tabby'))
    disabledHintSettings.updateState.status = 'available'
    assert.equal(disabledHintSettings.updateInstallDisabledHint, '', 'enabled update buttons must not show a disabled-state hint')
    const clone = (value: any): any => JSON.parse(JSON.stringify(value))
    const hotkeyEvent = (key: string, modifiers: Record<string, boolean> = {}): any => ({
        key,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        preventDefault: () => undefined,
        stopImmediatePropagation: () => undefined,
        ...modifiers,
    })

    for (const language of ['zh-CN', 'en']) {
        let saved: any = { commands: [], exportFileName: 'original' }
        let failSave = false
        let changes = 0
        let openedCommandId = ''
        let downloadedFileName = ''
        let hotkeyDisableCount = 0
        let hotkeyEnableCount = 0
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
            changeDetector: { detectChanges: () => changes++, markForCheck: () => undefined },
            tabbyConfig: { store: { hotkeys: {} }, save: async () => undefined },
            hotkeys: {
                disable: () => { hotkeyDisableCount++ },
                enable: () => { hotkeyEnableCount++ },
            },
            quickCommands: { openCommand: (commandId: string) => { openedCommandId = commandId } },
            element: { nativeElement: { querySelector: () => null } },
            subscriptions: { unsubscribe: () => undefined },
            stopLocalizing: null,
            downloadJson: (_text: string, fileName: string) => { downloadedFileName = fileName },
            exportConfigDialogOpen: false,
            exportFileNameDraft: '',
            pluginHotkeyDialogOpen: false,
            pluginHotkeySaving: false,
            pluginHotkeyDialogError: '',
            pluginHotkeySearchQuery: '',
            commandHotkeySectionExpanded: false,
            recordingHotkeyAction: null,
            recordingCommandHotkeyId: null,
            recordingPressedKeys: [],
            recordingPressedKeyMap: new Map<string, string>(),
            recordingShortcutCandidate: '',
            recordingShortcutAttempted: false,
            recordingPrimaryKeyId: '',
            recentlyCapturedHotkey: null,
            capturedHotkeyTimer: null,
            pluginHotkeyDraft: null,
            commandHotkeyDraft: null,
        })

        settings.setInitialFocusValue('terminal')
        settings.setBooleanValue('focusTerminalAfterSend', true)
        assert.equal(saved.drawerInitialFocus, 'terminal', 'segmented focus choice must save immediately')
        assert.equal(saved.focusTerminalAfterSend, true, 'segmented boolean choice must save immediately')

        settings.openPluginHotkeyDialog()
        assert.equal(settings.pluginHotkeyDialogOpen, true)
        assert.equal(settings.configuredPluginHotkeyActionCount, 2, 'the compact summary must count configured default actions')
        assert.equal(settings.commandHotkeyRowsVisible, false, 'command shortcut rows must be collapsed whenever the dialog opens')
        settings.setPluginHotkeySearch({ target: { value: '提示' } })
        assert.deepEqual(settings.filteredPluginHotkeyDefinitions.map((item: any) => item.action), ['toggleHints'], 'shortcut search must match action titles')
        settings.clearPluginHotkeySearch()
        assert.equal(settings.filteredPluginHotkeyDefinitions.length, 4, 'clearing shortcut search must restore every plugin action')
        await settings.clearPluginHotkey('switchFocus')
        assert.equal(settings.getPluginHotkeys('switchFocus').length, 0)
        assert.deepEqual(pluginHotkeys.readPluginHotkeyBindings(settings.tabbyConfig.store.hotkeys, 'switchFocus'), [], 'Clear must save plugin shortcuts immediately')
        assert.equal(settings.pluginHotkeyDraftDirty, false)
        settings.closePluginHotkeyDialog()
        assert.equal(settings.pluginHotkeyDialogOpen, false)
        assert.deepEqual(pluginHotkeys.readPluginHotkeyBindings(settings.tabbyConfig.store.hotkeys, 'switchFocus'), [], 'closing must retain immediately saved changes')

        const toggleHotkeyId = pluginHotkeys.getPluginHotkeyDefinition('toggleDrawer').id
        settings.tabbyConfig.store.hotkeys[toggleHotkeyId] = 'Ctrl-Alt-Z'
        settings.openPluginHotkeyDialog()
        assert.deepEqual(settings.getPluginHotkeys('toggleDrawer'), ['Ctrl+Alt+Z'], 'the shortcut dialog must preserve valid scalar Tabby hotkey configuration')
        settings.tabbyConfig.store.hotkeys[toggleHotkeyId] = 'Ctrl-Alt-W'
        assert.equal(settings.pluginHotkeyDraftDirty, true, 'an external Tabby hotkey change must make the open draft stale')
        settings.reloadPluginHotkeyDraft()
        assert.deepEqual(settings.getPluginHotkeys('toggleDrawer'), ['Ctrl+Alt+W'], 'reloading after an external Tabby change must replace the stale draft')
        assert.equal(settings.pluginHotkeyDraftDirty, false)
        settings.closePluginHotkeyDialog()

        pluginHotkeys.writeTabbyHotkeyBindings(
            settings.tabbyConfig.store.hotkeys,
            pluginHotkeys.getPluginHotkeyDefinition('openSettings').id,
            [],
        )
        settings.openPluginHotkeyDialog()
        settings.startPluginHotkeyCapture('openSettings', { stopPropagation: () => undefined })
        assert.equal(hotkeyDisableCount, 1, 'recording must suspend Tabby hotkey actions')
        settings.capturePluginHotkey(hotkeyEvent('Control', { ctrlKey: true }))
        settings.capturePluginHotkey(hotkeyEvent('p', { ctrlKey: true }))
        await settings.finishPluginHotkeyKey(hotkeyEvent('p', { ctrlKey: true }))
        assert.equal(hotkeyEnableCount, 1, 'finishing recording must resume Tabby hotkey actions')
        assert.equal(settings.pluginHotkeyDraftDirty, false, 'recorded settings shortcuts must be persisted immediately')
        settings.getPluginHotkeyConflict('openSettings', 'Ctrl+P')
        assert.deepEqual(
            pluginHotkeys.readTabbyHotkeyBindings(
                settings.tabbyConfig.store.hotkeys,
                pluginHotkeys.getPluginHotkeyDefinition('openSettings').id,
            ),
            ['Ctrl+P'],
            'recording must immediately save the nested settings-tab shortcut',
        )
        assert.equal(settings.pluginHotkeyDraftDirty, false, 'rendering conflict status must not create unsaved changes')
        settings.closePluginHotkeyDialog()

        settings.openPluginHotkeyDialog()
        await settings.clearPluginHotkey('switchFocus')
        assert.equal(settings.pluginHotkeyDraftIsDefault, false)
        await settings.resetAllPluginHotkeys()
        assert.equal(settings.pluginHotkeyDraftIsDefault, true, 'Restore default must save the default plugin shortcuts immediately')
        settings.startPluginHotkeyCapture('toggleDrawer', { stopPropagation: () => undefined })
        settings.capturePluginHotkey(hotkeyEvent('Control', { ctrlKey: true }))
        settings.capturePluginHotkey(hotkeyEvent('Enter', { ctrlKey: true }))
        await settings.finishPluginHotkeyKey(hotkeyEvent('Enter', { ctrlKey: true }))
        assert.equal(settings.recordingHotkeyAction, null, 'drawer-reserved shortcuts must end capture without being saved')
        assert.equal(settings.getPluginHotkeys('toggleDrawer').length, 0, 'drawer-reserved shortcuts must not be assigned to plugin actions')
        assert.ok(settings.pluginHotkeyDialogError.includes(language === 'en' ? 'drawer action' : '抽屉操作'), 'drawer-reserved shortcut failures must explain the conflict')
        settings.startPluginHotkeyCapture('toggleDrawer', { stopPropagation: () => undefined })
        settings.capturePluginHotkey(hotkeyEvent('Shift', { shiftKey: true }))
        settings.capturePluginHotkey({ ...hotkeyEvent('Shift', { shiftKey: true }), repeat: true })
        assert.deepEqual(settings.recordingPressedKeys, ['Shift'], 'repeated keydown events must not duplicate the live preview')
        await settings.finishPluginHotkeyKey(hotkeyEvent('Shift'))
        assert.equal(settings.recordingHotkeyAction, 'toggleDrawer', 'releasing modifier-only input must keep capture active')
        assert.deepEqual(settings.recordingPressedKeys, [])
        settings.capturePluginHotkey(hotkeyEvent('Control', { ctrlKey: true }))
        settings.resetPressedHotkeysOnBlur()
        assert.equal(settings.recordingHotkeyAction, 'toggleDrawer', 'window blur must clear stuck keys without canceling capture')
        assert.deepEqual(settings.recordingPressedKeys, [])
        settings.capturePluginHotkey(hotkeyEvent('x'))
        await settings.finishPluginHotkeyKey(hotkeyEvent('x'))
        assert.equal(settings.recordingHotkeyAction, 'toggleDrawer', 'invalid input must keep capture active for another attempt')
        assert.ok(settings.pluginHotkeyDialogError, 'invalid input must report the existing shortcut rule')
        let hotkeyEventStopped = false
        settings.capturePluginHotkey(hotkeyEvent('Control', { ctrlKey: true }))
        assert.deepEqual(settings.recordingPressedKeys, ['Ctrl'])
        settings.capturePluginHotkey(hotkeyEvent('Alt', { ctrlKey: true, altKey: true }))
        assert.deepEqual(settings.recordingPressedKeys, ['Ctrl', 'Alt'])
        settings.capturePluginHotkey({
            ...hotkeyEvent('y', { ctrlKey: true, altKey: true }),
            stopImmediatePropagation: () => { hotkeyEventStopped = true },
        })
        assert.equal(hotkeyEventStopped, true)
        assert.deepEqual(settings.recordingPressedKeys, ['Ctrl', 'Alt', 'Y'], 'keydown must update the live shortcut preview')
        assert.equal(settings.getPluginHotkeys('toggleDrawer').length, 0, 'keydown must not update the shortcut draft before the primary key is released')
        await settings.finishPluginHotkeyKey(hotkeyEvent('y', { ctrlKey: true, altKey: true }))
        assert.deepEqual(settings.recordingPressedKeys, [], 'primary-key release must clear held modifier state without waiting for modifier keyup')
        assert.equal(settings.getPluginHotkeys('toggleDrawer')[0], 'Ctrl+Alt+Y')
        assert.equal(settings.recordingHotkeyAction, null)
        assert.equal(settings.isRecentlyCapturedPluginHotkey('toggleDrawer', 'Ctrl+Alt+Y'), true)
        assert.equal(settings.pluginHotkeyDialogOpen, true, 'immediate saving must keep the shortcut dialog open')
        assert.deepEqual(
            settings.tabbyConfig.store.hotkeys[pluginHotkeys.getPluginHotkeyDefinition('toggleDrawer').id],
            ['Ctrl-Alt-Y'],
            'recording must immediately serialize the shortcut in Tabby native format',
        )
        assert.equal(hotkeyDisableCount, hotkeyEnableCount, 'every recording session must restore Tabby hotkey handling')
        settings.closePluginHotkeyDialog()

        settings.root.commands = [{ id: 'command-1', name: 'Deploy', description: 'Ship app', command: 'echo deploy', category: '默认', shortcut: '' }]
        settings.savedConfigSnapshot = JSON.stringify(settings.root)
        settings.openPluginHotkeyDialog()
        assert.equal(settings.commandHotkeyRowsVisible, false, 'command shortcuts must default to collapsed')
        saved = clone(settings.root)
        saved.commands[0].shortcut = 'F9'
        settings.refreshPluginConfig()
        assert.equal(settings.getCommandHotkey('command-1'), 'F9', 'external command updates must replace a stale open shortcut draft')
        saved.commands[0].shortcut = ''
        settings.refreshPluginConfig()
        assert.equal(settings.getCommandHotkey('command-1'), '', 'subsequent external command updates must continue to synchronize')
        settings.setPluginHotkeySearch({ target: { value: 'Deploy' } })
        assert.equal(settings.commandHotkeyRowsVisible, true, 'searching must temporarily reveal matching command shortcuts')
        assert.deepEqual(settings.filteredCommandHotkeyCommands.map((command: any) => command.id), ['command-1'], 'shortcut search must include command shortcuts')
        settings.clearPluginHotkeySearch()
        assert.equal(settings.commandHotkeyRowsVisible, false, 'clearing search must restore the collapsed state')
        const originalConflictSource = settings.getPluginHotkeyConflictSource.bind(settings)
        let conflictSourceBuilds = 0
        settings.getPluginHotkeyConflictSource = () => {
            conflictSourceBuilds++
            return originalConflictSource()
        }
        settings.invalidateHotkeyConflictCache()
        void settings.hotkeyConflictCount
        void settings.hotkeyConflictCount
        assert.equal(conflictSourceBuilds, 1, 'repeated change detection must reuse the indexed shortcut-conflict cache')
        settings.setCommandHotkeyDraft('command-1', 'Ctrl+Alt+E')
        void settings.hotkeyConflictCount
        assert.equal(conflictSourceBuilds, 2, 'changing a shortcut draft must invalidate the conflict cache once')
        settings.setCommandHotkeyDraft('command-1', '')
        settings.toggleCommandHotkeySection()
        assert.equal(settings.commandHotkeyRowsVisible, true, 'clicking the command shortcut header must expand its rows')
        settings.startCommandHotkeyCapture('command-1', { stopPropagation: () => undefined })
        settings.capturePluginHotkey(hotkeyEvent('Control', { ctrlKey: true }))
        settings.capturePluginHotkey(hotkeyEvent('Alt', { ctrlKey: true, altKey: true }))
        settings.capturePluginHotkey(hotkeyEvent('d', { ctrlKey: true, altKey: true }))
        assert.equal(settings.getCommandHotkey('command-1'), '', 'command shortcut capture must also wait for primary-key keyup')
        await settings.finishPluginHotkeyKey(hotkeyEvent('d', { ctrlKey: true, altKey: true }))
        assert.equal(settings.getCommandHotkey('command-1'), 'Ctrl+Alt+D')
        assert.equal(settings.isRecentlyCapturedCommandHotkey('command-1', 'Ctrl+Alt+D'), true)
        assert.equal(settings.root.commands[0].shortcut, 'Ctrl+Alt+D', 'command shortcut recording must update the live data immediately')
        assert.equal(saved.commands[0].shortcut, 'Ctrl+Alt+D', 'command shortcut recording must persist immediately')
        await settings.openCommandFromHotkeyDialog('command-1')
        assert.equal(openedCommandId, 'command-1', 'the command shortcut row must be able to open its command')

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

        settings.pendingConfigImport = { config: {
            commands: [],
            exportFileName: 'imported',
            pluginHotkeys: {
                version: 1,
                actions: { toggleDrawer: ['Ctrl+Alt+Q'], openSettings: ['F8'], switchFocus: ['Escape'], toggleHints: ['Ctrl+Alt+H'] },
            },
        } }
        await settings.importPendingFullConfig()
        assert.equal(settings.configMessage, '导入成功')
        assert.equal(settings.pendingConfigImport, null)
        assert.equal(saved.exportFileName, 'imported')
        assert.equal(saved.pluginHotkeys, undefined, 'Tabby action hotkeys must not be duplicated in plugin-internal storage')
        assert.deepEqual(
            settings.tabbyConfig.store.hotkeys[pluginHotkeys.getPluginHotkeyDefinition('toggleDrawer').id],
            ['Ctrl-Alt-Q'],
            'full config import must update the shared Tabby hotkey configuration',
        )
        assert.deepEqual(
            settings.tabbyConfig.store.hotkeys['settings-tab']['windy-quick-commands'],
            ['F8'],
            'full config import must update Tabby\'s standard settings-tab shortcut path',
        )
        settings.setBooleanValue('showOperationHints', false)
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
        await settings.importPendingFullConfig()
        assert.equal(settings.configMessage, '导入失败')
        assert.ok(settings.configMessageDetail.includes('Disk full'))
        assert.equal(settings.pendingConfigImport, pending, 'failed imports must remain retryable')
        assert.equal(saved.exportFileName, 'imported', 'failed imports must not report success or replace saved data')
        settings.pendingConfigImport = { commands: [], customCategories: [], categoryOrder: [], version: 1 }
        settings.importPendingCommands()
        assert.equal(settings.configMessage, '导入失败')
        failSave = false

        settings.setNumber('drawerWidth', { target: { value: '740' } }, 420, 760)
        let numberInputBlurred = 0
        settings.releaseNumberWheel({ currentTarget: { blur: () => { numberInputBlurred++ } } })
        assert.equal(numberInputBlurred, 1, 'wheel handling must release numeric input focus without changing its value')
        const beforeRestore = clone(saved)
        settings.openResetDefaultsConfirm()
        failSave = true
        await settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '恢复失败')
        assert.ok(settings.configMessageDetail.includes('Disk full'))
        assert.equal(settings.resetDefaultsConfirmOpen, false, 'restore results must not be hidden behind the confirmation dialog')
        assert.deepEqual(saved, beforeRestore, 'failed restore must preserve saved settings and commands')
        assert.deepEqual(clone(settings.root), beforeRestore, 'failed restore must roll back displayed settings')
        assert.equal(translatePluginText(settings.configMessage, language), language === 'en' ? 'Restore failed' : '恢复失败')

        failSave = false
        settings.openResetDefaultsConfirm()
        await settings.restoreDefaultSettings()
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

        await settings.restoreDefaultSettings()
        assert.equal(settings.configMessage, '', 'restore must still require confirmation')
        settings.openResetDefaultsConfirm()
        settings.openResetInitialConfirm()
        await settings.restoreDefaultSettings()
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

        settings.openExportPluginConfig()
        assert.equal(settings.exportConfigDialogOpen, true)
        assert.equal(settings.exportFileNameDraft, saved.exportFileName, 'export dialog must prefill the saved filename')
        settings.setExportFileNameDraft({ target: { value: 'settings-backup-{date}' } })
        settings.confirmExportPluginConfig()
        assert.equal(settings.exportConfigDialogOpen, false)
        assert.equal(saved.exportFileName, 'settings-backup-{date}', 'confirming export must remember the filename')
        assert.match(downloadedFileName, /^settings-backup-\d{4}-\d{2}-\d{2}\.json$/, 'configuration download must render the saved date placeholder')
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
