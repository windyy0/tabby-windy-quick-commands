import * as fs from 'fs'
import { dump as stringifyYaml, load as parseYaml } from 'js-yaml'

import { defaultQuickCommandsConfig } from './defaults'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { CommandUsageStats, QuickCommandsRuntimeStore } from './runtimeStorage'
import { AutomationLogEntry } from './types'

export function readLegacyPluginConfig (configPath: string | null): unknown {
    if (!configPath || !fs.existsSync(configPath)) {
        return null
    }
    try {
        const parsed = parseYaml(fs.readFileSync(configPath, 'utf8'))
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).windyCommandCenter
            : null
    } catch {
        return null
    }
}

export function removeLegacyPluginConfig (configPath: string | null): boolean {
    if (!configPath || !fs.existsSync(configPath)) {
        return false
    }
    try {
        const parsed = parseYaml(fs.readFileSync(configPath, 'utf8'))
        if (!parsed || typeof parsed !== 'object' ||
            !Object.prototype.hasOwnProperty.call(parsed, 'windyCommandCenter')) {
            return false
        }
        delete (parsed as Record<string, unknown>).windyCommandCenter
        const backupPath = `${configPath}.windy-quick-commands.backup`
        const temporaryPath = `${configPath}.windy-quick-commands.tmp`
        fs.copyFileSync(configPath, backupPath)
        fs.writeFileSync(temporaryPath, stringifyYaml(parsed, {
            lineWidth: -1,
            noRefs: true,
        }), 'utf8')
        try {
            fs.renameSync(temporaryPath, configPath)
        } catch {
            fs.copyFileSync(temporaryPath, configPath)
            fs.unlinkSync(temporaryPath)
        }
        return true
    } catch {
        return false
    }
}

export function migrateLegacyPluginConfig (
    legacy: unknown,
    pluginStore: QuickCommandsPluginConfigStore,
    runtimeStore: QuickCommandsRuntimeStore,
): boolean {
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
        return false
    }
    const source = legacy as Record<string, any>
    const commands = Array.isArray(source.commands) ? source.commands : defaultQuickCommandsConfig.commands
    const stats: CommandUsageStats = {}
    commands.forEach((command: Record<string, any>) => {
        if (command?.id) {
            stats[String(command.id)] = {
                usageCount: Math.max(0, Number(command.usageCount) || 0),
                lastUsedAt: typeof command.lastUsedAt === 'string' ? command.lastUsedAt : null,
            }
        }
    })
    runtimeStore.mergeLegacyStats(stats)
    runtimeStore.mergeLegacyLogs(
        Array.isArray(source.automationLogs) ? source.automationLogs as AutomationLogEntry[] : [],
        Math.max(20, Number(source.logLimit) || 200),
    )
    if (!pluginStore.exists()) {
        const storedCommands = commands.map((command: Record<string, any>) => {
            const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
            return stored
        })
        const migrated: Record<string, unknown> = {
            ...defaultQuickCommandsConfig,
            ...source,
            commands: storedCommands,
        }
        delete migrated.automationLogs
        delete migrated.executionSnapshots
        delete migrated.safetyWhitelist
        delete migrated.safetyBlacklist
        delete migrated.productionNamePatterns
        delete migrated.highRiskConfirmText
        pluginStore.set(migrated)
    }
    return true
}
