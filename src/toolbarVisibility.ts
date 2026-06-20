export function shouldShowToolbarButton (config: unknown): boolean {
    if (!config || typeof config !== 'object') {
        return true
    }
    return (config as Record<string, unknown>).showToolbarButton !== false
}
