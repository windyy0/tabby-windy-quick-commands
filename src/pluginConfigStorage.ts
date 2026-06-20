import * as fs from 'fs'
import * as path from 'path'

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
        if (commands.length > 5000) {
            throw new Error('配置文件包含的命令超过 5000 条。')
        }
        commands.forEach((command, index) => {
            if (!command || typeof command !== 'object' || Array.isArray(command)) {
                throw new Error(`第 ${index + 1} 条命令格式无效。`)
            }
            const item = command as Record<string, unknown>
            if (typeof item.name !== 'string' || typeof item.command !== 'string') {
                throw new Error(`第 ${index + 1} 条命令缺少有效的名称或命令内容。`)
            }
        })
        const source = config as Record<string, unknown>
        const allowedKeys = [
            'commands', 'customCategories', 'categoryOrder', 'selectedCommandId', 'selectedCategory',
            'executionMode', 'targetMode', 'failureStrategy', 'drawerWidth', 'showToolbarButton',
            'requireConfirmBeforeExecute', 'confirmBroadcast', 'exportFileName', 'basicInfoCollapsed',
            'moreSettingsCollapsed', 'previewCollapsed', 'recentOutputLimit', 'logLimit',
        ]
        return Object.fromEntries(
            allowedKeys
                .filter(key => Object.prototype.hasOwnProperty.call(source, key))
                .map(key => [key, this.clone(source[key])]),
        )
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
}
