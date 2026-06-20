import { ConfigProvider } from 'tabby-core'
export { defaultCommands, defaultQuickCommandsConfig } from './defaults'

/** @hidden */
export class QuickCommandsConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            'windy-command-center-toggle': [],
        },
    }
}
