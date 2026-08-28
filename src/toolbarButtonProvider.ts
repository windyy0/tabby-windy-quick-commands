import { Injectable } from '@angular/core'
import { IToolbarButton, PlatformService, ToolbarButtonProvider } from 'tabby-core'
import { QuickCommandsService } from './quickCommands.service'
import { shouldShowToolbarButton } from './toolbarVisibility'
import { createDefaultQuickCommandsConfig } from './configProvider'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { removeLegacyPluginConfig } from './legacyConfigMigration'
import { QuickCommandsI18n } from './i18n'
import { pluginIdentity } from './pluginIdentity'
import { quickCommandIcons } from './quickCommandsIcons'
import { pluginDataResetEvent } from './pluginData'

/** @hidden */
@Injectable()
export class QuickCommandsToolbarButtonProvider extends ToolbarButtonProvider {
    private configStore: QuickCommandsPluginConfigStore
    private tabbyConfigPath: string | null

    constructor (
        private quickCommands: QuickCommandsService,
        platform: PlatformService,
        private i18n: QuickCommandsI18n,
    ) {
        super()
        this.tabbyConfigPath = platform.getConfigPath()
        this.configStore = new QuickCommandsPluginConfigStore(this.tabbyConfigPath)
        window.addEventListener(pluginDataResetEvent, () => {
            this.configStore = new QuickCommandsPluginConfigStore(this.tabbyConfigPath)
        })
    }

    provide (): IToolbarButton[] {
        if (this.configStore.exists()) {
            removeLegacyPluginConfig(this.tabbyConfigPath)
        }
        const config = this.configStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        if (!shouldShowToolbarButton(config)) {
            return []
        }
        return [
            {
                icon: quickCommandIcons.bolt,
                title: this.i18n.text(pluginIdentity.title),
                touchBarTitle: this.i18n.text(pluginIdentity.title),
                weight: 8,
                click: () => this.quickCommands.toggle(),
            },
        ]
    }
}
