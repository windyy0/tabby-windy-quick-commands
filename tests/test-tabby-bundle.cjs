// Compare real stable/dev bundles with host API stubs; no real profile, network or plugin installation is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const { ReplaySubject, Subject } = require('rxjs')
const clone = value => JSON.parse(JSON.stringify(value))

function loadBundle (bundlePath, liveNetwork = false, document = { addEventListener () {} }) {
    const hostListeners = []
    const events = []
    const windowListeners = new Map()
    const networkRequests = []
    const networkGate = { wait: null, latestVersion: '9.0.0', registryStatus: 200 }
    const core = { ConfigProvider: class {}, HotkeyProvider: class {}, ToolbarButtonProvider: class {} }
    const settings = { SettingsTabProvider: class {} }
    const captureMetadata = metadata => target => { target.testMetadata = metadata; return target }
    const angular = {
        NgModule: captureMetadata, Component: captureMetadata, Injectable: () => target => target,
        Inject: () => () => {}, HostListener: name => () => { hostListeners.push(name) },
    }
    const notes = { version: '9.0.0', 'zh-CN': { title: 'Update', sections: [{ title: 'Changes', items: ['Test update'] }] } }
    const sandbox = {
        module: { exports: {} }, exports: {}, console, Buffer, process, AbortController, setTimeout, clearTimeout,
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
        },
        fetch: async (url, options) => {
            networkRequests.push(url)
            const stableSource = /^https:\/\/registry\.npmjs\.org\/tabby-windy-quick-commands(?:\/latest)?$/.test(url) ||
                /^https:\/\/cdn\.jsdelivr\.net\/npm\/tabby-windy-quick-commands@[^/]+\/update-notes\.json$/.test(url)
            if (!stableSource) return { ok: false, status: 404, json: async () => ({}) }
            if (liveNetwork) return fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
            if (networkGate.wait) await networkGate.wait
            if (networkGate.registryStatus !== 200) return { ok: false, status: networkGate.registryStatus }
            const data = url.endsWith('/latest') ? { version: networkGate.latestVersion }
                : url.includes('cdn.jsdelivr.net') ? notes
                    : { versions: { '9.0.0': {} }, time: { '9.0.0': '2026-08-27T00:00:00Z' } }
            return { ok: true, json: async () => data }
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
            addEventListener (name, callback) { if (name === 'keydown') keyListeners.push(callback) },
            createElement () {
                const attributes = new Map()
                return {
                    addEventListener () {},
                    setAttribute: (name, value) => attributes.set(name, value),
                    removeAttribute: name => attributes.delete(name),
                    getAttribute: name => attributes.get(name),
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
        for (const devBuild of (devFirst ? [true, false] : [false, true])) {
            const host = loadBundle(devBuild ? devBundlePath : stableBundlePath, false, document)
            const Service = host.getProvider(host.core.ToolbarButtonProvider)['design:paramtypes'][0]
            const I18n = Service['design:paramtypes'][4]
            const stream = { subscribe: () => ({ unsubscribe () {} }) }
            const channel = devBuild ? 'dev' : 'stable'
            const service = new Service({}, { store: { hotkeys: {} }, ready$: stream },
                { getConfigPath: () => path.join(profilePath, String(devFirst), 'config.yaml') },
                { create: () => ({}) }, new I18n({ getLocale: () => 'en', localeChanged$: stream }), { state$: stream })
            // Exercise real opening/closing and document event handlers without
            // rendering unrelated editor controls or sending terminal commands.
            service.render = () => {}
            service.focusCurrentTerminal = () => {}
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
        services.stable.open()
        services.dev.open()
        pressExecute(['dev'])
        services.dev.running = true
        pressExecute([])
        services.dev.running = false
        services.stable.open()
        pressExecute(['stable'])
        services.stable.close()
        pressExecute(['dev'])
        services.dev.close()
        pressExecute([])
        services.dev.open()
        await services.stable.importCommandsText(JSON.stringify({
            format: 'tabby-windy-quick-commands', version: 1, kind: 'commands',
            customCategories: [], categoryOrder: [],
            commands: [{ name: 'Import preview', command: 'echo import' }],
        }))
        pressExecute(['stable'])
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
    assert.deepEqual(Object.keys(new ConfigProvider().defaults.hotkeys), [devBuild ? 'windy-command-center-dev-toggle' : 'windy-command-center-toggle'])
    const stream = { subscribe: () => ({ unsubscribe () {} }) }
    const ToolbarProvider = host.getProvider(host.core.ToolbarButtonProvider)
    const Service = ToolbarProvider['design:paramtypes'][0]
    const I18n = Service['design:paramtypes'][4]
    const locale = { current: 'en-US', getLocale () { return this.current }, localeChanged$: new Subject() }
    const i18n = new I18n(locale)
    const pluginInstalls = []
    let restartRequests = 0
    const platform = { getConfigPath: () => configPath, installPlugin: (...args) => { pluginInstalls.push(args) } }
    const config = { store: { hotkeys: {} }, ready$: new ReplaySubject(1), changed$: stream, requestRestart: () => { restartRequests++ } }
    // Match LocaleService's subscription order: resolve language at config readiness.
    config.ready$.subscribe(() => {
        locale.current = language
        locale.localeChanged$.next(language)
    })
    if (devBuild) config.store.windyCommandCenter = { commands: [] }
    const service = new Service({}, config, platform, { create: () => ({}) }, i18n, { state$: stream })
    const pluginModule = new host.Module(config, platform, i18n)
    assert.equal(pluginModule.pluginConfigStore.exists(), false, 'temporary startup locale must not be persisted before config readiness')
    config.ready$.next(true)
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
    await update.checkNow()
    assert.equal(update.snapshot.status, 'current', 'equal source versions must not advertise a Dev update')
    assert.equal(update.snapshot.currentVersion, version, 'the displayed installed version must keep its Dev suffix')
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
    await update.loadHistory()
    assert.equal(update.historyState$.value.status, 'ready')
    assert.equal(update.historyState$.value.entries.length, 1)
    await update.installLatest()
    assert.equal(update.canInstallUpdate, !devBuild)
    assert.deepEqual(pluginInstalls, devBuild ? [] : [[packageName, '9.0.0']], 'Dev must not install a stable or unpublished Dev package')
    assert.equal(restartRequests, devBuild ? 0 : 1)
    assert.equal(update.snapshot.status, devBuild ? 'available' : 'restart')
    update.ignoreLatest()
    assert.equal(update.snapshot.ignored, true, 'ignore update preference must still work for both channels')
    update.setCheckInterval('weekly')
    assert.equal(update.checkInterval, 'weekly', 'both channels must honor update preferences')
    assert.ok(host.networkRequests.every(url => !url.includes('tabby-windy-quick-commands-dev')), 'both channels must use the published stable update source')
    assert.ok(host.events.includes(`${dataDirectory}-config-changed`))

    // Exercise the real settings controller and reset operation against the temp profile.
    service.pluginUpdate = update
    const Settings = settingsProvider.getComponentType()
    const settingsTab = new Settings(platform, { markForCheck () {}, detectChanges () {} }, {}, i18n, {}, update, service)
    assert.equal(settingsTab.canInstallUpdate, !devBuild, 'settings must disable online installation for local Dev builds')
    const dataPath = path.join(profilePath, dataDirectory)
    const settingsPath = path.join(dataPath, 'plugin-config.json')
    const savedSettings = clone(settingsTab.root)
    const savedSettingsBytes = fs.readFileSync(settingsPath, 'utf8')
    const lockPath = path.join(profilePath, `.${dataDirectory}.lock-${process.pid}-settings-peer`)
    fs.writeFileSync(lockPath, '')
    try {
        const checkbox = { checked: !savedSettings.requireConfirmBeforeExecute }
        settingsTab.setBoolean('requireConfirmBeforeExecute', { target: checkbox })
        assert.equal(checkbox.checked, savedSettings.requireConfirmBeforeExecute, 'failed saves must restore the native checkbox as well as the model')
        assert.deepEqual(clone(settingsTab.root), savedSettings, 'failed saves must roll back the displayed settings')
        assert.match(settingsTab.configMessage, language === 'zh-CN' ? /保存失败/ : /Save failed/, 'save failure must be visible and localized')
        const input = { value: 'unsaved-name' }
        settingsTab.setString('exportFileName', { target: input })
        assert.equal(input.value, savedSettings.exportFileName)
        input.value = '740'
        settingsTab.setNumber('drawerWidth', { target: input }, 420, 760)
        assert.equal(input.value, String(savedSettings.drawerWidth))
        const toolbarCheckbox = { checked: !savedSettings.showToolbarButton }
        settingsTab.setToolbarButtonVisibility({ target: toolbarCheckbox })
        assert.equal(toolbarCheckbox.checked, savedSettings.showToolbarButton)
        settingsTab.selectUpdateCheckInterval('never')
        assert.equal(settingsTab.updateCheckInterval, savedSettings.updateCheckInterval)
        const pending = { config: { ...savedSettings, exportFileName: 'unsaved-import' } }
        settingsTab.pendingConfigImport = pending
        settingsTab.importPendingFullConfig()
        assert.equal(settingsTab.pendingConfigImport, pending, 'failed imports must remain available to retry')
        assert.match(settingsTab.configMessage, language === 'zh-CN' ? /保存失败/ : /Save failed/)
        settingsTab.openResetDefaultsConfirm()
        settingsTab.restoreDefaultSettings()
        assert.equal(settingsTab.resetDefaultsConfirmOpen, true, 'failed restore must not report success or close the confirmation')
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), savedSettingsBytes, 'contention must not modify the persisted configuration')
        assert.deepEqual(clone(settingsTab.pluginConfigStore.load({})), savedSettings, 'failed saves must invalidate the mutated store cache')
    } finally { fs.unlinkSync(lockPath) }
    const retry = { checked: !savedSettings.requireConfirmBeforeExecute }
    settingsTab.setBoolean('requireConfirmBeforeExecute', { target: retry })
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).requireConfirmBeforeExecute, retry.checked, 'a retry after the other writer exits must persist normally')
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
    settingsTab.restoreDefaultSettings()
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
