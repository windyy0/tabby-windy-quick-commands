import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCoreModule, { ConfigProvider, ConfigService, HotkeyProvider, PlatformService, ToolbarButtonProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { QuickCommandsConfigProvider } from './configProvider'
import { QuickCommandsHotkeyProvider } from './hotkeyProvider'
import { QuickCommandsSettingsTabComponent } from './quickCommandsSettingsTab.component'
import { QuickCommandsSettingsTabProvider } from './settingsTabProvider'
import { QuickCommandsToolbarButtonProvider } from './toolbarButtonProvider'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { QuickCommandsRuntimeStore } from './runtimeStorage'
import { migrateLegacyPluginConfig, readLegacyPluginConfig, removeLegacyPluginConfig } from './legacyConfigMigration'

@NgModule({
    imports: [
        CommonModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ConfigProvider, useClass: QuickCommandsConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: QuickCommandsHotkeyProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: QuickCommandsToolbarButtonProvider, multi: true },
        { provide: SettingsTabProvider, useClass: QuickCommandsSettingsTabProvider, multi: true },
    ],
    declarations: [
        QuickCommandsSettingsTabComponent,
    ],
})
export default class QuickCommandsModule {
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private runtimeStore: QuickCommandsRuntimeStore
    private configPath: string | null

    constructor (
        private config: ConfigService,
        platform: PlatformService,
    ) {
        this.configPath = platform.getConfigPath()
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.configPath)
        this.runtimeStore = new QuickCommandsRuntimeStore(this.configPath)
        this.migrateLegacyConfig()
        this.config.ready$.subscribe(() => this.migrateLegacyConfig())
        this.config.changed$.subscribe(() => this.migrateLegacyConfig())
    }

    private migrateLegacyConfig (): void {
        const legacy = this.config.store?.windyCommandCenter || readLegacyPluginConfig(this.configPath)
        if (!migrateLegacyPluginConfig(
            legacy,
            this.pluginConfigStore,
            this.runtimeStore,
        )) {
            return
        }
        delete this.config.store.windyCommandCenter
        removeLegacyPluginConfig(this.configPath)
        window.setTimeout(() => removeLegacyPluginConfig(this.configPath), 1000)
    }
}
