import { Injectable } from '@angular/core'
import { IToolbarButton, PlatformService, ToolbarButtonProvider } from 'tabby-core'
import { QuickCommandsService } from './quickCommands.service'
import { shouldShowToolbarButton } from './toolbarVisibility'
import { defaultQuickCommandsConfig } from './configProvider'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { removeLegacyPluginConfig } from './legacyConfigMigration'
import { QuickCommandsI18n } from './i18n'

const lightningIcon = `
<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
  <path d="M781.01 104.89H422.56c-69.47 0-125.99 56.52-125.99 125.99v33.53h-57.92c-71.72 0-130.06 58.34-130.06 130.06v393.14c0 71.72 58.34 130.06 130.06 130.06h371.41c71.72 0 130.06-58.34 130.06-130.06v-57.1H781c69.47 0 125.99-56.52 125.99-125.99V230.88c0.01-69.47-56.51-125.99-125.98-125.99zM672.27 787.62c0 34.3-27.9 62.2-62.2 62.2H238.66c-34.3 0-62.2-27.9-62.2-62.2V394.47c0-34.3 27.9-62.2 62.2-62.2h57.92v272.24c0 69.47 56.52 125.99 125.99 125.99h249.7v57.12z m0-124.97h-249.7c-32.05 0-58.13-26.08-58.13-58.13V332.28h245.63c34.3 0 62.2 27.9 62.2 62.2v268.17z m166.87-58.13c0 32.05-26.07 58.13-58.13 58.13h-40.88V394.47c0-71.72-58.34-130.06-130.06-130.06H364.44v-33.53c0-32.05 26.07-58.13 58.13-58.13h358.45c32.05 0 58.13 26.08 58.13 58.13v373.64z"/>
</svg>`

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
    }

    provide (): IToolbarButton[] {
        if (this.configStore.exists()) {
            removeLegacyPluginConfig(this.tabbyConfigPath)
        }
        const config = this.configStore.load(defaultQuickCommandsConfig, true)
        if (!shouldShowToolbarButton(config)) {
            return []
        }
        return [
            {
                icon: lightningIcon,
                title: this.i18n.text('快速命令'),
                touchBarTitle: this.i18n.text('快速命令'),
                weight: 8,
                click: () => this.quickCommands.toggle(),
            },
        ]
    }
}
