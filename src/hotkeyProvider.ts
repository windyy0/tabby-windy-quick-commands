import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { QuickCommandsI18n } from './i18n'

/** @hidden */
@Injectable()
export class QuickCommandsHotkeyProvider extends HotkeyProvider {
    constructor (private i18n: QuickCommandsI18n) {
        super()
    }

    async provide (): Promise<HotkeyDescription[]> {
        return [
            {
                id: 'windy-command-center-toggle',
                name: this.i18n.text('显示/隐藏快速命令'),
            },
        ]
    }
}
