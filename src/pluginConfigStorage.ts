import * as fs from 'fs'
import * as path from 'path'

import {
    normalizeCommandConfig,
    sanitizeAutomationReferences,
    validateImportedCommands,
} from './commandLibrary'
import { QuickCommand } from './types'

export const pluginConfigChangedEvent = 'windy-quick-commands-config-changed'
export const pluginConfigFormat = 'tabby-windy-quick-commands-config'
export const pluginConfigVersion = 1

export interface PluginConfigExportPayload {
    format: typeof pluginConfigFormat
    version: typeof pluginConfigVersion
    exportedAt: string
    config: Record<string, unknown>
}

export class QuickCommandsPluginConfigStore {
    readonly configPath: string | null
    readonly backupPath: string | null
    private config: Record<string, unknown> | null = null

    constructor (configPath: string | null) {
        const directory = configPath
            ? path.join(path.dirname(configPath), 'windy-quick-commands')
            : null
        this.configPath = directory ? path.join(directory, 'plugin-config.json') : null
        this.backupPath = directory ? path.join(directory, 'plugin-config.backup.json') : null
    }

    exists (): boolean {
        return Boolean(this.configPath && fs.existsSync(this.configPath))
    }

    load (fallback: Record<string, unknown>, reload = false): Record<string, unknown> {
        if (!reload && this.config) {
            return this.config
        }
        this.config = this.readConfigFile() || this.clone(fallback)
        return this.config
    }

    set (config: Record<string, unknown>, persist = true): void {
        this.config = config
        if (!persist) {
            return
        }
        this.writeConfigFile(config)
        this.notifyChanged()
    }

    exportPayload (config: Record<string, unknown>): PluginConfigExportPayload {
        return {
            format: pluginConfigFormat,
            version: pluginConfigVersion,
            exportedAt: new Date().toISOString(),
            config: this.clone(config),
        }
    }

    parseImport (text: string): Record<string, unknown> {
        let parsed: unknown
        try {
            parsed = JSON.parse(text)
        } catch {
            throw new Error('JSON 格式无效。')
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('配置文件格式无效。')
        }
        const payload = parsed as Record<string, unknown>
        if (payload.format !== pluginConfigFormat || payload.version !== pluginConfigVersion) {
            throw new Error('只支持当前版本的快速命令插件配置文件。')
        }
        const config = payload.config
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('配置文件缺少 config 对象。')
        }
        const commands = (config as Record<string, unknown>).commands
        if (!Array.isArray(commands)) {
            throw new Error('配置文件缺少 commands 数组。')
        }
        validateImportedCommands(commands)
        const source = config as Record<string, unknown>
        this.validateConfigFields(source)
        const allowedKeys = [
            'commands', 'customCategories', 'categoryOrder', 'selectedCommandId', 'selectedCategory',
            'executionMode', 'targetMode', 'failureStrategy', 'drawerWidth', 'showToolbarButton',
            'requireConfirmBeforeExecute', 'confirmBroadcast', 'exportFileName', 'basicInfoCollapsed',
            'moreSettingsCollapsed', 'previewCollapsed', 'moveNavigateAfterMove', 'recentOutputLimit', 'logLimit',
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
        normalized.logLimit = this.normalizeNumber(source.logLimit, 20, 2000, 200)
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
            window.dispatchEvent(new CustomEvent(pluginConfigChangedEvent))
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
            'showToolbarButton', 'requireConfirmBeforeExecute', 'confirmBroadcast', 'basicInfoCollapsed',
            'moreSettingsCollapsed', 'previewCollapsed', 'moveNavigateAfterMove',
        ]
        booleanFields.forEach(field => {
            if (config[field] !== undefined && typeof config[field] !== 'boolean') {
                throw new Error(`配置字段 ${field} 无效。`)
            }
        })
        const numberFields = ['drawerWidth', 'recentOutputLimit', 'logLimit']
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
        this.validateEnum(config, 'updateCheckInterval', ['daily', 'weekly', 'never'])
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
