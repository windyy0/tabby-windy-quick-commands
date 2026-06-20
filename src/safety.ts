export interface DangerCheckResult {
    dangerous: boolean
    reasons: string[]
    requiresTypedConfirm: boolean
}

const builtInChecks: Array<[RegExp, string, boolean]> = [
    [/\brm\s+-rf\b/i, '包含强制递归删除', true],
    [/\bdel\s+\/[fsq]/i, '包含 Windows 强制删除', true],
    [/\brmdir\s+\/s\b/i, '包含目录递归删除', true],
    [/\bshutdown\b/i, '包含关机命令', true],
    [/\breboot\b/i, '包含重启命令', true],
    [/\bmkfs\b/i, '包含格式化文件系统', true],
    [/\bdd\s+if=/i, '包含磁盘写入命令', true],
    [/\bdocker\s+system\s+prune\b/i, '包含 Docker 清理命令', false],
    [/\bkubectl\s+delete\b/i, '包含 Kubernetes 删除命令', true],
    [/\bdrop\s+database\b/i, '包含删除数据库', true],
    [/\btruncate\s+table\b/i, '包含清空表数据', true],
]

export function getDangerCheck (command: string): DangerCheckResult {
    const matches = builtInChecks.filter(([pattern]) => pattern.test(command))

    return {
        dangerous: matches.length > 0,
        reasons: matches.map(([, reason]) => reason),
        requiresTypedConfirm: matches.some(([, , highRisk]) => highRisk),
    }
}
