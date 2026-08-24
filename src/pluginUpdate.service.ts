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

import { defaultQuickCommandsConfig } from './configProvider'
import { QuickCommandsI18n } from './i18n'
import { pluginConfigChangedEvent, QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import {
    comparePluginVersions,
    formatPluginUpdateNotes,
    getNextPluginUpdateCheckDelay,
    isNewerPluginVersion,
    UpdateCheckInterval,
} from './pluginUpdate'

const packageInfo = require('../package.json') as { version?: string }

export const quickCommandsPackageName = 'tabby-windy-quick-commands'
const updateNotesFileName = 'update-notes.json'

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

export type PluginUpdateHistoryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface PluginUpdateHistoryState {
    status: PluginUpdateHistoryStatus
    entries: PluginUpdateHistoryEntry[]
    error: string
}

interface PluginUpdateCache {
    source: 'jsdelivr-localized-v1'
    checkedAt: string
    latestVersion: string
    updateNotes?: unknown
}

interface PluginUpdateHistorySourceEntry {
    version: string
    publishedAt: string
    document: unknown
}

@Injectable({ providedIn: 'root' })
export class QuickCommandsPluginUpdateService {
    readonly state$: BehaviorSubject<PluginUpdateState>
    readonly historyState$ = new BehaviorSubject<PluginUpdateHistoryState>({
        status: 'idle',
        entries: [],
        error: '',
    })
    private readonly configStore: QuickCommandsPluginConfigStore
    private readonly cachePath: string | null
    private checkPromise: Promise<void> | null = null
    private checkTimer: number | null = null
    private scheduledInterval: UpdateCheckInterval | null = null
    private lastAttemptAt = 0
    private focusSettingsRequested = false
    private cache: PluginUpdateCache | null = null
    private historyPromise: Promise<void> | null = null
    private historySources: PluginUpdateHistorySourceEntry[] = []

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
            ? path.join(path.dirname(configPath), 'windy-quick-commands', 'update-cache.json')
            : null
        this.cache = this.readCache()
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
        window.setTimeout(() => {
            this.refreshPreferenceState()
            this.scheduleAutomaticCheck(true)
        }, 1000)
    }

    get snapshot (): PluginUpdateState {
        return this.state$.value
    }

    get checkInterval (): UpdateCheckInterval {
        const root = this.configStore.load(defaultQuickCommandsConfig, true)
        const interval = root.updateCheckInterval
        return interval === 'weekly' || interval === 'never' ? interval : 'daily'
    }

    async checkNow (): Promise<void> {
        return this.checkForUpdates()
    }

    async loadHistory (force = false): Promise<void> {
        if (this.historyPromise) {
            return this.historyPromise
        }
        if (!force && this.historyState$.value.status === 'ready') {
            return
        }
        this.historyState$.next({
            status: 'loading',
            entries: force ? [] : this.historyState$.value.entries,
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
        const root = this.configStore.load(defaultQuickCommandsConfig, true)
        root.ignoredUpdateVersion = latestVersion
        this.configStore.set(root)
    }

    setCheckInterval (interval: UpdateCheckInterval): void {
        const normalized: UpdateCheckInterval = interval === 'weekly' || interval === 'never' ? interval : 'daily'
        const root = this.configStore.load(defaultQuickCommandsConfig, true)
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
        if (this.checkPromise) {
            return this.checkPromise
        }
        this.lastAttemptAt = Date.now()
        this.patchState({ status: 'checking', error: '' })
        this.checkPromise = this.performCheck()
        try {
            await this.checkPromise
        } finally {
            this.checkPromise = null
            this.scheduleAutomaticCheck()
        }
    }

    private async performCheck (): Promise<void> {
        try {
            const latest = await this.fetchJson<{ version?: string }>(
                `https://registry.npmjs.org/${quickCommandsPackageName}/latest`,
            )
            const latestVersion = String(latest.version || '').trim()
            if (!latestVersion) {
                throw new Error('npm 没有返回有效版本号。')
            }
            const updateNotes = await this.fetchUpdateNotesDocument(latestVersion)
            this.cache = {
                source: 'jsdelivr-localized-v1',
                checkedAt: new Date().toISOString(),
                latestVersion,
                updateNotes,
            }
            this.writeCache(this.cache)
            const available = isNewerPluginVersion(latestVersion, this.snapshot.currentVersion)
            this.patchState({
                latestVersion,
                available,
                ignored: available && this.getIgnoredVersion() === latestVersion,
                status: available ? 'available' : 'current',
                releaseNotes: formatPluginUpdateNotes(updateNotes, this.i18n.language),
                error: '',
            })
        } catch (error) {
            this.patchState({
                status: 'error',
                error: error instanceof Error ? error.message : String(error || '检查更新失败。'),
            })
        }
    }

    private async fetchUpdateNotesDocument (version: string): Promise<unknown> {
        const url = `https://cdn.jsdelivr.net/npm/${quickCommandsPackageName}@${encodeURIComponent(version)}/${updateNotesFileName}`
        try {
            return await this.fetchJson<unknown>(url)
        } catch {
            return null
        }
    }

    private async performHistoryLoad (): Promise<void> {
        try {
            const metadata = await this.fetchJson<{
                versions?: Record<string, unknown>
                time?: Record<string, string>
            }>(`https://registry.npmjs.org/${quickCommandsPackageName}`)
            const versions = Object.keys(metadata.versions || {})
                .filter(Boolean)
                .sort((left, right) => comparePluginVersions(right, left))
            const sources = new Array<PluginUpdateHistorySourceEntry>(versions.length)
            let cursor = 0
            const workerCount = Math.min(5, versions.length)
            const workers = Array.from({ length: workerCount }, async () => {
                while (cursor < versions.length) {
                    const index = cursor++
                    const version = versions[index]
                    const cachedDocument = version === this.cache?.latestVersion
                        ? this.cache.updateNotes
                        : undefined
                    const document = cachedDocument !== undefined
                        ? cachedDocument
                        : await this.fetchUpdateNotesDocument(version)
                    sources[index] = {
                        version,
                        publishedAt: typeof metadata.time?.[version] === 'string' ? metadata.time[version] : '',
                        document,
                    }
                }
            })
            await Promise.all(workers)
            this.historySources = sources
            this.renderHistory()
        } catch (error) {
            this.historyState$.next({
                status: 'error',
                entries: [],
                error: error instanceof Error ? error.message : String(error || '加载更新历史失败。'),
            })
        }
    }

    private renderHistory (): void {
        if (!this.historySources.length) {
            if (this.historyState$.value.status === 'loading') {
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
            window.clearTimeout(timer)
        }
    }

    private applyCache (): void {
        if (!this.cache?.latestVersion) {
            return
        }
        const available = isNewerPluginVersion(this.cache.latestVersion, this.snapshot.currentVersion)
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
        if (this.checkTimer !== null) {
            window.clearTimeout(this.checkTimer)
            this.checkTimer = null
        }
        const interval = this.checkInterval
        this.scheduledInterval = interval
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
        const root = this.configStore.load(defaultQuickCommandsConfig, true)
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
            return parsed && parsed.source === 'jsdelivr-localized-v1' && typeof parsed.latestVersion === 'string' && typeof parsed.checkedAt === 'string'
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
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true })
            fs.writeFileSync(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
        } catch {
            // Update cache failures must not affect the plugin itself.
        }
    }
}
