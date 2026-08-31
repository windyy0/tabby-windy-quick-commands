import * as fs from 'fs'
import * as path from 'path'

import { Inject, Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import {
    BOOTSTRAP_DATA,
    BootstrapData,
    ConfigService,
    PlatformService,
} from 'tabby-core'

import { createDefaultQuickCommandsConfig } from './configProvider'
import { QuickCommandsI18n } from './i18n'
import { pluginConfigChangedEvent, QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { pluginIdentity } from './pluginIdentity'
import { pluginDataResetEvent } from './pluginData'
import {
    comparePluginVersions,
    formatPluginUpdateNotes,
    getNextPluginUpdateCheckDelay,
    getUpdateComparisonVersion,
    isNewerPluginVersion,
    UpdateCheckInterval,
} from './pluginUpdate'

const packageInfo = require('../package.json') as { version?: string }

export const quickCommandsPackageName = pluginIdentity.packageName
export const quickCommandsUpdatePackageName = pluginIdentity.updatePackageName
const updateNotesFileName = 'update-notes.json'
const updateHistoryCacheFileName = 'update-history-cache.json'
const updateHistoryMetadataCacheMs = 24 * 60 * 60 * 1000

export type PluginUpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'error' | 'installing' | 'restart'

export interface PluginUpdateState {
    currentVersion: string
    latestVersion: string | null
    available: boolean
    ignored: boolean
    status: PluginUpdateStatus
    releaseNotes: string
    error: string
}

export interface PluginUpdateHistoryEntry {
    version: string
    publishedAt: string
    releaseNotes: string
    hasReleaseNotes: boolean
}

export type PluginUpdateHistoryStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'

export interface PluginUpdateHistoryState {
    status: PluginUpdateHistoryStatus
    entries: PluginUpdateHistoryEntry[]
    error: string
}

interface PluginUpdateCache {
    source: 'jsdelivr-localized-v1'
    packageName: string
    checkedAt: string
    latestVersion: string
    updateNotes?: unknown
}

interface PluginUpdateHistorySourceEntry {
    version: string
    publishedAt: string
    document: unknown
}

interface PluginUpdateHistoryCacheEntry {
    publishedAt: string
    document: unknown
}

interface PluginUpdateHistoryCache {
    source: 'jsdelivr-localized-v1'
    packageName: string
    checkedAt: string
    versions: string[]
    entries: Record<string, PluginUpdateHistoryCacheEntry>
}

@Injectable({ providedIn: 'root' })
export class QuickCommandsPluginUpdateService {
    readonly state$: BehaviorSubject<PluginUpdateState>
    readonly historyState$ = new BehaviorSubject<PluginUpdateHistoryState>({
        status: 'idle',
        entries: [],
        error: '',
    })
    private configStore: QuickCommandsPluginConfigStore
    private readonly cachePath: string | null
    private readonly historyCachePath: string | null
    private checkPromise: Promise<void> | null = null
    private checkTimer: number | null = null
    private initialCheckTimer: number | null = null
    private requests = new Set<AbortController>()
    private scheduledInterval: UpdateCheckInterval | null = null
    private lastAttemptAt = 0
    private focusSettingsRequested = false
    private cache: PluginUpdateCache | null = null
    private historyPromise: Promise<void> | null = null
    private historySources: PluginUpdateHistorySourceEntry[] = []
    private historyCache: PluginUpdateHistoryCache | null = null

    constructor (
        private platform: PlatformService,
        private config: ConfigService,
        private i18n: QuickCommandsI18n,
        @Inject(BOOTSTRAP_DATA) bootstrapData: BootstrapData,
    ) {
        const installed = bootstrapData.installedPlugins.find(plugin => plugin.packageName === quickCommandsPackageName)
        const currentVersion = installed?.version || packageInfo.version || '0.0.0'
        const configPath = this.platform.getConfigPath()
        this.configStore = new QuickCommandsPluginConfigStore(configPath)
        this.cachePath = configPath
            ? path.join(path.dirname(configPath), pluginIdentity.dataDirectory, 'update-cache.json')
            : null
        this.historyCachePath = configPath
            ? path.join(path.dirname(configPath), pluginIdentity.dataDirectory, updateHistoryCacheFileName)
            : null
        this.cache = this.readCache()
        this.historyCache = this.readHistoryCache()
        this.state$ = new BehaviorSubject<PluginUpdateState>({
            currentVersion,
            latestVersion: null,
            available: false,
            ignored: false,
            status: 'idle',
            releaseNotes: '',
            error: '',
        })
        this.applyCache()
        this.i18n.localeChanged$.subscribe(() => {
            this.patchState({
                releaseNotes: formatPluginUpdateNotes(this.cache?.updateNotes, this.i18n.language),
            })
            this.renderHistory()
        })
        window.addEventListener(pluginConfigChangedEvent, () => {
            this.refreshPreferenceState()
            if (this.checkInterval !== this.scheduledInterval) {
                this.scheduleAutomaticCheck()
            }
        })
        window.addEventListener(pluginDataResetEvent, () => {
            if (this.checkTimer !== null) { window.clearTimeout(this.checkTimer); this.checkTimer = null }
            if (this.initialCheckTimer !== null) { window.clearTimeout(this.initialCheckTimer); this.initialCheckTimer = null }
            for (const request of this.requests) { request.abort() }
            this.configStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
            this.cache = null
            this.historyCache = null
            this.historySources = []
            this.lastAttemptAt = 0
            this.scheduledInterval = null
            this.historyState$.next({ status: 'idle', entries: [], error: '' })
            this.patchState({ latestVersion: null, available: false, ignored: false, status: 'idle', releaseNotes: '', error: '' })
        })
        this.initialCheckTimer = window.setTimeout(() => {
            this.initialCheckTimer = null
            this.refreshPreferenceState()
            this.scheduleAutomaticCheck(true)
        }, 1000)
    }

    get snapshot (): PluginUpdateState {
        return this.state$.value
    }

    get checkInterval (): UpdateCheckInterval {
        const root = this.configStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        const interval = root.updateCheckInterval
        return interval === 'startup' || interval === 'weekly' || interval === 'never' ? interval : 'daily'
    }

    get canInstallUpdate (): boolean {
        return !pluginIdentity.devBuild
    }

    async checkNow (): Promise<void> {
        return this.checkForUpdates()
    }

    async loadHistory (force = false): Promise<void> {
        if (this.historyPromise) {
            return this.historyPromise
        }
        if (!force && this.historyState$.value.status === 'ready' && this.isHistoryCacheFresh()) {
            return
        }
        const hasCachedHistory = this.applyHistoryCache()
        if (!force && hasCachedHistory && this.isHistoryCacheFresh()) {
            return
        }
        this.historyState$.next({
            status: hasCachedHistory ? 'refreshing' : 'loading',
            entries: hasCachedHistory ? this.historyState$.value.entries : [],
            error: '',
        })
        this.historyPromise = this.performHistoryLoad()
        try {
            await this.historyPromise
        } finally {
            this.historyPromise = null
        }
    }

    async installLatest (): Promise<void> {
        // Published stable bundles cannot replace a locally namespaced Dev build.
        if (!this.canInstallUpdate) { return }
        const state = this.snapshot
        if (!state.latestVersion || !state.available || state.status === 'installing') {
            return
        }
        this.patchState({ status: 'installing', error: '' })
        try {
            await this.platform.installPlugin(quickCommandsPackageName, state.latestVersion)
            this.patchState({ status: 'restart' })
            this.config.requestRestart()
        } catch (error) {
            this.patchState({
                status: 'error',
                error: error instanceof Error ? error.message : String(error || '更新安装失败。'),
            })
        }
    }

    ignoreLatest (): void {
        const latestVersion = this.snapshot.latestVersion
        if (!latestVersion) {
            return
        }
        const root = this.configStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        root.ignoredUpdateVersion = latestVersion
        this.configStore.set(root)
    }

    setCheckInterval (interval: UpdateCheckInterval): void {
        const normalized: UpdateCheckInterval = interval === 'startup' || interval === 'weekly' || interval === 'never'
            ? interval
            : 'daily'
        const root = this.configStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        root.updateCheckInterval = normalized
        this.configStore.set(root)
    }

    requestSettingsFocus (): void {
        this.focusSettingsRequested = true
    }

    consumeSettingsFocusRequest (): boolean {
        const requested = this.focusSettingsRequested
        this.focusSettingsRequested = false
        return requested
    }

    private async checkForUpdates (): Promise<void> {
        if (!this.configStore.dataAccess.isCurrent()) { return }
        if (this.checkPromise) {
            return this.checkPromise
        }
        this.lastAttemptAt = Date.now()
        const access = this.configStore.dataAccess
        this.patchState({ status: 'checking', error: '' })
        this.checkPromise = this.performCheck()
        try {
            await this.checkPromise
        } finally {
            this.checkPromise = null
            if (access.isCurrent()) { this.scheduleAutomaticCheck() }
        }
    }

    private async performCheck (): Promise<void> {
        const access = this.configStore.dataAccess
        try {
            const latest = await this.fetchJson<{ version?: string }>(
                `https://registry.npmjs.org/${quickCommandsUpdatePackageName}/latest`,
            )
            if (!access.isCurrent()) { return }
            const latestVersion = String(latest.version || '').trim()
            if (!latestVersion) {
                throw new Error('npm 没有返回有效版本号。')
            }
            const updateNotes = await this.fetchUpdateNotesDocument(latestVersion)
            if (!access.isCurrent()) { return }
            this.cache = {
                source: 'jsdelivr-localized-v1',
                packageName: quickCommandsUpdatePackageName,
                checkedAt: new Date().toISOString(),
                latestVersion,
                updateNotes,
            }
            this.writeCache(this.cache)
            const available = isNewerPluginVersion(latestVersion, getUpdateComparisonVersion(this.snapshot.currentVersion, pluginIdentity.devBuild))
            this.patchState({
                latestVersion,
                available,
                ignored: available && this.getIgnoredVersion() === latestVersion,
                status: available ? 'available' : 'current',
                releaseNotes: formatPluginUpdateNotes(updateNotes, this.i18n.language),
                error: '',
            })
        } catch (error) {
            if (!access.isCurrent()) { return }
            this.patchState({
                status: 'error',
                error: error instanceof Error ? error.message : String(error || '检查更新失败。'),
            })
        }
    }

    private async fetchUpdateNotesDocument (version: string): Promise<unknown> {
        const url = `https://cdn.jsdelivr.net/npm/${quickCommandsUpdatePackageName}@${encodeURIComponent(version)}/${updateNotesFileName}`
        try {
            return await this.fetchJson<unknown>(url)
        } catch {
            return null
        }
    }

    private async performHistoryLoad (): Promise<void> {
        const access = this.configStore.dataAccess
        try {
            const metadata = await this.fetchJson<{
                versions?: Record<string, unknown>
                time?: Record<string, string>
            }>(`https://registry.npmjs.org/${quickCommandsUpdatePackageName}`)
            const versions = Object.keys(metadata.versions || {})
                .filter(Boolean)
                .sort((left, right) => comparePluginVersions(right, left))
            const sources = new Array<PluginUpdateHistorySourceEntry>(versions.length)
            const cachedEntries: Record<string, PluginUpdateHistoryCacheEntry> = {
                ...(this.historyCache?.entries || {}),
            }
            let cursor = 0
            const workerCount = Math.min(5, versions.length)
            const workers = Array.from({ length: workerCount }, async () => {
                while (cursor < versions.length) {
                    if (!access.isCurrent()) { return }
                    const index = cursor++
                    const version = versions[index]
                    const historyEntry = Object.prototype.hasOwnProperty.call(cachedEntries, version)
                        ? cachedEntries[version]
                        : null
                    const latestCachedDocument = version === this.cache?.latestVersion
                        ? this.cache.updateNotes
                        : undefined
                    let document: unknown
                    if (historyEntry) {
                        document = historyEntry.document
                    } else if (latestCachedDocument !== undefined && latestCachedDocument !== null) {
                        document = latestCachedDocument
                    } else {
                        const result = await this.fetchHistoryUpdateNotesDocument(version)
                        document = result.document
                        if (!result.cacheable) {
                            sources[index] = {
                                version,
                                publishedAt: typeof metadata.time?.[version] === 'string' ? metadata.time[version] : '',
                                document,
                            }
                            continue
                        }
                    }
                    cachedEntries[version] = {
                        publishedAt: typeof metadata.time?.[version] === 'string' ? metadata.time[version] : '',
                        document,
                    }
                    sources[index] = {
                        version,
                        publishedAt: typeof metadata.time?.[version] === 'string' ? metadata.time[version] : '',
                        document,
                    }
                }
            })
            await Promise.all(workers)
            if (!access.isCurrent()) { return }
            this.historyCache = {
                source: 'jsdelivr-localized-v1',
                packageName: quickCommandsUpdatePackageName,
                checkedAt: new Date().toISOString(),
                versions,
                entries: cachedEntries,
            }
            this.writeHistoryCache(this.historyCache)
            this.historySources = sources
            this.renderHistory()
        } catch (error) {
            if (!access.isCurrent()) { return }
            this.historyState$.next({
                status: 'error',
                entries: this.historyState$.value.entries,
                error: error instanceof Error ? error.message : String(error || '加载更新历史失败。'),
            })
        }
    }

    private async fetchHistoryUpdateNotesDocument (version: string): Promise<{ document: unknown; cacheable: boolean }> {
        const url = `https://cdn.jsdelivr.net/npm/${quickCommandsUpdatePackageName}@${encodeURIComponent(version)}/${updateNotesFileName}`
        try {
            return { document: await this.fetchJson<unknown>(url), cacheable: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || '')
            return { document: null, cacheable: /HTTP 404/.test(message) }
        }
    }

    private renderHistory (): void {
        if (!this.historySources.length) {
            if (this.historyState$.value.status === 'loading' || this.historyState$.value.status === 'refreshing') {
                this.historyState$.next({ status: 'ready', entries: [], error: '' })
            }
            return
        }
        this.historyState$.next({
            status: 'ready',
            entries: this.historySources.map(source => {
                const releaseNotes = formatPluginUpdateNotes(source.document, this.i18n.language)
                return {
                    version: source.version,
                    publishedAt: source.publishedAt,
                    releaseNotes,
                    hasReleaseNotes: Boolean(releaseNotes),
                }
            }),
            error: '',
        })
    }

    private async fetchJson<T> (url: string): Promise<T> {
        const controller = new AbortController()
        this.requests.add(controller)
        const timer = window.setTimeout(() => controller.abort(), 12000)
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new Error(`请求失败（HTTP ${response.status}）。`)
            }
            return await response.json() as T
        } finally {
            this.requests.delete(controller)
            window.clearTimeout(timer)
        }
    }

    private applyCache (): void {
        if (!this.cache?.latestVersion) {
            return
        }
        const available = isNewerPluginVersion(this.cache.latestVersion, getUpdateComparisonVersion(this.snapshot.currentVersion, pluginIdentity.devBuild))
        this.patchState({
            latestVersion: this.cache.latestVersion,
            available,
            ignored: available && this.getIgnoredVersion() === this.cache.latestVersion,
            status: available ? 'available' : 'current',
            releaseNotes: formatPluginUpdateNotes(this.cache.updateNotes, this.i18n.language),
        })
    }

    private refreshPreferenceState (): void {
        const state = this.snapshot
        const ignored = Boolean(state.available && state.latestVersion && this.getIgnoredVersion() === state.latestVersion)
        if (ignored !== state.ignored) {
            this.patchState({ ignored })
        }
    }

    private scheduleAutomaticCheck (runWhenDue = false): void {
        if (!this.configStore.dataAccess.isCurrent()) { return }
        if (this.checkTimer !== null) {
            window.clearTimeout(this.checkTimer)
            this.checkTimer = null
        }
        const interval = this.checkInterval
        this.scheduledInterval = interval
        if (interval === 'startup') {
            if (runWhenDue) {
                void this.checkForUpdates()
            }
            return
        }
        const delay = getNextPluginUpdateCheckDelay(
            interval,
            this.cache?.checkedAt,
            this.lastAttemptAt,
        )
        if (delay === null) {
            return
        }
        if (runWhenDue && delay === 0) {
            void this.checkForUpdates()
            return
        }
        this.checkTimer = window.setTimeout(() => void this.checkForUpdates(), Math.max(1000, delay))
    }

    private getIgnoredVersion (): string {
        const root = this.configStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        return typeof root.ignoredUpdateVersion === 'string' ? root.ignoredUpdateVersion : ''
    }

    private patchState (patch: Partial<PluginUpdateState>): void {
        this.state$.next({ ...this.snapshot, ...patch })
    }

    private readCache (): PluginUpdateCache | null {
        if (!this.cachePath || !fs.existsSync(this.cachePath)) {
            return null
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as PluginUpdateCache
            // Stable legacy caches remain valid; Dev caches from the old source must be ignored.
            const matchingPackage = parsed && (parsed.packageName === quickCommandsUpdatePackageName ||
                (!pluginIdentity.devBuild && parsed.packageName === undefined))
            return parsed && matchingPackage && parsed.source === 'jsdelivr-localized-v1' && typeof parsed.latestVersion === 'string' && typeof parsed.checkedAt === 'string'
                ? parsed
                : null
        } catch {
            return null
        }
    }

    private writeCache (cache: PluginUpdateCache): void {
        if (!this.cachePath) {
            return
        }
        try {
            this.configStore.dataAccess.write(() => {
                fs.mkdirSync(path.dirname(this.cachePath!), { recursive: true })
                fs.writeFileSync(this.cachePath!, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
            })
        } catch {
            // Update cache failures must not affect the plugin itself.
        }
    }

    private applyHistoryCache (): boolean {
        if (!this.historyCache) {
            return false
        }
        this.historySources = this.historyCache.versions.map(version => {
            const entry = this.historyCache!.entries[version]
            return {
                version,
                publishedAt: entry?.publishedAt || '',
                document: entry?.document ?? null,
            }
        })
        this.historyState$.next({
            status: 'ready',
            entries: this.historySources.map(source => {
                const releaseNotes = formatPluginUpdateNotes(source.document, this.i18n.language)
                return {
                    version: source.version,
                    publishedAt: source.publishedAt,
                    releaseNotes,
                    hasReleaseNotes: Boolean(releaseNotes),
                }
            }),
            error: '',
        })
        return true
    }

    private isHistoryCacheFresh (): boolean {
        if (!this.historyCache) {
            return false
        }
        const checkedAt = new Date(this.historyCache.checkedAt).getTime()
        if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= updateHistoryMetadataCacheMs) {
            return false
        }
        const latestVersion = this.snapshot.latestVersion
        return !latestVersion || this.historyCache.versions.includes(latestVersion)
    }

    private readHistoryCache (): PluginUpdateHistoryCache | null {
        if (!this.historyCachePath || !fs.existsSync(this.historyCachePath)) {
            return null
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.historyCachePath, 'utf8')) as PluginUpdateHistoryCache
            if (!parsed || parsed.source !== 'jsdelivr-localized-v1' || parsed.packageName !== quickCommandsUpdatePackageName ||
                typeof parsed.checkedAt !== 'string' || !Array.isArray(parsed.versions) ||
                parsed.versions.some(version => typeof version !== 'string') || !parsed.entries ||
                typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
                return null
            }
            const entries: Record<string, PluginUpdateHistoryCacheEntry> = {}
            for (const [version, value] of Object.entries(parsed.entries)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    continue
                }
                const entry = value as unknown as Record<string, unknown>
                if (typeof entry.publishedAt !== 'string' || !Object.prototype.hasOwnProperty.call(entry, 'document')) {
                    continue
                }
                entries[version] = { publishedAt: entry.publishedAt, document: entry.document }
            }
            return { ...parsed, versions: [...parsed.versions], entries }
        } catch {
            return null
        }
    }

    private writeHistoryCache (cache: PluginUpdateHistoryCache): void {
        if (!this.historyCachePath) {
            return
        }
        try {
            this.configStore.dataAccess.write(() => {
                fs.mkdirSync(path.dirname(this.historyCachePath!), { recursive: true })
                fs.writeFileSync(this.historyCachePath!, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
            })
        } catch {
            // Update history cache failures must not affect the plugin itself.
        }
    }
}
