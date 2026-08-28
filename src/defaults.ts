import { QuickCommand } from './types'
import { pluginIdentity } from './pluginIdentity'
import { getPluginLanguage } from './translations'

export const defaultCommands: QuickCommand[] = [
    {
        id: 'example-command',
        name: '示例命令',
        description: '输出一条示例消息，可修改为自己的命令',
        category: '默认',
        command: 'echo Hello Tabby',
        autoEnter: true,
        lineDelay: 300,
        lineDelays: [],
        linePauses: [],
        shortcut: '',
        favorite: true,
        pinned: false,
        usageCount: 0,
        lastUsedAt: null,
        automationRules: [],
    },
]

export const defaultQuickCommandsConfig = {
    commands: defaultCommands.map(command => {
        const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
        return stored
    }),
    customCategories: ['默认'],
    categoryOrder: [],
    selectedCommandId: 'example-command',
    selectedCategory: '全部',
    executionMode: 'paste',
    targetMode: 'current',
    failureStrategy: 'manual',
    drawerWidth: 560,
    showToolbarButton: true,
    requireConfirmBeforeExecute: false,
    confirmBroadcast: true,
    exportFileName: pluginIdentity.exportFileName,
    basicInfoCollapsed: true,
    moreSettingsCollapsed: true,
    previewCollapsed: false,
    moveNavigateAfterMove: false,
    recentOutputLimit: 8000,
    logLimit: 200,
    updateCheckInterval: 'daily',
    ignoredUpdateVersion: '',
}

// These names become editable user data, not live-translated interface labels.
export function createDefaultQuickCommandsConfig (locale: string | null | undefined): typeof defaultQuickCommandsConfig {
    const config: typeof defaultQuickCommandsConfig = JSON.parse(JSON.stringify(defaultQuickCommandsConfig))
    if (getPluginLanguage(locale) === 'en') {
        config.customCategories = ['Default']
        config.commands[0].category = 'Default'
        config.commands[0].name = 'Example command'
        config.commands[0].description = 'Print an example message; edit this to use your own command'
    }
    return config
}
