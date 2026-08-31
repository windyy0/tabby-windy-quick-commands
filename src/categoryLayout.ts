export interface CategoryWidth {
    category: string
    width: number
}

export function fitCategoryPrefix (
    categories: readonly CategoryWidth[],
    availableWidth: number,
    gap: number,
): string[] {
    const visible: string[] = []
    const available = Math.max(0, availableWidth)
    const spacing = Math.max(0, gap)
    let used = 0

    for (const item of categories) {
        const width = Math.max(0, item.width)
        const nextUsed = used + (visible.length ? spacing : 0) + width
        if (nextUsed > available) {
            break
        }
        visible.push(item.category)
        used = nextUsed
    }

    return visible
}
