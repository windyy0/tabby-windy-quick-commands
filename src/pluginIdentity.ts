declare const __WQC_DEV_BUILD__: boolean

export function getPluginIdentity (devBuild: boolean) {
    const dataDirectory = devBuild ? 'windy-quick-commands-dev' : 'windy-quick-commands'
    return {
        devBuild,
        dataDirectory,
        packageName: `tabby-${dataDirectory}`,
        updatePackageName: 'tabby-windy-quick-commands',
        settingsTabId: dataDirectory,
        legacyConfigKey: devBuild ? 'windyCommandCenterDev' : 'windyCommandCenter',
        toggleHotkeyId: devBuild ? 'windy-command-center-dev-toggle' : 'windy-command-center-toggle',
        configChangedEvent: `${dataDirectory}-config-changed`,
        runtimeChangedEvent: `${dataDirectory}-runtime-changed`,
        title: devBuild ? '快速命令（Dev）' : '快速命令',
        exportFileName: `tabby-${dataDirectory}-{date}.json`,
    }
}

// Plain tsc/node tests use the stable identity; webpack fixes the channel at build time.
export const pluginIdentity = getPluginIdentity(typeof __WQC_DEV_BUILD__ !== 'undefined' && __WQC_DEV_BUILD__)
