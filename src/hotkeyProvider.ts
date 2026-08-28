import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { QuickCommandsI18n } from './i18n'
import { pluginIdentity } from './pluginIdentity'

/** @hidden */
@Injectable()
export class QuickCommandsHotkeyProvider extends HotkeyProvider {
    constructor (private i18n: QuickCommandsI18n) {
        super()
    }

    async provide (): Promise<HotkeyDescription[]> {
        return [
            {
                id: pluginIdentity.toggleHotkeyId,
                name: this.i18n.text(pluginIdentity.devBuild ? '显示/隐藏快速命令（Dev）' : '显示/隐藏快速命令'),
            },
        ]
    }
}
