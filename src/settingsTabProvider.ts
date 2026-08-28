import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { QuickCommandsSettingsTabComponent } from './quickCommandsSettingsTab.component'
import { QuickCommandsI18n } from './i18n'
import { pluginIdentity } from './pluginIdentity'

@Injectable()
export class QuickCommandsSettingsTabProvider extends SettingsTabProvider {
    id = pluginIdentity.settingsTabId
    icon = 'clone'
    title: string
    weight = 52

    constructor (i18n: QuickCommandsI18n) {
        super()
        this.title = i18n.text(pluginIdentity.title)
        i18n.localeChanged$.subscribe(() => {
            this.title = i18n.text(pluginIdentity.title)
        })
    }

    getComponentType (): any {
        return QuickCommandsSettingsTabComponent
    }
}
