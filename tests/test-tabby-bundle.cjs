// Compare real stable/dev bundles with host API stubs; no real profile, network or plugin installation is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const { ReplaySubject, Subject } = require('rxjs')
const clone = value => JSON.parse(JSON.stringify(value))

function loadBundle (bundlePath, liveNetwork = false, document = { addEventListener () {} }) {
    class TestNode {}
    class TestElement extends TestNode {}
    class TestHTMLElement extends TestElement {}
    class TestInputElement extends TestHTMLElement {}
    class TestTextAreaElement extends TestHTMLElement {}
    const hostListeners = []
    const events = []
    const windowListeners = new Map()
    const networkRequests = []
    const networkGate = {
        wait: null,
        latestVersion: '9.0.0',
        registryStatus: 200,
        historyVersions: { '9.0.0': '2026-08-27T00:00:00Z' },
        npmRegistryStatus: null,
        mirrorRegistryStatus: null,
        mirrorLatestVersion: null,
        mirrorHistoryVersions: null,
        jsdelivrStatus: 200,
        mirrorFilesStatus: 200,
        registryThrownFailures: 0,
        registryThrownError: null,
    }
    const core = { ConfigProvider: class {}, HotkeyProvider: class {}, ToolbarButtonProvider: class {}, HotkeysService: class {} }
    const settings = { SettingsTabProvider: class {} }
    const captureMetadata = metadata => target => { target.testMetadata = metadata; return target }
    const angular = {
        NgModule: captureMetadata, Component: captureMetadata, Injectable: () => target => target,
        Inject: () => () => {}, Optional: () => () => {}, HostListener: name => () => { hostListeners.push(name) },
    }
    const notes = { version: '9.0.0', 'zh-CN': { title: 'Update', sections: [{ title: 'Changes', items: ['Test update'] }] } }
    const sandbox = {
        module: { exports: {} }, exports: {}, console, Buffer, process, AbortController,
        KeyboardEvent: class {}, FocusEvent: class {}, Node: TestNode, Element: TestElement,
        HTMLElement: TestHTMLElement, HTMLInputElement: TestInputElement,
        HTMLTextAreaElement: TestTextAreaElement, setTimeout, clearTimeout,
        Reflect: { metadata: (key, value) => target => { target[key] = value } },
        CustomEvent: class { constructor (type) { this.type = type } },
        window: {
            addEventListener: (name, callback) => {
                events.push(name)
                windowListeners.set(name, [...(windowListeners.get(name) || []), callback])
            },
            dispatchEvent: event => {
                events.push(event.type)
                for (const callback of windowListeners.get(event.type) || []) callback(event)
            },
            setTimeout: () => 1, clearTimeout: () => {},
            requestAnimationFrame: callback => { callback(); return 1 },
        },
        fetch: async (url, options) => {
            networkRequests.push(url)
            const npmRegistry = /^https:\/\/registry\.npmjs\.org\/tabby-windy-quick-commands(?:\/latest)?$/.test(url)
            const mirrorRegistry = /^https:\/\/registry\.npmmirror\.com\/tabby-windy-quick-commands(?:\/latest)?$/.test(url)
            const jsdelivrNotes = /^https:\/\/cdn\.jsdelivr\.net\/npm\/tabby-windy-quick-commands@[^/]+\/update-notes\.json$/.test(url)
            const mirrorNotes = /^https:\/\/registry\.npmmirror\.com\/tabby-windy-quick-commands\/[^/]+\/files\/update-notes\.json$/.test(url)
            const stableSource = npmRegistry || mirrorRegistry || jsdelivrNotes || mirrorNotes
            if (!stableSource) return { ok: false, status: 404, json: async () => ({}) }
            if (liveNetwork) return fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
            if (networkGate.wait) await networkGate.wait
            if ((npmRegistry || mirrorRegistry) && networkGate.registryThrownFailures > 0) {
                networkGate.registryThrownFailures--
                throw networkGate.registryThrownError || new Error('temporary registry failure')
            }
            const status = npmRegistry ? (networkGate.npmRegistryStatus ?? networkGate.registryStatus)
                : mirrorRegistry ? (networkGate.mirrorRegistryStatus ?? networkGate.registryStatus)
                    : jsdelivrNotes ? networkGate.jsdelivrStatus
                        : networkGate.mirrorFilesStatus
            if (status !== 200) return { ok: false, status }
            const requestedVersion = decodeURIComponent(
                (url.match(/@([^/]+)\/update-notes\.json$/)?.[1] || url.match(/commands\/([^/]+)\/files\/update-notes\.json$/)?.[1] || '9.0.0'),
            )
            const sourceVersions = mirrorRegistry && networkGate.mirrorHistoryVersions
                ? networkGate.mirrorHistoryVersions
                : networkGate.historyVersions
            const data = url.endsWith('/latest')
                ? { version: mirrorRegistry && networkGate.mirrorLatestVersion ? networkGate.mirrorLatestVersion : networkGate.latestVersion }
                : jsdelivrNotes || mirrorNotes
                    ? { ...notes, version: requestedVersion }
                    : {
                        versions: Object.fromEntries(Object.keys(sourceVersions).map(version => [version, {}])),
                        time: sourceVersions,
                    }
            return { ok: true, status: 200, json: async () => data }
        },
        require: name => name === '@angular/core' ? angular
            : name === '@angular/common' ? { CommonModule: class {} }
                : name === 'tabby-core' ? core : name === 'tabby-settings' ? settings : require(name),
    }
    sandbox.global = sandbox
    vm.runInNewContext(fs.readFileSync(bundlePath, 'utf8'), sandbox)
    sandbox.document = document
    const Module = sandbox.module.exports.default
    const getProvider = type => Module.testMetadata.providers.find(provider => provider.provide === type).useClass
    return { Module, getProvider, core, settings, hostListeners, events, networkRequests, networkGate }
}

async function exerciseConcurrentDrawers (stableBundlePath, devBundlePath, profilePath) {
    for (const devFirst of [false, true]) {
        const roots = []
        const keyListeners = []
        const document = {
            activeElement: null,
            addEventListener (name, callback) { if (name === 'keydown') keyListeners.push(callback) },
            createElement () {
                const attributes = new Map()
                return {
                    addEventListener () {},
                    classList: { toggle () {} },
                    querySelector () { return null },
                    querySelectorAll () { return [] },
                    setAttribute: (name, value) => attributes.set(name, value),
                    removeAttribute: name => attributes.delete(name),
                    getAttribute: name => attributes.get(name),
                    contains (target) { return target?.ownerRoot === this },
                }
            },
            body: {
                appendChild (element) {
                    const index = roots.indexOf(element)
                    if (index !== -1) roots.splice(index, 1)
                    roots.push(element)
                },
            },
            querySelectorAll (selector) {
                assert.equal(selector, '[data-windy-quick-commands-drawer="open"]')
                return roots.filter(root => root.getAttribute('data-windy-quick-commands-drawer') === 'open')
            },
        }
        const services = {}
        const executions = []
        const focusSwitches = []
        for (const devBuild of (devFirst ? [true, false] : [false, true])) {
            const host = loadBundle(devBuild ? devBundlePath : stableBundlePath, false, document)
            const Service = host.getProvider(host.core.ToolbarButtonProvider)['design:paramtypes'][0]
            const I18n = Service['design:paramtypes'][4]
            const stream = { subscribe: () => ({ unsubscribe () {} }) }
            const channel = devBuild ? 'dev' : 'stable'
            const service = new Service({}, { store: { hotkeys: {} }, ready$: stream },
                { getConfigPath: () => path.join(profilePath, String(devFirst), 'config.yaml') },
                { create: () => ({}) }, new I18n({ getLocale: () => 'en', localeChanged$: stream }), { state$: stream },
                { unfilteredHotkey$: stream })
            // Exercise real opening/closing and document event handlers without
            // rendering unrelated editor controls or sending terminal commands.
            service.render = () => {}
            service.focusCurrentTerminal = () => true
            service.toggleFocusArea = () => { focusSwitches.push(channel) }
            service.isEditableElement = () => false
            service.getSelectedCommand = () => ({ id: channel, command: `echo ${channel}` })
            service.executeSelectedCommand = async () => { executions.push(channel) }
            service.requestConfirmation = () => Service.prototype.executeSelectedCommand.call(service)
            services[channel] = service
        }
        const pressExecute = expected => {
            executions.length = 0
            let stopped = false
            const event = {
                key: 'Enter', ctrlKey: true, defaultPrevented: false,
                preventDefault () { this.defaultPrevented = true },
                stopPropagation () {}, stopImmediatePropagation () { stopped = true },
            }
            for (const listener of keyListeners) {
                listener(event)
                if (stopped) break
            }
            assert.deepEqual(executions, expected, `Ctrl+Enter must follow drawer stacking, regardless of registration order (devFirst=${devFirst})`)
        }
        const pressFocusSwitch = expected => {
            focusSwitches.length = 0
            let stopped = false
            const event = {
                key: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
                defaultPrevented: false, repeat: false, isComposing: false, target: null,
                preventDefault () { this.defaultPrevented = true },
                stopPropagation () {}, stopImmediatePropagation () { stopped = true },
            }
            for (const listener of keyListeners) {
                listener(event)
                if (stopped) break
            }
            assert.deepEqual(focusSwitches, expected, `focus switching must belong to the foreground drawer (devFirst=${devFirst})`)
        }
        services.stable.open()
        services.dev.open()
        services.dev.focusArea = 'drawer'
        document.activeElement = { ownerRoot: null }
        assert.equal(services.dev.shouldRestoreDrawerFocusAfterRender(), false, 'an external settings input must keep focus when drawer configuration rerenders')
        document.activeElement = { ownerRoot: services.dev.root }
        assert.equal(services.dev.shouldRestoreDrawerFocusAfterRender(), true, 'drawer-owned focus must still be restored after its DOM is rerendered')
        document.activeElement = null
        pressExecute(['dev'])
        pressFocusSwitch(['dev'])
        const originalGetActionShortcuts = services.dev.getActionShortcuts
        services.dev.getActionShortcuts = action => action === 'switchFocus' ? ['F6'] : originalGetActionShortcuts.call(services.dev, action)
        services.dev.pendingDeleteId = 'pending-delete'
        const overlayEscape = {
            key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
            defaultPrevented: false, repeat: false, isComposing: false, target: null,
            preventDefault () { this.defaultPrevented = true },
            stopPropagation () {}, stopImmediatePropagation () {},
        }
        services.dev.handleDocumentKeyDown(overlayEscape)
        assert.equal(services.dev.pendingDeleteId, null, 'Escape must dismiss the top overlay after focus switching is rebound')
        assert.equal(overlayEscape.defaultPrevented, true, 'dismissed overlay Escape must not leak to Tabby')
        services.dev.getActionShortcuts = originalGetActionShortcuts
        const surfaceTarget = {}
        const categoryMoves = []
        const originalIsDrawerSurface = services.dev.isDrawerSurface
        const originalMoveKeyboardCategory = services.dev.moveKeyboardCategory
        services.dev.isDrawerSurface = target => target === surfaceTarget
        services.dev.moveKeyboardCategory = direction => { categoryMoves.push(direction) }
        services.dev.filter = ''
        const surfaceArrow = {
            key: 'ArrowRight', code: 'ArrowRight', target: surfaceTarget,
            ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
            defaultPrevented: false, repeat: false, isComposing: false,
            preventDefault () { this.defaultPrevented = true },
            stopPropagation () {}, stopImmediatePropagation () {},
        }
        services.dev.handleDocumentKeyDown(surfaceArrow)
        assert.deepEqual(categoryMoves, [1], 'drawer surface focus must retain category keyboard navigation')
        assert.ok(surfaceArrow.defaultPrevented)
        services.dev.filter = 'query'
        services.dev.handleDocumentKeyDown({ ...surfaceArrow, key: 'ArrowLeft', code: 'ArrowLeft', defaultPrevented: false })
        assert.deepEqual(categoryMoves, [1], 'hidden categories must not react to horizontal arrows while searching')
        services.dev.filter = ''
        services.dev.isDrawerSurface = originalIsDrawerSurface
        services.dev.moveKeyboardCategory = originalMoveKeyboardCategory

        const originalFocusDrawerSurface = services.dev.focusDrawerSurface
        const originalIsDrawerInteractiveControl = services.dev.isDrawerInteractiveControl
        let blankSurfaceFocuses = 0
        services.dev.focusDrawerSurface = () => { blankSurfaceFocuses++ }
        services.dev.isDrawerInteractiveControl = () => false
        services.dev.handleRootClick({ target: surfaceTarget })
        assert.equal(blankSurfaceFocuses, 1, 'clicking drawer whitespace must focus the drawer surface instead of search')
        services.dev.focusDrawerSurface = originalFocusDrawerSurface
        services.dev.isDrawerInteractiveControl = originalIsDrawerInteractiveControl
        services.dev.running = true
        pressExecute([])
        services.dev.running = false
        services.stable.open()
        pressExecute(['stable'])
        services.stable.close()
        pressExecute(['dev'])
        services.dev.close()
        pressExecute([])
        const originalDevCommands = services.dev.state.commands
        const pressClosedCommand = (key, modifiers) => {
            services.dev.handleDocumentKeyDown({
                key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`,
                ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
                defaultPrevented: false, repeat: false, isComposing: false, target: null,
                preventDefault () { this.defaultPrevented = true },
                stopPropagation () {}, stopImmediatePropagation () {},
                ...modifiers,
            })
        }
        executions.length = 0
        services.dev.state.commands = [{ id: 'reserved-command', name: 'Reserved', command: 'echo reserved', shortcut: 'Ctrl+Enter' }]
        pressClosedCommand('Enter', { ctrlKey: true })
        assert.deepEqual(executions, [], 'an imported drawer-reserved command shortcut must remain blocked even while the drawer is closed')
        services.dev.state.commands = [{ id: 'scalar-conflict', name: 'Scalar conflict', command: 'echo conflict', shortcut: 'Ctrl+Alt+Y' }]
        services.dev.config.store.hotkeys.scalarTabbyAction = 'Ctrl-Alt-Y'
        pressClosedCommand('y', { ctrlKey: true, altKey: true })
        assert.deepEqual(executions, [], 'scalar Tabby hotkeys must block conflicting command execution at runtime')
        delete services.dev.config.store.hotkeys.scalarTabbyAction
        pressClosedCommand('y', { ctrlKey: true, altKey: true })
        assert.deepEqual(executions, ['dev'], 'a non-conflicting command shortcut must remain executable')
        services.dev.state.commands = originalDevCommands
        services.dev.open()
        await services.stable.importCommandsText(JSON.stringify({
            format: 'tabby-windy-quick-commands', version: 1, kind: 'commands',
            customCategories: [], categoryOrder: [],
            commands: [{ name: 'Import preview', command: 'echo import' }],
        }))
        pressExecute(['stable'])
        const dangerousCommand = { name: 'Danger', command: 'rm -rf /tmp/demo', autoEnter: true }
        services.dev.state.requireConfirmBeforeExecute = false
        services.dev.state.confirmBroadcast = false
        services.dev.state.targetMode = 'current'
        services.dev.state.confirmHighRiskCommands = true
        let dangerSummary = services.dev.buildExecutionSummary(dangerousCommand, [])
        assert.equal(dangerSummary.requiresConfirm, true, 'high-risk commands must request confirmation by default')
        assert.equal(dangerSummary.requiresTypedConfirm, true, 'severe high-risk commands must require typed confirmation by default')
        services.dev.state.confirmHighRiskCommands = false
        dangerSummary = services.dev.buildExecutionSummary(dangerousCommand, [])
        assert.equal(dangerSummary.requiresConfirm, false, 'disabling high-risk confirmation must stop danger detection from opening a dialog by itself')
        assert.equal(dangerSummary.requiresTypedConfirm, false, 'disabling high-risk confirmation must also disable the typed command-name check')
        assert.match(services.dev.getHint(dangerousCommand, 1, true), /不会因此单独弹出确认/, 'the drawer hint must reflect that high-risk confirmation is disabled')
        services.dev.state.requireConfirmBeforeExecute = true
        dangerSummary = services.dev.buildExecutionSummary(dangerousCommand, [])
        assert.equal(dangerSummary.requiresConfirm, true, 'the global execution confirmation setting must remain independent')
        assert.equal(dangerSummary.requiresTypedConfirm, false, 'global confirmation alone must not restore the disabled high-risk typed check')
        services.dev.getTargetTabs = () => [{}]
        services.dev.buildExecutionSummary = () => ({ requiresConfirm: true })
        await services.dev.requestConfirmation()
        assert.equal(services.dev.pendingExecutionId, 'dev')
        pressExecute(['dev'])
    }
    console.log('[PASS] Shared stable/Dev drawer stacking, Ctrl+Enter ownership, running state, import and execution confirmation')
}

async function exerciseBundle (bundlePath, profilePath, devBuild, language = 'zh-CN') {
    const host = loadBundle(bundlePath)
    const dataDirectory = devBuild ? 'windy-quick-commands-dev' : 'windy-quick-commands'
    const packageName = `tabby-${dataDirectory}`
    const baseVersion = require('../package.json').version
    const version = devBuild ? `${baseVersion}-dev.local` : baseVersion
    const configPath = path.join(profilePath, 'config.yaml')
    const originalYaml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
    const ConfigProvider = host.getProvider(host.core.ConfigProvider)
    const configProvider = new ConfigProvider()
    assert.deepEqual(Object.keys(configProvider.defaults.hotkeys), devBuild
        ? ['windy-command-center-dev-toggle', 'windy-command-center-dev-settings', 'windy-command-center-dev-focus', 'windy-command-center-dev-hints']
        : ['windy-command-center-toggle', 'windy-command-center-settings', 'windy-command-center-focus', 'windy-command-center-hints'])
    assert.deepEqual(clone(configProvider.defaults.hotkeys[devBuild ? 'windy-command-center-dev-hints' : 'windy-command-center-hints']), ['Ctrl-Alt-H'])
    const stream = { subscribe: () => ({ unsubscribe () {} }) }
    const ToolbarProvider = host.getProvider(host.core.ToolbarButtonProvider)
    const Service = ToolbarProvider['design:paramtypes'][0]
    const I18n = Service['design:paramtypes'][4]
    const locale = { current: 'en-US', getLocale () { return this.current }, localeChanged$: new Subject() }
    const i18n = new I18n(locale)
    const pluginInstalls = []
    let restartRequests = 0
    const platform = { getConfigPath: () => configPath, installPlugin: (...args) => { pluginInstalls.push(args) } }
    const legacySettingsHotkeyId = devBuild ? 'windy-command-center-dev-settings' : 'windy-command-center-settings'
    const config = { store: { hotkeys: { 'settings-tab': { [dataDirectory]: [] }, [legacySettingsHotkeyId]: 'Ctrl-P' } }, ready$: new ReplaySubject(1), changed$: stream, save: async () => {}, requestRestart: () => { restartRequests++ } }
    // Match LocaleService's subscription order: resolve language at config readiness.
    config.ready$.subscribe(() => {
        locale.current = language
        locale.localeChanged$.next(language)
    })
    if (devBuild) config.store.windyCommandCenter = { commands: [] }
    const service = new Service({}, config, platform, { create: () => ({}) }, i18n, { state$: stream })
    const PluginHotkeyProvider = host.getProvider(host.core.HotkeyProvider)
    const pluginHotkeyDescriptions = await new PluginHotkeyProvider(i18n).provide()
    assert.equal(pluginHotkeyDescriptions.some(item => item.id.startsWith('settings-tab.')), false, 'the plugin must not duplicate Tabby\'s standard settings-tab hotkey description')
    const shortcutRail = service.renderShortcutRail()
    const normalizedShortcutRail = shortcutRail.replaceAll('tqc-dev-', 'tqc-')
    const normalizedBundleSource = fs.readFileSync(bundlePath, 'utf8').replaceAll('tqc-dev-', 'tqc-')
    assert.ok(normalizedShortcutRail.includes('>命令</span>') && !normalizedShortcutRail.includes('>选择</span>'), 'shortcut rail must label vertical navigation as commands')
    assert.ok(normalizedShortcutRail.indexOf('tqc-shortcut-rail-focus') < normalizedShortcutRail.indexOf('tqc-shortcut-rail-navigation'), 'focus shortcut must remain the first shortcut row')
    assert.ok(normalizedShortcutRail.includes('tqc-shortcut-rail-terminal-action') && normalizedShortcutRail.includes('<span>Ctrl+</span><span>Enter</span>'), 'terminal focus hints must include Ctrl+Enter execution')
    assert.ok(normalizedShortcutRail.includes('data-tooltip="Ctrl+Alt+H：'), 'the keyboard icon tooltip must include the current shortcut hint toggle binding')
    assert.match(normalizedBundleSource, /\.tqc-shortcut-rail-icon\s*\{[^}]*pointer-events:\s*auto/s, 'the keyboard icon must receive hover events even though the surrounding hint rail is click-through')
    assert.match(normalizedBundleSource, /\.tqc-root\.tqc-hints-visible \.tqc-drawer\s*\{[^}]*calc\(100vw - 62px\)/s, 'the open drawer must reserve enough viewport width for the shortcut rail')
    const pluginModule = new host.Module(config, platform, i18n)
    assert.equal(pluginModule.pluginConfigStore.exists(), false, 'temporary startup locale must not be persisted before config readiness')
    config.ready$.next(true)
    assert.deepEqual(
        clone(config.store.hotkeys[devBuild ? 'windy-command-center-dev-hints' : 'windy-command-center-hints']),
        ['Ctrl-Alt-H'],
        'startup must materialize missing plugin hotkey defaults so Tabby can register them',
    )
    assert.deepEqual(clone(config.store.hotkeys['settings-tab'][dataDirectory]), ['Ctrl-P'], 'startup must migrate the old custom settings shortcut to Tabby\'s standard settings-tab action')
    assert.deepEqual(clone(config.store.hotkeys[legacySettingsHotkeyId]), [], 'startup must clear the duplicate legacy settings action after migration')
    assert.equal(pluginModule.pluginConfigStore.exists(), true, 'first-use data must be saved even without user edits')
    if (devBuild) assert.ok(config.store.windyCommandCenter, 'dev must not consume stable legacy config')

    const SettingsProvider = host.getProvider(host.settings.SettingsTabProvider)
    const settingsProvider = new SettingsProvider(i18n)
    assert.equal(settingsProvider.id, dataDirectory)
    assert.ok(host.hostListeners.includes(`window:${dataDirectory}-config-changed`))
    assert.ok(host.hostListeners.includes(`window:${dataDirectory}-runtime-changed`))
    const template = settingsProvider.getComponentType().testMetadata.template
    const toolbar = new ToolbarProvider({ toggle () {} }, platform, i18n)
    const button = toolbar.provide()[0]
    assert.equal(button.title, i18n.text(devBuild ? '快速命令（Dev）' : '快速命令'))
    if (devBuild) {
        const maskId = button.icon.match(/<mask id="([^"]+)"/)?.[1]
        assert.ok(maskId && button.icon.includes(`mask="url(#${maskId})"`), 'badge reference must survive dev namespace rewriting')
    }
    const defaults = clone(toolbar.configStore.load({}))
    if (originalYaml !== null) assert.equal(fs.readFileSync(configPath, 'utf8'), originalYaml, 'loading dev defaults must not modify stable YAML')

    assert.deepEqual(clone(service.state.commands.map(command => command.name)), defaults.commands.map(command => command.name), 'early drawer reads must refresh after localized initialization')
    const savedBytes = fs.readFileSync(pluginModule.pluginConfigStore.configPath, 'utf8')
    locale.current = language === 'zh-CN' ? 'en-US' : 'zh-CN'
    locale.localeChanged$.next(locale.current)
    assert.equal(service.getCategoryLabel(defaults.commands[0].category), defaults.commands[0].category, 'starter category becomes ordinary user content after creation')
    assert.deepEqual(clone(service.readConfig(true).commands.map(command => command.name)), defaults.commands.map(command => command.name), 'language changes must not translate saved command names')
    new host.Module(config, platform, i18n)
    assert.equal(fs.readFileSync(pluginModule.pluginConfigStore.configPath, 'utf8'), savedBytes, 'reinitialization must not rewrite an existing library')
    locale.current = language
    locale.localeChanged$.next(language)
    const categories = clone(service.getCategories())
    let executions = 0
    service.state.commands[0].shortcut = 'Ctrl+Alt+Z'
    service.isEditableElement = () => false
    service.updateConfig = patch => Object.assign(service.state, patch)
    service.executeSelectedCommand = async () => { executions++ }
    service.visible = true
    service.isForegroundDrawer = () => true
    service.state.showOperationHints = true
    let hintKeyStopped = false
    service.handleDocumentKeyDown({
        key: 'h', code: 'KeyH', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
        defaultPrevented: false, repeat: false, isComposing: false, target: null,
        preventDefault () { this.defaultPrevented = true },
        stopPropagation () {}, stopImmediatePropagation () { hintKeyStopped = true },
    })
    assert.equal(service.state.showOperationHints, false, 'the document-level fallback must toggle hints even when native hotkey events are available')
    assert.equal(hintKeyStopped, true, 'the fallback must stop Tabby from handling the same hotkey twice')
    service.state.showOperationHints = true
    service.handleMatchedPluginHotkey(devBuild ? 'windy-command-center-dev-hints' : 'windy-command-center-hints')
    assert.equal(service.state.showOperationHints, false, 'the plugin hint hotkey must toggle shortcut hints while the drawer is open')
    service.visible = false
    const event = {
        key: 'z', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
        defaultPrevented: false, repeat: false, isComposing: false, target: null,
        preventDefault () { this.defaultPrevented = true }, stopPropagation () {},
    }
    service.handleDocumentKeyDown(event)
    assert.equal(executions, 1, 'command shortcuts must work with the drawer closed in both channels')
    assert.ok(event.defaultPrevented)

    const UpdateService = Service['design:paramtypes'][5]
    const cachePath = path.join(profilePath, dataDirectory, 'update-cache.json')
    const bootstrap = { installedPlugins: [{ packageName: devBuild ? 'tabby-windy-quick-commands' : 'tabby-windy-quick-commands-dev', version: '99.0.0' }, { packageName, version }] }
    // Old stable caches stay compatible; Dev must discard caches that came from its old source.
    fs.writeFileSync(cachePath, JSON.stringify({ source: 'jsdelivr-localized-v1', checkedAt: new Date().toISOString(), latestVersion: '8.0.0' }))
    const update = new UpdateService(platform, config, i18n, bootstrap)
    assert.equal(update.snapshot.currentVersion, version)
    assert.equal(update.snapshot.latestVersion, devBuild ? null : '8.0.0', 'cache provenance must distinguish old stable and Dev sources')
    assert.equal(update.checkInterval, defaults.updateCheckInterval)
    assert.equal(update.cachePath, cachePath)
    host.networkGate.latestVersion = baseVersion
    const requestsBeforeCurrentCheck = host.networkRequests.length
    await update.checkNow()
    assert.equal(update.snapshot.status, 'current', 'equal source versions must not advertise a Dev update')
    assert.equal(update.snapshot.currentVersion, version, 'the displayed installed version must keep its Dev suffix')
    assert.ok(
        host.networkRequests.slice(requestsBeforeCurrentCheck).every(url => !url.includes('update-notes.json')),
        'an up-to-date check must not download release notes',
    )
    const cachedUpdate = new UpdateService(platform, config, i18n, bootstrap)
    assert.equal(cachedUpdate.snapshot.status, 'current', 'cached results must use the same normalized comparison')
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).packageName, 'tabby-windy-quick-commands')
    host.networkGate.latestVersion = '1.6.0'
    await update.checkNow()
    assert.equal(update.snapshot.available, false, 'an older registry version must not be offered')
    host.networkGate.registryStatus = 503
    await update.checkNow()
    assert.equal(update.snapshot.status, 'error')
    assert.match(update.snapshot.error, /503/)
    host.networkGate.registryStatus = 200
    host.networkGate.latestVersion = '9.0.0'
    await update.checkNow()
    assert.equal(update.snapshot.status, 'available', update.snapshot.error)
    const timeoutUpdate = new UpdateService(platform, config, i18n, bootstrap)
    host.networkGate.registryThrownFailures = 2
    host.networkGate.registryThrownError = Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })
    await timeoutUpdate.checkNow()
    assert.equal(timeoutUpdate.snapshot.status, 'error')
    assert.equal(timeoutUpdate.snapshot.error, '请求超时，请稍后重试。', 'manual checks must not expose the runtime AbortSignal error')
    const retryUpdate = new UpdateService(platform, config, i18n, bootstrap)
    host.networkGate.registryThrownFailures = 2
    host.networkGate.registryThrownError = new TypeError('fetch failed')
    const requestsBeforeAutomaticRetry = host.networkRequests.length
    await retryUpdate.checkForUpdates(true)
    const automaticRetryRequests = host.networkRequests.slice(requestsBeforeAutomaticRetry)
        .filter(url => url.endsWith('/latest'))
    assert.equal(retryUpdate.snapshot.status, 'available', 'automatic checks must recover from one transient registry failure')
    assert.ok(automaticRetryRequests.length >= 3, 'automatic checks must retry after both update sources fail')
    const foregroundPriorityUpdate = new UpdateService(platform, config, i18n, bootstrap)
    host.networkGate.registryThrownFailures = 2
    host.networkGate.registryThrownError = new TypeError('fetch failed')
    let releaseForegroundPriorityCheck
    host.networkGate.wait = new Promise(resolve => { releaseForegroundPriorityCheck = resolve })
    const requestsBeforeForegroundPriorityCheck = host.networkRequests.length
    const pendingAutomaticCheck = foregroundPriorityUpdate.checkForUpdates(true)
    const pendingManualCheck = foregroundPriorityUpdate.checkNow()
    releaseForegroundPriorityCheck()
    await Promise.all([pendingAutomaticCheck, pendingManualCheck])
    host.networkGate.wait = null
    const foregroundPriorityRequests = host.networkRequests.slice(requestsBeforeForegroundPriorityCheck)
        .filter(url => url.endsWith('/latest'))
    assert.equal(foregroundPriorityUpdate.snapshot.status, 'error')
    assert.equal(foregroundPriorityRequests.length, 2, 'a manual check must stop an in-flight automatic check from entering its background retry')
    host.networkGate.registryThrownError = null
    const requestsBeforeRepeatedAvailableCheck = host.networkRequests.length
    await update.checkNow()
    assert.ok(
        host.networkRequests.slice(requestsBeforeRepeatedAvailableCheck).every(url => !url.includes('update-notes.json')),
        'a repeated check must reuse cached notes for the same available version',
    )
    await update.loadHistory()
    assert.equal(update.historyState$.value.status, 'ready')
    assert.equal(update.historyState$.value.entries.length, 1)
    const historyCachePath = path.join(profilePath, dataDirectory, 'update-history-cache.json')
    assert.equal(fs.existsSync(historyCachePath), true, 'loaded update history must be persisted separately from the latest-version cache')
    const historyCache = JSON.parse(fs.readFileSync(historyCachePath, 'utf8'))
    assert.deepEqual(historyCache.versions, ['9.0.0'])
    assert.equal(historyCache.entries['9.0.0'].document['zh-CN'].title, 'Update')
    const cachedHistoryUpdate = new UpdateService(platform, config, i18n, bootstrap)
    const requestsBeforeCachedHistory = host.networkRequests.length
    await cachedHistoryUpdate.loadHistory()
    assert.equal(host.networkRequests.length, requestsBeforeCachedHistory, 'fresh history cache must be reusable across service restarts without network requests')
    assert.equal(cachedHistoryUpdate.historyState$.value.entries.length, 1)
    await cachedHistoryUpdate.loadHistory(true)
    const forcedHistoryRequests = host.networkRequests.slice(requestsBeforeCachedHistory)
    assert.ok(forcedHistoryRequests.some(url => url === 'https://registry.npmjs.org/tabby-windy-quick-commands'), 'forced history refresh must update the npm version index')
    assert.ok(forcedHistoryRequests.every(url => !url.includes('cdn.jsdelivr.net')), 'cached immutable release notes must not be downloaded again')
    host.networkGate.historyVersions = {
        '9.1.0': '2026-08-28T00:00:00Z',
        '9.0.0': '2026-08-27T00:00:00Z',
    }
    const requestsBeforeIncrementalHistory = host.networkRequests.length
    await cachedHistoryUpdate.loadHistory(true)
    const incrementalHistoryRequests = host.networkRequests.slice(requestsBeforeIncrementalHistory)
    assert.deepEqual(Array.from(cachedHistoryUpdate.historyState$.value.entries, entry => entry.version), ['9.1.0', '9.0.0'])
    assert.equal(incrementalHistoryRequests.filter(url => url.includes('cdn.jsdelivr.net')).length, 1, 'history refresh must download notes only for newly published versions')
    assert.ok(incrementalHistoryRequests.some(url => url.includes('@9.1.0/update-notes.json')))
    assert.ok(incrementalHistoryRequests.every(url => !url.includes('@9.0.0/update-notes.json')), 'existing immutable version notes must stay cached')
    host.networkGate.historyVersions = { '9.0.0': '2026-08-27T00:00:00Z' }

    const sourceStatsPath = path.join(profilePath, dataDirectory, 'update-source-stats.json')
    assert.equal(fs.existsSync(sourceStatsPath), true, 'successful source measurements must be persisted')
    fs.rmSync(sourceStatsPath, { force: true })
    host.networkGate.npmRegistryStatus = 503
    host.networkGate.mirrorRegistryStatus = 200
    host.networkGate.latestVersion = '9.0.0'
    const registryFallbackUpdate = new UpdateService(platform, config, i18n, bootstrap)
    const requestsBeforeRegistryFallback = host.networkRequests.length
    await registryFallbackUpdate.checkNow()
    const registryFallbackRequests = host.networkRequests.slice(requestsBeforeRegistryFallback)
    assert.equal(registryFallbackUpdate.snapshot.status, 'available', 'npmmirror must recover a failed official registry check')
    assert.ok(registryFallbackRequests[0].includes('registry.npmjs.org'), 'official npm must be the initial registry source without measurements')
    assert.ok(registryFallbackRequests.some(url => url.includes('registry.npmmirror.com/tabby-windy-quick-commands/latest')))

    host.networkGate.npmRegistryStatus = 200
    host.networkGate.jsdelivrStatus = 404
    host.networkGate.mirrorFilesStatus = 200
    host.networkGate.latestVersion = '9.2.0'
    fs.rmSync(sourceStatsPath, { force: true })
    const notesFallbackUpdate = new UpdateService(platform, config, i18n, bootstrap)
    const requestsBeforeNotesFallback = host.networkRequests.length
    await notesFallbackUpdate.checkNow()
    const notesFallbackRequests = host.networkRequests.slice(requestsBeforeNotesFallback).filter(url => url.includes('update-notes.json'))
    assert.ok(notesFallbackRequests[0].includes('cdn.jsdelivr.net'), 'jsDelivr must be the initial notes source without measurements')
    assert.ok(notesFallbackRequests.some(url => url.includes('/files/update-notes.json')), 'npmmirror files must recover a jsDelivr 404')
    assert.ok(notesFallbackUpdate.snapshot.releaseNotes.includes('Update'))
    const notesFallbackStats = JSON.parse(fs.readFileSync(sourceStatsPath, 'utf8')).groups.updateNotes
    assert.equal(notesFallbackStats.jsdelivr.consecutiveFailures, 1, 'a single-source 404 must be deprioritized when the other source has the file')
    assert.equal(notesFallbackStats.npmmirror.successRate, 1)

    host.networkGate.jsdelivrStatus = 404
    host.networkGate.mirrorFilesStatus = 404
    host.networkGate.latestVersion = '9.3.0'
    const missingNotesUpdate = new UpdateService(platform, config, i18n, bootstrap)
    await missingNotesUpdate.checkNow()
    assert.equal(missingNotesUpdate.snapshot.status, 'available')
    assert.equal(missingNotesUpdate.snapshot.releaseNotes, '')
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).updateNotes, null, 'only a dual-source 404 should persist missing notes')
    const requestsBeforeMissingNotesRetry = host.networkRequests.length
    await missingNotesUpdate.checkNow()
    assert.ok(
        host.networkRequests.slice(requestsBeforeMissingNotesRetry).every(url => !url.includes('update-notes.json')),
        'a confirmed dual-source missing file should not be requested again',
    )

    const measuredAt = new Date().toISOString()
    fs.writeFileSync(sourceStatsPath, JSON.stringify({
        version: 1,
        packageName: 'tabby-windy-quick-commands',
        updatedAt: measuredAt,
        groups: {
            registryLatest: {
                npm: { samples: 3, averageMs: 600, successRate: 1, consecutiveFailures: 0, lastTestedAt: measuredAt },
                npmmirror: { samples: 3, averageMs: 50, successRate: 1, consecutiveFailures: 0, lastTestedAt: measuredAt },
            },
            registryMetadata: {},
            updateNotes: {
                jsdelivr: { samples: 3, averageMs: 80, successRate: 1, consecutiveFailures: 0, lastTestedAt: measuredAt },
                npmmirror: { samples: 3, averageMs: 300, successRate: 1, consecutiveFailures: 0, lastTestedAt: measuredAt },
            },
        },
    }))
    host.networkGate.latestVersion = '9.4.0'
    host.networkGate.mirrorLatestVersion = '9.3.0'
    host.networkGate.jsdelivrStatus = 200
    host.networkGate.mirrorFilesStatus = 200
    const mirrorPreferredUpdate = new UpdateService(platform, config, i18n, bootstrap)
    const requestsBeforeMirrorPreferred = host.networkRequests.length
    await mirrorPreferredUpdate.checkNow()
    await new Promise(resolve => setImmediate(resolve))
    const mirrorPreferredRequests = host.networkRequests.slice(requestsBeforeMirrorPreferred)
    assert.ok(mirrorPreferredRequests[0].includes('registry.npmmirror.com'), 'measured source performance must change the next request order')
    assert.ok(mirrorPreferredRequests.some(url => url.includes('registry.npmjs.org')), 'an official latest validation must still run when the mirror wins')
    assert.equal(mirrorPreferredUpdate.snapshot.latestVersion, '9.4.0', 'official validation must correct a lagging mirror result')

    host.networkGate.jsdelivrStatus = 200
    host.networkGate.mirrorFilesStatus = 200
    host.networkGate.mirrorLatestVersion = null
    host.networkGate.latestVersion = '9.0.0'
    await update.installLatest()
    assert.equal(update.canInstallUpdate, !devBuild)
    assert.deepEqual(pluginInstalls, devBuild ? [] : [[packageName, '9.0.0']], 'Dev must not install a stable or unpublished Dev package')
    assert.equal(restartRequests, devBuild ? 0 : 1)
    assert.equal(update.snapshot.status, devBuild ? 'available' : 'restart')
    update.ignoreLatest()
    assert.equal(update.snapshot.ignored, true, 'ignore update preference must still work for both channels')
    update.setCheckInterval('startup')
    assert.equal(update.checkInterval, 'startup', 'both channels must honor the client-startup update preference')
    const requestsBeforeStartupCheck = host.networkRequests.length
    update.scheduleAutomaticCheck(true)
    await update.checkPromise
    assert.ok(host.networkRequests.length > requestsBeforeStartupCheck, 'the client-startup preference must check once when startup scheduling begins')
    const requestsAfterStartupCheck = host.networkRequests.length
    update.scheduleAutomaticCheck(false)
    await Promise.resolve()
    assert.equal(host.networkRequests.length, requestsAfterStartupCheck, 'the client-startup preference must not schedule another check during the same run')
    assert.ok(host.networkRequests.every(url => !url.includes('tabby-windy-quick-commands-dev')), 'both channels must use the published stable update source')
    assert.ok(host.events.includes(`${dataDirectory}-config-changed`))

    // Exercise the real settings controller and reset operation against the temp profile.
    service.pluginUpdate = update
    const Settings = settingsProvider.getComponentType()
    const settingsTab = new Settings(platform, { markForCheck () {}, detectChanges () {} }, {}, i18n, {}, update, service, config)
    assert.equal(settingsTab.canInstallUpdate, !devBuild, 'settings must disable online installation for local Dev builds')
    const dataPath = path.join(profilePath, dataDirectory)
    const settingsPath = path.join(dataPath, 'plugin-config.json')
    const savedSettings = clone(settingsTab.root)
    const savedSettingsBytes = fs.readFileSync(settingsPath, 'utf8')
    const lockPath = path.join(profilePath, `.${dataDirectory}.lock-${process.pid}-settings-peer`)
    fs.writeFileSync(lockPath, '')
    try {
        settingsTab.setBooleanValue('requireConfirmBeforeExecute', !savedSettings.requireConfirmBeforeExecute)
        assert.deepEqual(clone(settingsTab.root), savedSettings, 'failed saves must roll back the displayed settings')
        assert.match(settingsTab.configMessage, language === 'zh-CN' ? /保存失败/ : /Save failed/, 'save failure must be visible and localized')
        settingsTab.exportFileNameDraft = 'unsaved-name'
        settingsTab.confirmExportPluginConfig()
        assert.equal(settingsTab.exportFileNameDraft, savedSettings.exportFileName, 'failed export-name saves must restore the dialog draft')
        const input = { value: '740' }
        settingsTab.setNumber('drawerWidth', { target: input }, 420, 760)
        assert.equal(input.value, String(savedSettings.drawerWidth))
        const toolbarCheckbox = { checked: !savedSettings.showToolbarButton }
        settingsTab.setToolbarButtonVisibility({ target: toolbarCheckbox })
        assert.equal(toolbarCheckbox.checked, savedSettings.showToolbarButton)
        settingsTab.selectUpdateCheckInterval('never')
        assert.equal(settingsTab.updateCheckInterval, savedSettings.updateCheckInterval)
        const pending = { config: { ...savedSettings, exportFileName: 'unsaved-import' } }
        settingsTab.pendingConfigImport = pending
        await settingsTab.importPendingFullConfig()
        assert.equal(settingsTab.pendingConfigImport, pending, 'failed imports must remain available to retry')
        assert.equal(i18n.text(settingsTab.configMessage), i18n.text('导入失败'))
        assert.match(settingsTab.configMessageDetail, language === 'zh-CN' ? /保存失败/ : /Save failed/)
        settingsTab.openResetDefaultsConfirm()
        await settingsTab.restoreDefaultSettings()
        assert.equal(settingsTab.resetDefaultsConfirmOpen, false, 'failed restore must close the dialog so the result is visible')
        assert.equal(i18n.text(settingsTab.configMessage), i18n.text('恢复失败'))
        assert.match(settingsTab.configMessageDetail, language === 'zh-CN' ? /保存失败/ : /Save failed/)
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), savedSettingsBytes, 'contention must not modify the persisted configuration')
        assert.deepEqual(clone(settingsTab.pluginConfigStore.load({})), savedSettings, 'failed saves must invalidate the mutated store cache')
    } finally { fs.unlinkSync(lockPath) }
    const lastMessage = settingsTab.configMessage
    const retryValue = !savedSettings.requireConfirmBeforeExecute
    settingsTab.setBooleanValue('requireConfirmBeforeExecute', retryValue)
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).requireConfirmBeforeExecute, retryValue, 'a retry after the other writer exits must persist normally')
    assert.equal(settingsTab.configMessage, lastMessage, 'ordinary saves must not dismiss the current notification')
    settingsTab.dismissConfigMessage()
    assert.equal(settingsTab.configMessage, '')
    settingsTab.pendingConfigImport = null
    settingsTab.closeResetDefaultsConfirm()
    const beforeReset = fs.readFileSync(path.join(dataPath, 'plugin-config.json'), 'utf8')
    settingsTab.restoreInitialState()
    settingsTab.openResetDefaultsConfirm()
    settingsTab.openResetInitialConfirm()
    settingsTab.restoreInitialState()
    assert.equal(fs.readFileSync(path.join(dataPath, 'plugin-config.json'), 'utf8'), beforeReset, 'no deletion before the second page and explicit acknowledgement')
    settingsTab.resetInitialAcknowledged = true
    settingsTab.backToResetDefaults()
    assert.equal(settingsTab.resetInitialAcknowledged, false, 'Back must clear the destructive acknowledgement')
    settingsTab.closeResetDefaultsConfirm()
    assert.equal(fs.readFileSync(path.join(dataPath, 'plugin-config.json'), 'utf8'), beforeReset, 'cancel must not modify data')
    settingsTab.openResetDefaultsConfirm()
    await settingsTab.restoreDefaultSettings()
    assert.equal(settingsTab.resetDefaultsConfirmOpen, false)
    assert.equal(i18n.text(settingsTab.configMessage), i18n.text('恢复成功'))
    assert.equal(fs.existsSync(path.join(dataPath, 'update-cache.json')), true, 'ordinary restore defaults must not clear cache or user data')

    settingsTab.openResetDefaultsConfirm()
    settingsTab.openResetInitialConfirm()
    settingsTab.resetInitialAcknowledged = true
    service.running = true
    settingsTab.restoreInitialState()
    assert.ok(settingsTab.resetInitialError.includes(language === 'zh-CN' ? '命令正在执行' : 'command is still running'), 'running commands must keep the second page open with a localized error')
    assert.equal(settingsTab.resetDefaultsConfirmOpen, true)
    assert.equal(settingsTab.resetInitialAcknowledged, false)
    service.running = false
    service.setPluginConfig({ ...defaults, commands: [{ id: 'obsolete', name: 'Obsolete queued write', command: 'echo old' }] })
    let releaseNetwork
    host.networkGate.wait = new Promise(resolve => { releaseNetwork = resolve })
    const pendingCheck = update.checkNow()
    const pendingHistory = update.loadHistory(true)
    let releaseFile
    const fileRead = new Promise(resolve => { releaseFile = resolve })
    const pendingFile = { size: 100, text: () => fileRead }
    const pendingSettingsImport = settingsTab.importPluginConfig({ target: { files: [pendingFile], value: '' } })
    const pendingDrawerImport = service.importCommandsFromFile(pendingFile)
    settingsTab.resetInitialAcknowledged = true
    settingsTab.restoreInitialState()
    assert.equal(settingsTab.resetInitialError, '', settingsTab.resetInitialError)
    assert.equal(settingsTab.resetDefaultsConfirmOpen, false)
    assert.equal(service.pluginConfigDirty, false, 'reset must discard pending drawer writes')
    service.flushPluginConfigWrite()
    assert.deepEqual(fs.readdirSync(dataPath).sort(), ['.data-generation', 'plugin-config.json'])
    assert.equal(settingsTab.root.commands[0].name, language === 'zh-CN' ? '示例命令' : 'Example command')
    assert.equal(service.state.automationLogs.length, 0)
    assert.equal(Object.keys(settingsTab.runtimeStats).length, 0)
    assert.equal(update.snapshot.status, 'idle')
    releaseFile(JSON.stringify({ commands: [{ id: 'obsolete', name: 'Obsolete import', command: 'echo old' }] }))
    await Promise.all([pendingSettingsImport, pendingDrawerImport])
    assert.equal(settingsTab.pendingConfigImport, null, 'an old file read must not reopen the import dialog after reset')
    assert.equal(service.importPreview, null, 'an old file read must not reopen the drawer after reset')
    releaseNetwork()
    await Promise.all([pendingCheck, pendingHistory])
    assert.equal(fs.existsSync(path.join(dataPath, 'update-cache.json')), false, 'in-flight update requests must not repopulate the old cache after reset')
    assert.equal(fs.existsSync(path.join(dataPath, 'update-history-cache.json')), false, 'in-flight history requests must not repopulate the old cache after reset')
    assert.equal(fs.existsSync(path.join(dataPath, 'update-source-stats.json')), false, 'in-flight measurements must not repopulate source statistics after reset')
    assert.equal(update.snapshot.status, 'idle', 'obsolete update results must not reappear in the UI')
    assert.equal(update.historyState$.value.entries.length, 0)
    settingsTab.ngOnDestroy()
    return { defaults, categories, template }
}

// Opt-in smoke test: real registry/CDN requests, actual built updater, disposable profiles and no installs.
async function exerciseLiveUpdates (devBundlePath, stableBundlePath) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wqc-update-live-')))
    try {
        const baseVersion = require('../package.json').version
        for (const devBuild of [false, true]) {
            const host = loadBundle(devBuild ? devBundlePath : stableBundlePath, true)
            const ToolbarProvider = host.getProvider(host.core.ToolbarButtonProvider)
            const Service = ToolbarProvider['design:paramtypes'][0]
            const I18n = Service['design:paramtypes'][4]
            const UpdateService = Service['design:paramtypes'][5]
            const i18n = new I18n({ getLocale: () => 'en-US', localeChanged$: new Subject() })
            const dataDirectory = devBuild ? 'windy-quick-commands-dev' : 'windy-quick-commands'
            const packageName = `tabby-${dataDirectory}`
            const version = devBuild ? `${baseVersion}-dev.local` : baseVersion
            const configPath = path.join(directory, dataDirectory, 'config.yaml')
            fs.mkdirSync(path.dirname(configPath), { recursive: true })
            fs.writeFileSync(configPath, 'language: en-US\n')
            let installs = 0
            let restarts = 0
            const update = new UpdateService(
                { getConfigPath: () => configPath, installPlugin: () => { installs++ } },
                { requestRestart: () => { restarts++ } }, i18n,
                { installedPlugins: [{ packageName, version }] },
            )
            await update.checkNow()
            assert.ok(['current', 'available'].includes(update.snapshot.status), update.snapshot.error)
            assert.equal(update.snapshot.currentVersion, version)
            await update.loadHistory()
            assert.equal(update.historyState$.value.status, 'ready', update.historyState$.value.error)
            assert.ok(update.historyState$.value.entries.some(entry => entry.version === update.snapshot.latestVersion), 'live history must include the latest release')
            if (devBuild) await update.installLatest()
            assert.equal(installs, 0)
            assert.equal(restarts, 0)
            assert.equal(fs.readFileSync(configPath, 'utf8'), 'language: en-US\n')
            const cache = JSON.parse(fs.readFileSync(update.cachePath, 'utf8'))
            assert.equal(cache.packageName, 'tabby-windy-quick-commands')
            console.log(`[PASS] Live ${devBuild ? 'Dev' : 'stable'} updater: installed=${version}, latest=${update.snapshot.latestVersion}, status=${update.snapshot.status}, history=${update.historyState$.value.entries.length}, source=${cache.packageName}`)
        }
    } finally {
        assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(directory).startsWith('wqc-update-live-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

async function main () {
    if (process.argv[2] === '--live-updates') {
        await exerciseLiveUpdates(process.argv[3], process.argv[4])
        return
    }
    const [devBundlePath, profilePath, stableBundlePath, mode] = process.argv.slice(2)
    if (mode === '--after-clean-en') {
        const dev = await exerciseBundle(devBundlePath, profilePath, true, 'en')
        assert.equal(dev.defaults.commands[0].category, 'Default')
        assert.equal(dev.defaults.commands[0].name, 'Example command')
        console.log('[PASS] Dev clean followed by restart initializes in the current English interface language')
        return
    }
    await exerciseConcurrentDrawers(stableBundlePath, devBundlePath, path.join(profilePath, 'concurrent-drawers'))
    for (const language of ['zh-CN', 'en']) {
        const stable = await exerciseBundle(stableBundlePath, path.join(profilePath, `fresh-stable-profile-${language}`), false, language)
        const dev = await exerciseBundle(devBundlePath, language === 'zh-CN' ? profilePath : path.join(profilePath, 'fresh-dev-en'), true, language)
        // Export filenames are part of the isolated identity, not application behavior.
        delete stable.defaults.exportFileName
        delete dev.defaults.exportFileName
        assert.deepEqual(dev.defaults, stable.defaults, 'dev and stable must use identical startup data and settings')
        assert.deepEqual(dev.categories, stable.categories)
        const category = language === 'zh-CN' ? '默认' : 'Default'
        assert.deepEqual(dev.categories, ['全部', '常用', '收藏', category], 'new profiles must expose only the localized initial user category alongside system filters')
        assert.equal(dev.defaults.commands.length, 1)
        const example = dev.defaults.commands[0]
        assert.equal(example.category, category)
        assert.equal(example.name, language === 'zh-CN' ? '示例命令' : 'Example command')
        assert.equal(example.command, 'echo Hello Tabby')
        assert.equal(example.favorite, true)
        assert.equal(example.pinned, false)
        assert.equal(dev.defaults.selectedCommandId, example.id)
        assert.equal(dev.template.replace(/\b(tqc|wqc)-dev-/g, '$1-'), stable.template, 'dev must expose the same settings UI as stable')
    }
    console.log('[PASS] Stable/dev defaults, categories, closed-drawer shortcuts, settings UI and update-flow parity')
}

main().catch(error => {
    console.error(error.stack || error.message)
    process.exitCode = 1
})
