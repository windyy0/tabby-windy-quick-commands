import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { QuickCommandsSettingsTabComponent } from './quickCommandsSettingsTab.component'
import { QuickCommandsI18n } from './i18n'

@Injectable()
export class QuickCommandsSettingsTabProvider extends SettingsTabProvider {
    id = 'windy-quick-commands'
    icon = 'clone'
    title: string
    weight = 52

    constructor (i18n: QuickCommandsI18n) {
        super()
        this.title = i18n.text('快速命令')
        i18n.localeChanged$.subscribe(() => {
            this.title = i18n.text('快速命令')
        })
    }

    getComponentType (): any {
        return QuickCommandsSettingsTabComponent
    }
}
