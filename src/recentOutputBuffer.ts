export interface OutputSubscription {
    unsubscribe: () => void
}

export interface OutputStreamLike {
    subscribe: (handler: (data: string) => void) => OutputSubscription
}

interface OutputBuffer {
    text: string
    startOffset: number
    endOffset: number
}

export class RecentOutputBufferRegistry {
    private buffers = new Map<string, OutputBuffer>()
    private subscriptions: OutputSubscription[] = []

    attach (key: string, stream: OutputStreamLike, limit: number): void {
        const bufferLimit = Math.max(1, Math.floor(Number(limit) || 1))
        this.buffers.set(key, { text: '', startOffset: 0, endOffset: 0 })
        this.subscriptions.push(stream.subscribe(data => {
            const current = this.buffers.get(key)
            if (!current) {
                return
            }
            const endOffset = current.endOffset + data.length
            const text = `${current.text}${data}`.slice(-bufferLimit)
            this.buffers.set(key, {
                text,
                startOffset: endOffset - text.length,
                endOffset,
            })
        }))
    }

    has (key: string): boolean {
        return this.buffers.has(key)
    }

    captureCursor (key: string): number | undefined {
        return this.buffers.get(key)?.endOffset
    }

    getStartOffset (key: string): number | undefined {
        return this.buffers.get(key)?.startOffset
    }

    getEndOffset (key: string): number | undefined {
        return this.buffers.get(key)?.endOffset
    }

    getSince (key: string, cursor: number): string {
        const buffer = this.buffers.get(key)
        if (!buffer) {
            return ''
        }
        return buffer.text.slice(Math.max(0, cursor - buffer.startOffset))
    }

    detach (): void {
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.subscriptions = []
        this.buffers.clear()
    }
}
