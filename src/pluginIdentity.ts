declare const __WQC_DEV_BUILD__: boolean

export function getPluginIdentity (devBuild: boolean) {
    const dataDirectory = devBuild ? 'windy-quick-commands-dev' : 'windy-quick-commands'
    const settingsTabId = dataDirectory
    return {
        devBuild,
        dataDirectory,
        packageName: `tabby-${dataDirectory}`,
        updatePackageName: 'tabby-windy-quick-commands',
        settingsTabId,
        legacyConfigKey: devBuild ? 'windyCommandCenterDev' : 'windyCommandCenter',
        toggleHotkeyId: devBuild ? 'windy-command-center-dev-toggle' : 'windy-command-center-toggle',
        settingsHotkeyId: `settings-tab.${settingsTabId}`,
        legacySettingsHotkeyId: devBuild ? 'windy-command-center-dev-settings' : 'windy-command-center-settings',
        focusHotkeyId: devBuild ? 'windy-command-center-dev-focus' : 'windy-command-center-focus',
        hintsHotkeyId: devBuild ? 'windy-command-center-dev-hints' : 'windy-command-center-hints',
        configChangedEvent: `${dataDirectory}-config-changed`,
        runtimeChangedEvent: `${dataDirectory}-runtime-changed`,
        title: devBuild ? '快速命令（Dev）' : '快速命令',
        exportFileName: `tabby-${dataDirectory}-{date}.json`,
    }
}

// Plain tsc/node tests use the stable identity; webpack fixes the channel at build time.
export const pluginIdentity = getPluginIdentity(typeof __WQC_DEV_BUILD__ !== 'undefined' && __WQC_DEV_BUILD__)
