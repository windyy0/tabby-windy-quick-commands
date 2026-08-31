import { ConfigProvider } from 'tabby-core'
import { pluginIdentity } from './pluginIdentity'
export { defaultCommands, defaultQuickCommandsConfig, createDefaultQuickCommandsConfig } from './defaults'

/** @hidden */
export class QuickCommandsConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            [pluginIdentity.toggleHotkeyId]: [],
            // Keep the former custom action addressable long enough to migrate
            // existing bindings to Tabby's standard settings-tab action.
            [pluginIdentity.legacySettingsHotkeyId]: [],
            [pluginIdentity.focusHotkeyId]: ['Escape'],
            [pluginIdentity.hintsHotkeyId]: ['Ctrl-Alt-H'],
        },
    }
}
