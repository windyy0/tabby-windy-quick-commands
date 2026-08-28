import { ConfigProvider } from 'tabby-core'
import { pluginIdentity } from './pluginIdentity'
export { defaultCommands, defaultQuickCommandsConfig, createDefaultQuickCommandsConfig } from './defaults'

/** @hidden */
export class QuickCommandsConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            [pluginIdentity.toggleHotkeyId]: [],
        },
    }
}
