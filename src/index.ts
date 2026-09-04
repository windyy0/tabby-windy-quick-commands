import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCoreModule, { ConfigProvider, ConfigService, HotkeyProvider, PlatformService, ToolbarButtonProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { createDefaultQuickCommandsConfig, QuickCommandsConfigProvider } from './configProvider'
import { QuickCommandsHotkeyProvider } from './hotkeyProvider'
import { QuickCommandsSettingsTabComponent } from './quickCommandsSettingsTab.component'
import { ActivityLogComponent } from './activityLog/activityLog.component'
import { QuickCommandsSettingsTabProvider } from './settingsTabProvider'
import { QuickCommandsToolbarButtonProvider } from './toolbarButtonProvider'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { QuickCommandsRuntimeStore } from './runtimeStorage'
import { migrateLegacyPluginConfig, readLegacyPluginConfig, removeLegacyPluginConfig } from './legacyConfigMigration'
import { pluginIdentity } from './pluginIdentity'
import { QuickCommandsI18n } from './i18n'
import {
    hasTabbyHotkeyConfiguration,
    migrateLegacySettingsHotkey,
    pluginHotkeyDefinitions,
    writeTabbyHotkeyBindings,
} from './pluginHotkeys'

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
        ActivityLogComponent,
    ],
})
export default class QuickCommandsModule {
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private runtimeStore: QuickCommandsRuntimeStore
    private configPath: string | null

    constructor (
        private config: ConfigService,
        platform: PlatformService,
        private i18n: QuickCommandsI18n,
    ) {
        this.configPath = platform.getConfigPath()
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.configPath)
        this.runtimeStore = new QuickCommandsRuntimeStore(this.configPath)
        this.migrateLegacyConfig()
        // LocaleService subscribes to config readiness before us and resolves the
        // actual interface language. Do not persist its temporary startup locale.
        this.config.ready$.subscribe(() => {
            this.migrateLegacyConfig()
            this.ensurePluginHotkeyDefaults()
            this.pluginConfigStore.initialize(createDefaultQuickCommandsConfig(this.i18n.language))
        })
        this.config.changed$.subscribe(() => this.migrateLegacyConfig())
    }

    private migrateLegacyConfig (): void {
        const legacy = this.config.store?.[pluginIdentity.legacyConfigKey] || readLegacyPluginConfig(this.configPath)
        if (!migrateLegacyPluginConfig(
            legacy,
            this.pluginConfigStore,
            this.runtimeStore,
        )) {
            return
        }
        if (this.config.store) {
            delete this.config.store[pluginIdentity.legacyConfigKey]
        }
        removeLegacyPluginConfig(this.configPath)
        window.setTimeout(() => removeLegacyPluginConfig(this.configPath), 1000)
    }

    private ensurePluginHotkeyDefaults (): void {
        if (!this.config.store) { return }
        const hotkeys = this.config.store.hotkeys || (this.config.store.hotkeys = {})
        let changed = migrateLegacySettingsHotkey(
            hotkeys,
            pluginIdentity.settingsHotkeyId,
            pluginIdentity.legacySettingsHotkeyId,
        )
        pluginHotkeyDefinitions.forEach(definition => {
            if (hasTabbyHotkeyConfiguration(hotkeys, definition.id)) { return }
            writeTabbyHotkeyBindings(hotkeys, definition.id, definition.defaults)
            changed = true
        })
        if (changed) {
            void this.config.save().catch(() => undefined)
        }
    }
}
