import * as fs from 'fs'
import * as path from 'path'

import {
    normalizeCommandConfig,
    ParsedImportPayload,
    parseImportPayload,
    quickCommandsFileFormat,
    quickCommandsFileVersion,
    sanitizeAutomationReferences,
} from './commandLibrary'
import { QuickCommand } from './types'
import { pluginIdentity } from './pluginIdentity'
import { PluginDataAccess } from './pluginData'
import { parsePluginHotkeyExport } from './pluginHotkeys'

export const pluginConfigChangedEvent = pluginIdentity.configChangedEvent
export const pluginConfigFormat = quickCommandsFileFormat
export const pluginConfigVersion = quickCommandsFileVersion

export interface PluginConfigExportPayload {
    format: typeof pluginConfigFormat
    version: typeof pluginConfigVersion
    kind: 'config'
    exportedAt: string
    config: Record<string, unknown>
}

export interface PluginConfigImportFile extends Omit<ParsedImportPayload, 'config'> {
    config?: Record<string, unknown>
}

export function buildDefaultSettingsConfig (
    current: Record<string, unknown>,
    defaults: Record<string, unknown>,
): Record<string, unknown> {
    const commands = Array.isArray(current.commands) ? current.commands : []
    return {
        ...JSON.parse(JSON.stringify(defaults)),
        commands: JSON.parse(JSON.stringify(commands)),
        customCategories: Array.isArray(current.customCategories)
            ? JSON.parse(JSON.stringify(current.customCategories))
            : [],
        categoryOrder: Array.isArray(current.categoryOrder)
            ? JSON.parse(JSON.stringify(current.categoryOrder))
            : [],
        selectedCommandId: commands[0] && typeof commands[0] === 'object'
            ? String((commands[0] as Record<string, unknown>).id || '') || null
            : null,
        selectedCategory: '全部',
    }
}

export class QuickCommandsPluginConfigStore {
    readonly configPath: string | null
    readonly backupPath: string | null
    readonly dataAccess: PluginDataAccess
    private config: Record<string, unknown> | null = null

    constructor (configPath: string | null, readonly identity = pluginIdentity) {
        this.dataAccess = new PluginDataAccess(configPath, identity)
        const directory = configPath
            ? path.join(path.dirname(configPath), identity.dataDirectory)
            : null
        this.configPath = directory ? path.join(directory, 'plugin-config.json') : null
        this.backupPath = directory ? path.join(directory, 'plugin-config.backup.json') : null
    }

    exists (): boolean {
        return Boolean(this.configPath && fs.existsSync(this.configPath))
    }

    initialize (defaults: Record<string, unknown>): void {
        // A saved library (even empty), or its backup, must never be reseeded.
        if (!this.configPath || this.exists() || (this.backupPath && fs.existsSync(this.backupPath))) {
            return
        }
        this.set(this.clone(defaults))
    }

    load (fallback: Record<string, unknown>, reload = false): Record<string, unknown> {
        this.dataAccess.assertCurrent()
        if (!reload && this.config) {
            return this.config
        }
        this.config = this.readConfigFile() || this.clone(fallback)
        return this.config
    }

    set (config: Record<string, unknown>, persist = true): void {
        this.dataAccess.assertCurrent()
        if (!persist) {
            this.config = config
            return
        }
        try {
            this.dataAccess.write(() => this.writeConfigFile(config))
        } catch (error) {
            // Callers may have edited the loaded object in place. Do not retain
            // that unsaved object as the authoritative cached configuration.
            this.config = null
            throw error
        }
        this.config = config
        this.notifyChanged()
    }

    reset (defaults: Record<string, unknown>): void {
        this.dataAccess.reset(defaults)
        this.config = this.clone(defaults)
    }

    exportPayload (config: Record<string, unknown>): PluginConfigExportPayload {
        return {
            format: pluginConfigFormat,
            version: pluginConfigVersion,
            kind: 'config',
            exportedAt: new Date().toISOString(),
            config: this.clone(config),
        }
    }

    parseImportFile (text: string): PluginConfigImportFile {
        const parsed = parseImportPayload(text)
        if (parsed.kind === 'commands') {
            return parsed
        }
        return {
            ...parsed,
            config: this.normalizeImportedConfig(parsed.config as Record<string, unknown>),
        }
    }

    parseImport (text: string): Record<string, unknown> {
        const parsed = this.parseImportFile(text)
        if (parsed.kind !== 'config' || !parsed.config) {
            throw new Error('文件只包含命令，不包含插件配置。')
        }
        return parsed.config
    }

    private normalizeImportedConfig (source: Record<string, unknown>): Record<string, unknown> {
        const commands = source.commands as unknown[]
        this.validateConfigFields(source)
        const allowedKeys = [
            'commands', 'customCategories', 'categoryOrder', 'selectedCommandId', 'selectedCategory',
            'executionMode', 'targetMode', 'failureStrategy', 'drawerWidth', 'showToolbarButton',
            'drawerInitialFocus', 'focusTerminalAfterSend', 'showOperationHints', 'pluginHotkeys',
            'requireConfirmBeforeExecute', 'confirmHighRiskCommands', 'confirmBroadcast', 'exportFileName', 'basicInfoCollapsed',
            'moreSettingsCollapsed', 'previewCollapsed', 'moveNavigateAfterMove', 'recentOutputLimit', 'logLimit',
            'logRetentionMode', 'logRetentionDays', 'logSizeLimitMb', 'logWarningSizeMb', 'logSizeUnit', 'logWarningSizeUnit',
            'updateCheckInterval', 'ignoredUpdateVersion',
        ]
        const normalized = Object.fromEntries(
            allowedKeys
                .filter(key => Object.prototype.hasOwnProperty.call(source, key))
                .map(key => [key, this.clone(source[key])]),
        )
        if (source.executionMode === 'broadcast') {
            normalized.executionMode = 'paste'
            normalized.targetMode = 'all'
        }
        const createId = this.createImportIdFactory(commands)
        const normalizedCommands = commands.map(command => normalizeCommandConfig(
            command as Partial<QuickCommand>,
            createId,
        ))
        normalized.commands = sanitizeAutomationReferences(normalizedCommands).commands
            .map(command => this.stripCommandRuntime(command))
        normalized.customCategories = this.normalizeStringList(source.customCategories)
        normalized.categoryOrder = this.normalizeStringList(source.categoryOrder)
        normalized.drawerWidth = this.normalizeNumber(source.drawerWidth, 420, 760, 560)
        normalized.recentOutputLimit = this.normalizeNumber(source.recentOutputLimit, 1000, 50000, 8000)
        normalized.logLimit = this.normalizeNumber(source.logLimit, 20, 20000, 200)
        normalized.logRetentionMode = source.logRetentionMode || 'count'
        normalized.logRetentionDays = this.normalizeNumber(source.logRetentionDays, 1, 3650, 30)
        normalized.logSizeLimitMb = this.normalizeNumber(source.logSizeLimitMb, 1, 102400, 10)
        normalized.logWarningSizeMb = this.normalizeNumber(source.logWarningSizeMb, 1, 102400, 10)
        normalized.logSizeUnit = source.logSizeUnit || 'MB'
        normalized.logWarningSizeUnit = source.logWarningSizeUnit || 'MB'
        if (source.pluginHotkeys !== undefined) {
            normalized.pluginHotkeys = parsePluginHotkeyExport(source.pluginHotkeys)
        }
        const commandIds = new Set((normalized.commands as Array<{ id: string }>).map(command => command.id))
        if (typeof normalized.selectedCommandId !== 'string' || !commandIds.has(normalized.selectedCommandId)) {
            normalized.selectedCommandId = (normalized.commands as Array<{ id: string }>)[0]?.id || null
        }
        const categories = new Set([
            '全部', '常用', '收藏',
            ...(normalized.customCategories as string[]),
            ...(normalized.commands as Array<{ category: string }>).map(command => command.category),
        ])
        if (typeof normalized.selectedCategory !== 'string' || !categories.has(normalized.selectedCategory)) {
            normalized.selectedCategory = '全部'
        }
        return normalized
    }

    private readConfigFile (): Record<string, unknown> | null {
        if (!this.configPath || !fs.existsSync(this.configPath)) {
            return null
        }
        try {
            const value = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
            return value && typeof value === 'object' && !Array.isArray(value)
                ? value as Record<string, unknown>
                : null
        } catch {
            if (!this.backupPath || !fs.existsSync(this.backupPath)) {
                return null
            }
            try {
                const backup = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'))
                return backup && typeof backup === 'object' && !Array.isArray(backup)
                    ? backup as Record<string, unknown>
                    : null
            } catch {
                return null
            }
        }
    }

    private writeConfigFile (config: Record<string, unknown>): void {
        if (!this.configPath || !this.backupPath) {
            return
        }
        const directory = path.dirname(this.configPath)
        const temporaryPath = `${this.configPath}.tmp`
        fs.mkdirSync(directory, { recursive: true })
        if (fs.existsSync(this.configPath)) {
            fs.copyFileSync(this.configPath, this.backupPath)
        }
        fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
        try {
            fs.renameSync(temporaryPath, this.configPath)
        } catch {
            fs.copyFileSync(temporaryPath, this.configPath)
            fs.unlinkSync(temporaryPath)
        }
    }

    private notifyChanged (): void {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(this.identity.configChangedEvent))
        }
    }

    private clone<T> (value: T): T {
        return JSON.parse(JSON.stringify(value)) as T
    }

    private validateConfigFields (config: Record<string, unknown>): void {
        const stringFields = ['selectedCategory', 'exportFileName', 'ignoredUpdateVersion']
        stringFields.forEach(field => {
            if (config[field] !== undefined && typeof config[field] !== 'string') {
                throw new Error(`配置字段 ${field} 无效。`)
            }
        })
        if (config.selectedCommandId !== undefined && config.selectedCommandId !== null && typeof config.selectedCommandId !== 'string') {
            throw new Error('配置字段 selectedCommandId 无效。')
        }
        const booleanFields = [
            'showToolbarButton', 'requireConfirmBeforeExecute', 'confirmHighRiskCommands', 'confirmBroadcast', 'basicInfoCollapsed',
            'moreSettingsCollapsed', 'previewCollapsed', 'moveNavigateAfterMove', 'focusTerminalAfterSend',
            'showOperationHints',
        ]
        booleanFields.forEach(field => {
            if (config[field] !== undefined && typeof config[field] !== 'boolean') {
                throw new Error(`配置字段 ${field} 无效。`)
            }
        })
        const numberFields = ['drawerWidth', 'recentOutputLimit', 'logLimit', 'logRetentionDays', 'logSizeLimitMb', 'logWarningSizeMb']
        numberFields.forEach(field => {
            if (config[field] !== undefined && (
                typeof config[field] !== 'number' ||
                !Number.isFinite(config[field])
            )) {
                throw new Error(`配置字段 ${field} 无效。`)
            }
        })
        this.validateEnum(config, 'executionMode', ['paste', 'line', 'broadcast'])
        this.validateEnum(config, 'targetMode', ['current', 'all'])
        this.validateEnum(config, 'failureStrategy', ['continue', 'stop', 'manual'])
        this.validateEnum(config, 'drawerInitialFocus', ['drawer', 'terminal'])
        this.validateEnum(config, 'updateCheckInterval', ['startup', 'daily', 'weekly', 'never'])
        this.validateEnum(config, 'logRetentionMode', ['count', 'days', 'size', 'unlimited'])
        this.validateEnum(config, 'logSizeUnit', ['MB', 'GB'])
        this.validateEnum(config, 'logWarningSizeUnit', ['MB', 'GB'])
        this.validateStringList(config.customCategories, 'customCategories')
        this.validateStringList(config.categoryOrder, 'categoryOrder')
    }

    private validateEnum (config: Record<string, unknown>, field: string, allowed: string[]): void {
        if (config[field] !== undefined && !allowed.includes(String(config[field]))) {
            throw new Error(`配置字段 ${field} 无效。`)
        }
    }

    private validateStringList (value: unknown, field: string): void {
        if (value !== undefined && (
            !Array.isArray(value) ||
            value.some(item => typeof item !== 'string')
        )) {
            throw new Error(`配置字段 ${field} 无效。`)
        }
    }

    private normalizeStringList (value: unknown): string[] {
        if (!Array.isArray(value)) {
            return []
        }
        return Array.from(new Set(value
            .map(item => String(item).trim())
            .filter(Boolean)))
    }

    private normalizeNumber (value: unknown, min: number, max: number, fallback: number): number {
        const numeric = Number(value)
        return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : fallback))
    }

    private stripCommandRuntime (command: QuickCommand): Omit<QuickCommand, 'usageCount' | 'lastUsedAt'> {
        const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
        return stored
    }

    private createImportIdFactory (commands: unknown[]): () => string {
        const prefix = Date.now().toString(36)
        const usedIds = new Set<string>()
        commands.forEach(command => {
            if (!command || typeof command !== 'object' || Array.isArray(command)) {
                return
            }
            const record = command as Record<string, unknown>
            if (typeof record.id === 'string') {
                usedIds.add(record.id)
            }
            if (Array.isArray(record.automationRules)) {
                record.automationRules.forEach(rule => {
                    if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
                        const id = (rule as Record<string, unknown>).id
                        if (typeof id === 'string') {
                            usedIds.add(id)
                        }
                    }
                })
            }
        })
        let sequence = 0
        return () => {
            let id = ''
            do {
                id = `cmd-import-${prefix}-${++sequence}`
            } while (usedIds.has(id))
            usedIds.add(id)
            return id
        }
    }
}
