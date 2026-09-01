export type PluginUpdateSourceGroup = 'registryLatest' | 'registryMetadata' | 'updateNotes'
export type PluginUpdateSourceName = 'npm' | 'npmmirror' | 'jsdelivr'

export interface PluginUpdateSourceMetric {
    samples: number
    averageMs: number
    successRate: number
    consecutiveFailures: number
    lastTestedAt: string
}

export interface PluginUpdateSourceStats {
    version: 1
    packageName: string
    updatedAt: string
    groups: Record<PluginUpdateSourceGroup, Partial<Record<PluginUpdateSourceName, PluginUpdateSourceMetric>>>
}

export const pluginUpdateSourceCandidates: Record<PluginUpdateSourceGroup, PluginUpdateSourceName[]> = {
    registryLatest: ['npm', 'npmmirror'],
    registryMetadata: ['npm', 'npmmirror'],
    updateNotes: ['jsdelivr', 'npmmirror'],
}

const sourceStatsWeight = 0.3
const sourceCalibrationMs = 24 * 60 * 60 * 1000

export function createPluginUpdateSourceStats (packageName: string): PluginUpdateSourceStats {
    return {
        version: 1,
        packageName,
        updatedAt: '',
        groups: {
            registryLatest: {},
            registryMetadata: {},
            updateNotes: {},
        },
    }
}

export function parsePluginUpdateSourceStats (value: unknown, packageName: string): PluginUpdateSourceStats {
    const result = createPluginUpdateSourceStats(packageName)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return result
    }
    const root = value as Record<string, unknown>
    if (root.version !== 1 || root.packageName !== packageName || !root.groups ||
        typeof root.groups !== 'object' || Array.isArray(root.groups)) {
        return result
    }
    const groups = root.groups as Record<string, unknown>
    for (const group of Object.keys(pluginUpdateSourceCandidates) as PluginUpdateSourceGroup[]) {
        const rawGroup = groups[group]
        if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
            continue
        }
        for (const source of pluginUpdateSourceCandidates[group]) {
            const rawMetric = (rawGroup as Record<string, unknown>)[source]
            if (!rawMetric || typeof rawMetric !== 'object' || Array.isArray(rawMetric)) {
                continue
            }
            const metric = rawMetric as Record<string, unknown>
            if (!Number.isFinite(metric.samples) || Number(metric.samples) < 1 ||
                !Number.isFinite(metric.averageMs) || Number(metric.averageMs) < 0 ||
                !Number.isFinite(metric.successRate) || Number(metric.successRate) < 0 || Number(metric.successRate) > 1 ||
                !Number.isFinite(metric.consecutiveFailures) || Number(metric.consecutiveFailures) < 0 ||
                typeof metric.lastTestedAt !== 'string') {
                continue
            }
            result.groups[group][source] = {
                samples: Math.floor(Number(metric.samples)),
                averageMs: Number(metric.averageMs),
                successRate: Number(metric.successRate),
                consecutiveFailures: Math.floor(Number(metric.consecutiveFailures)),
                lastTestedAt: metric.lastTestedAt,
            }
        }
    }
    result.updatedAt = typeof root.updatedAt === 'string' ? root.updatedAt : ''
    return result
}

export function recordPluginUpdateSourceResult (
    stats: PluginUpdateSourceStats,
    group: PluginUpdateSourceGroup,
    source: PluginUpdateSourceName,
    success: boolean,
    durationMs: number,
    now = Date.now(),
): void {
    const previous = stats.groups[group][source]
    const normalizedDuration = Math.max(1, Number.isFinite(durationMs) ? durationMs : 12000)
    const sample = success ? 1 : 0
    stats.groups[group][source] = {
        samples: (previous?.samples || 0) + 1,
        averageMs: previous
            ? previous.averageMs * (1 - sourceStatsWeight) + normalizedDuration * sourceStatsWeight
            : normalizedDuration,
        successRate: previous
            ? previous.successRate * (1 - sourceStatsWeight) + sample * sourceStatsWeight
            : sample,
        consecutiveFailures: success ? 0 : (previous?.consecutiveFailures || 0) + 1,
        lastTestedAt: new Date(now).toISOString(),
    }
    stats.updatedAt = new Date(now).toISOString()
}

function sourceScore (metric: PluginUpdateSourceMetric | undefined): number {
    if (!metric) {
        return Number.POSITIVE_INFINITY
    }
    const reliability = Math.max(0.1, metric.successRate)
    return metric.averageMs / reliability + metric.consecutiveFailures * 2000
}

export function getPluginUpdateSourceOrder (
    stats: PluginUpdateSourceStats,
    group: PluginUpdateSourceGroup,
): PluginUpdateSourceName[] {
    const defaults = pluginUpdateSourceCandidates[group]
    const first = stats.groups[group][defaults[0]]
    const second = stats.groups[group][defaults[1]]
    if (!first || !second) {
        return [...defaults]
    }
    const firstScore = sourceScore(first)
    const secondScore = sourceScore(second)
    const shouldSwitch = first.consecutiveFailures > 0 || secondScore <= firstScore * 0.8
    return shouldSwitch ? [defaults[1], defaults[0]] : [...defaults]
}

export function shouldCalibratePluginUpdateSource (
    stats: PluginUpdateSourceStats,
    group: PluginUpdateSourceGroup,
    source: PluginUpdateSourceName,
    now = Date.now(),
): boolean {
    const metric = stats.groups[group][source]
    if (!metric) {
        return true
    }
    const testedAt = new Date(metric.lastTestedAt).getTime()
    return !Number.isFinite(testedAt) || now - testedAt >= sourceCalibrationMs
}
