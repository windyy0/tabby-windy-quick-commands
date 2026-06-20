import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'
import { getPluginLanguage, translatePluginText } from './translations'

const translatableAttributes = ['aria-label', 'placeholder', 'title', 'data-tooltip']

@Injectable({ providedIn: 'root' })
export class QuickCommandsI18n {
    private textSources = new WeakMap<Node, { source: string, rendered: string }>()
    private attributeSources = new WeakMap<HTMLElement, Record<string, { source: string, rendered: string }>>()

    constructor (private locale: LocaleService) {}

    get localeChanged$ () {
        return this.locale.localeChanged$
    }

    text (source: string): string {
        return translatePluginText(source, this.locale.getLocale())
    }

    isChinese (): boolean {
        return getPluginLanguage(this.locale.getLocale()) === 'zh-CN'
    }

    localizeElement (root: HTMLElement): void {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
            const parent = node.parentElement
            if (parent && !parent.closest('textarea, pre, code, [data-i18n-skip]')) {
                const current = node.nodeValue || ''
                const cached = this.textSources.get(node)
                const source = !cached || current !== cached.rendered ? current : cached.source
                const rendered = this.text(source)
                this.textSources.set(node, { source, rendered })
                if (current !== rendered) {
                    node.nodeValue = rendered
                }
            }
            node = walker.nextNode()
        }

        for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
            const cachedAttributes = this.attributeSources.get(element) || {}
            for (const attribute of translatableAttributes) {
                const value = element.getAttribute(attribute)
                if (value) {
                    const cached = cachedAttributes[attribute]
                    const source = !cached || value !== cached.rendered ? value : cached.source
                    const rendered = this.text(source)
                    cachedAttributes[attribute] = { source, rendered }
                    if (value !== rendered) {
                        element.setAttribute(attribute, rendered)
                    }
                }
            }
            this.attributeSources.set(element, cachedAttributes)
        }
    }

    observe (root: HTMLElement): () => void {
        this.localizeElement(root)
        if (this.isChinese()) {
            return () => undefined
        }

        let frame: number | null = null
        const observer = new MutationObserver(() => {
            if (frame !== null) {
                return
            }
            frame = window.requestAnimationFrame(() => {
                frame = null
                this.localizeElement(root)
            })
        })
        observer.observe(root, { childList: true, subtree: true, characterData: true })
        return () => {
            observer.disconnect()
            if (frame !== null) {
                window.cancelAnimationFrame(frame)
            }
        }
    }
}
