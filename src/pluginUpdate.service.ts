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
import {
    createPluginUpdateSourceStats,
    getPluginUpdateSourceOrder,
    parsePluginUpdateSourceStats,
    PluginUpdateSourceGroup,
    PluginUpdateSourceName,
    PluginUpdateSourceStats,
    recordPluginUpdateSourceResult,
    shouldCalibratePluginUpdateSource,
} from './pluginUpdateSourceStats'

const packageInfo = require('../package.json') as { version?: string }

export const quickCommandsPackageName = pluginIdentity.packageName
export const quickCommandsUpdatePackageName = pluginIdentity.updatePackageName
const updateNotesFileName = 'update-notes.json'
const updateHistoryCacheFileName = 'update-history-cache.json'
const updateSourceStatsFileName = 'update-source-stats.json'
const updateHistoryMetadataCacheMs = 24 * 60 * 60 * 1000
const registryHedgeDelayMs = 300
const updateNotesHedgeDelayMs = 250
const initialUpdateCheckDelayMs = 5000
const updateRequestTimeoutMs = 12000

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
    source: 'jsdelivr-localized-v1' | 'adaptive-localized-v2'
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
    source: 'jsdelivr-localized-v1' | 'adaptive-localized-v2'
    packageName: string
    checkedAt: string
    versions: string[]
    entries: Record<string, PluginUpdateHistoryCacheEntry>
}

interface AdaptiveSourceDescriptor {
    source: PluginUpdateSourceName
    url: string
}

interface JsonSourceAttempt<T> {
    source: PluginUpdateSourceName
    ok: boolean
    status: number | null
    durationMs: number
    value?: T
    error?: unknown
}

interface AdaptiveSourceResult<T> {
    source: PluginUpdateSourceName
    value: T | null
    notFound: boolean
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
    private readonly sourceStatsPath: string | null
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
    private sourceStats: PluginUpdateSourceStats
    private manualCheckRequested = false

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
        this.sourceStatsPath = configPath
            ? path.join(path.dirname(configPath), pluginIdentity.dataDirectory, updateSourceStatsFileName)
            : null
        this.cache = this.readCache()
        this.historyCache = this.readHistoryCache()
        this.sourceStats = this.readSourceStats()
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
            this.sourceStats = createPluginUpdateSourceStats(quickCommandsUpdatePackageName)
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
        }, initialUpdateCheckDelayMs)
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
        this.manualCheckRequested = true
        try {
            await this.checkForUpdates(false)
        } finally {
            this.manualCheckRequested = false
        }
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

    private async checkForUpdates (automatic = false): Promise<void> {
        if (!this.configStore.dataAccess.isCurrent()) { return }
        if (this.checkPromise) {
            return this.checkPromise
        }
        this.lastAttemptAt = Date.now()
        const access = this.configStore.dataAccess
        this.patchState({ status: 'checking', error: '' })
        this.checkPromise = this.performCheck(automatic)
        try {
            await this.checkPromise
        } finally {
            this.checkPromise = null
            if (access.isCurrent()) { this.scheduleAutomaticCheck() }
        }
    }

    private async performCheck (retryOnce = false): Promise<void> {
        const access = this.configStore.dataAccess
        const attempts = retryOnce ? 2 : 1
        let failure: unknown = null
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                let firstApplied = false
                let firstSource: PluginUpdateSourceName | null = null
                let firstVersion = ''
                let officialVersion = ''
                const latest = await this.fetchAdaptiveJson<{ version?: string }>(
                    'registryLatest',
                    this.registrySources('/latest'),
                    registryHedgeDelayMs,
                    value => this.readValidLatestVersion(value) !== '',
                    access,
                    result => {
                        if (result.source !== 'npm') { return }
                        officialVersion = this.readValidLatestVersion(result.value)
                        if (firstApplied && officialVersion && (firstSource !== 'npm' || officialVersion !== firstVersion)) {
                            void this.applyLatestVersion(officialVersion, 'npm', access)
                        }
                    },
                )
                if (!access.isCurrent()) { return }
                const latestVersion = this.readValidLatestVersion(latest.value)
                if (!latestVersion) {
                    throw new Error('npm 没有返回有效版本号。')
                }
                firstSource = latest.source
                firstVersion = latestVersion
                await this.applyLatestVersion(latestVersion, latest.source, access)
                firstApplied = true
                if (officialVersion && (firstSource !== 'npm' || officialVersion !== firstVersion)) {
                    await this.applyLatestVersion(officialVersion, 'npm', access)
                }
                return
            } catch (error) {
                if (!access.isCurrent()) { return }
                failure = error
                if (this.manualCheckRequested) { break }
            }
        }
        this.patchState({ status: 'error', error: this.formatCheckError(failure) })
    }

    private async applyLatestVersion (
        latestVersion: string,
        source: PluginUpdateSourceName,
        access: QuickCommandsPluginConfigStore['dataAccess'],
    ): Promise<void> {
        if (!access.isCurrent()) { return }
        const knownVersion = this.snapshot.latestVersion
        if (source === 'npmmirror' && knownVersion && comparePluginVersions(latestVersion, knownVersion) < 0) {
            this.patchState({ status: this.snapshot.available ? 'available' : 'current', error: '' })
            return
        }
        const available = isNewerPluginVersion(
            latestVersion,
            getUpdateComparisonVersion(this.snapshot.currentVersion, pluginIdentity.devBuild),
        )
        let updateNotes = this.cache?.latestVersion === latestVersion ? this.cache.updateNotes : undefined
        if (available && updateNotes === undefined) {
            updateNotes = await this.fetchUpdateNotesDocument(latestVersion, access)
        }
        if (!access.isCurrent()) { return }
        const latestKnownNow = this.snapshot.latestVersion
        if (source === 'npmmirror' && latestKnownNow && comparePluginVersions(latestVersion, latestKnownNow) < 0) {
            return
        }
        this.cache = {
            source: 'adaptive-localized-v2',
            packageName: quickCommandsUpdatePackageName,
            checkedAt: new Date().toISOString(),
            latestVersion,
            ...(updateNotes !== undefined ? { updateNotes } : {}),
        }
        this.writeCache(this.cache)
        const activeStatus = this.snapshot.status === 'installing' || this.snapshot.status === 'restart'
            ? this.snapshot.status
            : available ? 'available' : 'current'
        this.patchState({
            latestVersion,
            available,
            ignored: available && this.getIgnoredVersion() === latestVersion,
            status: activeStatus,
            releaseNotes: formatPluginUpdateNotes(updateNotes, this.i18n.language),
            error: '',
        })
    }

    private async fetchUpdateNotesDocument (
        version: string,
        access: QuickCommandsPluginConfigStore['dataAccess'],
    ): Promise<unknown | undefined> {
        try {
            const result = await this.fetchUpdateNotesFromSources(version, access)
            return result.notFound ? null : result.value ?? undefined
        } catch {
            return undefined
        }
    }

    private async performHistoryLoad (): Promise<void> {
        const access = this.configStore.dataAccess
        try {
            const metadataResult = await this.fetchAdaptiveJson<{
                versions?: Record<string, unknown>
                time?: Record<string, string>
            }>(
                'registryMetadata',
                this.registrySources(''),
                registryHedgeDelayMs,
                (value, source) => {
                    if (!value || typeof value !== 'object' || !value.versions || typeof value.versions !== 'object') {
                        return false
                    }
                    const latestVersion = this.snapshot.latestVersion
                    return source === 'npm' || !latestVersion || Object.prototype.hasOwnProperty.call(value.versions, latestVersion)
                },
                access,
            )
            const metadata = metadataResult.value
            if (!metadata) {
                throw new Error('npm 没有返回有效版本记录。')
            }
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
                        const result = await this.fetchHistoryUpdateNotesDocument(version, access)
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
                source: 'adaptive-localized-v2',
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

    private async fetchHistoryUpdateNotesDocument (
        version: string,
        access: QuickCommandsPluginConfigStore['dataAccess'],
    ): Promise<{ document: unknown; cacheable: boolean }> {
        try {
            const result = await this.fetchUpdateNotesFromSources(version, access)
            return { document: result.value, cacheable: result.notFound || result.value !== null }
        } catch {
            return { document: null, cacheable: false }
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

    private registrySources (suffix: '' | '/latest'): AdaptiveSourceDescriptor[] {
        return [
            { source: 'npm', url: `https://registry.npmjs.org/${quickCommandsUpdatePackageName}${suffix}` },
            { source: 'npmmirror', url: `https://registry.npmmirror.com/${quickCommandsUpdatePackageName}${suffix}` },
        ]
    }

    private fetchUpdateNotesFromSources (
        version: string,
        access: QuickCommandsPluginConfigStore['dataAccess'],
    ): Promise<AdaptiveSourceResult<unknown>> {
        const encodedVersion = encodeURIComponent(version)
        return this.fetchAdaptiveJson<unknown>(
            'updateNotes',
            [
                {
                    source: 'jsdelivr',
                    url: `https://cdn.jsdelivr.net/npm/${quickCommandsUpdatePackageName}@${encodedVersion}/${updateNotesFileName}`,
                },
                {
                    source: 'npmmirror',
                    url: `https://registry.npmmirror.com/${quickCommandsUpdatePackageName}/${encodedVersion}/files/${updateNotesFileName}`,
                },
            ],
            updateNotesHedgeDelayMs,
            value => this.isValidUpdateNotesDocument(value, version),
            access,
        )
    }

    private readValidLatestVersion (value: { version?: string } | null | undefined): string {
        const version = typeof value?.version === 'string' ? value.version.trim() : ''
        return /^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : ''
    }

    private isValidUpdateNotesDocument (value: unknown, version: string): boolean {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false
        }
        const document = value as Record<string, unknown>
        if (typeof document.version === 'string' && document.version.trim() !== version) {
            return false
        }
        return Boolean(formatPluginUpdateNotes(value, 'zh-CN') || formatPluginUpdateNotes(value, 'en'))
    }

    private fetchAdaptiveJson<T> (
        group: PluginUpdateSourceGroup,
        sources: AdaptiveSourceDescriptor[],
        hedgeDelayMs: number,
        validate: (value: T, source: PluginUpdateSourceName) => boolean,
        access: QuickCommandsPluginConfigStore['dataAccess'],
        onValidResult?: (result: AdaptiveSourceResult<T>) => void,
    ): Promise<AdaptiveSourceResult<T>> {
        const sourceMap = new Map(sources.map(source => [source.source, source]))
        const orderedSources = getPluginUpdateSourceOrder(this.sourceStats, group)
            .map(source => sourceMap.get(source))
            .filter((source): source is AdaptiveSourceDescriptor => Boolean(source))
        const attempts = new Map<PluginUpdateSourceName, Promise<void>>()
        const completed: Array<JsonSourceAttempt<T> & { valid: boolean }> = []
        const measuredNotFoundSources = new Set<PluginUpdateSourceName>()
        let settled = false
        let hedgeTimer: number | null = null

        return new Promise<AdaptiveSourceResult<T>>((resolve, reject) => {
            const finishIfExhausted = (): void => {
                if (settled || attempts.size < orderedSources.length || completed.length < attempts.size) {
                    return
                }
                settled = true
                if (hedgeTimer !== null) { window.clearTimeout(hedgeTimer) }
                if (completed.length && completed.every(result => result.status === 404)) {
                    resolve({ source: completed[0].source, value: null, notFound: true })
                    return
                }
                const failure = [...completed].reverse().find(result => result.error)?.error
                reject(failure instanceof Error ? failure : new Error(String(failure || '请求失败。')))
            }

            const startSource = (descriptor: AdaptiveSourceDescriptor): void => {
                if (attempts.has(descriptor.source)) { return }
                if (!access.isCurrent()) {
                    if (!settled) {
                        settled = true
                        reject(new Error('更新数据已重置。'))
                    }
                    return
                }
                const promise = this.fetchJsonAttempt<T>(descriptor).then(attempt => {
                    if (!access.isCurrent()) {
                        if (!settled) {
                            settled = true
                            reject(new Error('更新数据已重置。'))
                        }
                        return
                    }
                    const valid = Boolean(attempt.ok && attempt.value !== undefined && validate(attempt.value, attempt.source))
                    completed.push({ ...attempt, valid })
                    if (attempt.status !== 404) {
                        this.recordSourceResult(group, attempt.source, valid, attempt.durationMs, access)
                    } else if (completed.some(result => result.valid)) {
                        measuredNotFoundSources.add(attempt.source)
                        this.recordSourceResult(group, attempt.source, false, attempt.durationMs, access)
                    }
                    if (valid) {
                        for (const notFound of completed.filter(result => result.status === 404 && !measuredNotFoundSources.has(result.source))) {
                            measuredNotFoundSources.add(notFound.source)
                            this.recordSourceResult(group, notFound.source, false, notFound.durationMs, access)
                        }
                        const result: AdaptiveSourceResult<T> = {
                            source: attempt.source,
                            value: attempt.value!,
                            notFound: false,
                        }
                        onValidResult?.(result)
                        if (!settled) {
                            settled = true
                            if (hedgeTimer !== null) { window.clearTimeout(hedgeTimer) }
                            resolve(result)
                            const other = orderedSources.find(source => !attempts.has(source.source))
                            const mustVerifyOfficial = group === 'registryLatest' && attempt.source === 'npmmirror'
                            if (other && (mustVerifyOfficial || shouldCalibratePluginUpdateSource(
                                this.sourceStats,
                                group,
                                other.source,
                            ))) {
                                startSource(other)
                            }
                        }
                        return
                    }
                    if (!settled) {
                        const other = orderedSources.find(source => !attempts.has(source.source))
                        if (other) {
                            startSource(other)
                        } else {
                            finishIfExhausted()
                        }
                    }
                })
                attempts.set(descriptor.source, promise)
            }

            if (!orderedSources.length) {
                reject(new Error('没有可用的更新源。'))
                return
            }
            startSource(orderedSources[0])
            if (orderedSources.length > 1) {
                hedgeTimer = window.setTimeout(() => {
                    if (!settled) { startSource(orderedSources[1]) }
                }, hedgeDelayMs)
            }
        })
    }

    private async fetchJsonAttempt<T> (descriptor: AdaptiveSourceDescriptor): Promise<JsonSourceAttempt<T>> {
        const startedAt = Date.now()
        const controller = new AbortController()
        this.requests.add(controller)
        const timer = window.setTimeout(() => controller.abort(), updateRequestTimeoutMs)
        try {
            const response = await fetch(descriptor.url, {
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            })
            if (!response.ok) {
                return {
                    source: descriptor.source,
                    ok: false,
                    status: response.status,
                    durationMs: Math.max(1, Date.now() - startedAt),
                    error: new Error(`请求失败（HTTP ${response.status}）。`),
                }
            }
            try {
                const value = await response.json() as T
                return {
                    source: descriptor.source,
                    ok: true,
                    status: response.status,
                    durationMs: Math.max(1, Date.now() - startedAt),
                    value,
                }
            } catch (error) {
                return {
                    source: descriptor.source,
                    ok: false,
                    status: response.status,
                    durationMs: Math.max(1, Date.now() - startedAt),
                    error,
                }
            }
        } catch (error) {
            return {
                source: descriptor.source,
                ok: false,
                status: null,
                durationMs: Math.max(1, Date.now() - startedAt),
                error,
            }
        } finally {
            this.requests.delete(controller)
            window.clearTimeout(timer)
        }
    }

    private recordSourceResult (
        group: PluginUpdateSourceGroup,
        source: PluginUpdateSourceName,
        success: boolean,
        durationMs: number,
        access: QuickCommandsPluginConfigStore['dataAccess'],
    ): void {
        if (!access.isCurrent()) { return }
        recordPluginUpdateSourceResult(this.sourceStats, group, source, success, durationMs)
        this.writeSourceStats(access)
    }

    private formatCheckError (error: unknown): string {
        const details = error && typeof error === 'object'
            ? error as { name?: unknown; message?: unknown }
            : null
        const name = typeof details?.name === 'string' ? details.name : ''
        const message = typeof details?.message === 'string'
            ? details.message
            : String(error || '')
        if (name === 'AbortError' || /(?:signal|operation|request).*abort|aborted without reason/i.test(message)) {
            return '请求超时，请稍后重试。'
        }
        return message || '检查更新失败。'
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
                void this.checkForUpdates(true)
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
            void this.checkForUpdates(true)
            return
        }
        this.checkTimer = window.setTimeout(() => void this.checkForUpdates(true), Math.max(1000, delay))
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
            const matchingSource = parsed?.source === 'jsdelivr-localized-v1' || parsed?.source === 'adaptive-localized-v2'
            return parsed && matchingPackage && matchingSource && typeof parsed.latestVersion === 'string' && typeof parsed.checkedAt === 'string'
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

    private readSourceStats (): PluginUpdateSourceStats {
        if (!this.sourceStatsPath || !fs.existsSync(this.sourceStatsPath)) {
            return createPluginUpdateSourceStats(quickCommandsUpdatePackageName)
        }
        try {
            return parsePluginUpdateSourceStats(
                JSON.parse(fs.readFileSync(this.sourceStatsPath, 'utf8')),
                quickCommandsUpdatePackageName,
            )
        } catch {
            return createPluginUpdateSourceStats(quickCommandsUpdatePackageName)
        }
    }

    private writeSourceStats (access: QuickCommandsPluginConfigStore['dataAccess']): void {
        if (!this.sourceStatsPath || !access.isCurrent()) {
            return
        }
        try {
            access.write(() => {
                fs.mkdirSync(path.dirname(this.sourceStatsPath!), { recursive: true })
                fs.writeFileSync(this.sourceStatsPath!, `${JSON.stringify(this.sourceStats, null, 2)}\n`, 'utf8')
            })
        } catch {
            // Source performance statistics must not affect update checks.
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
            const matchingSource = parsed?.source === 'jsdelivr-localized-v1' || parsed?.source === 'adaptive-localized-v2'
            if (!parsed || !matchingSource || parsed.packageName !== quickCommandsUpdatePackageName ||
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
