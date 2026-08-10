export interface DangerCheckResult {
    dangerous: boolean
    reasons: string[]
    requiresTypedConfirm: boolean
}

type DangerMatcher = RegExp | ((command: string) => boolean)

const commandWrappers = new Set(['busybox', 'command', 'doas', 'env', 'nohup', 'sudo', 'toybox'])
const gitGlobalOptionsWithValue = new Set([
    '-C', '-c',
    '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
])
const unixBlockDevicePatterns = [
    /^\/dev\/(?:sd|hd|vd|xvd)[a-z]+\d*$/i,
    /^\/dev\/nvme\d+n\d+(?:p\d+)?$/i,
    /^\/dev\/mmcblk\d+(?:p\d+)?$/i,
    /^\/dev\/r?disk\d+(?:s\d+)?$/i,
    /^\/dev\/(?:md\d+(?:p\d+)?|dm-\d+|loop\d+(?:p\d+)?|nbd\d+(?:p\d+)?|zram\d+)$/i,
    /^\/dev\/dasd[a-z]+\d*$/i,
    /^\/dev\/(?:ada|da|nda|nvd|vtbd)\d+(?:p\d+)?$/i,
    /^\/dev\/disk\/by-(?:id|path|uuid|label|partuuid|partlabel)\/.+$/i,
    /^\/dev\/mapper\/.+$/i,
    /^\/dev\/zvol\/.+$/i,
    /^\/dev\/root$/i,
]
const nonLvmDeviceDirectories = new Set([
    'block', 'bus', 'char', 'cpu', 'disk', 'dri', 'fd', 'hugepages', 'input', 'mapper',
    'mqueue', 'net', 'pts', 'serial', 'shm', 'snd', 'vfio',
])

const builtInChecks: Array<[DangerMatcher, string, boolean]> = [
    [
        /\brm\b(?=[^\r\n;&|]*(?:--recursive\b|-[a-z]*r[a-z]*\b))(?=[^\r\n;&|]*(?:--force\b|-[a-z]*f[a-z]*\b))/i,
        '包含强制递归删除',
        true,
    ],
    [
        /\bremove-item\b(?=[^\r\n;&|]*-recurse\b)(?=[^\r\n;&|]*-force\b)/i,
        '包含 PowerShell 强制递归删除',
        true,
    ],
    [/\b(?:del|erase)\b[^\r\n;&|]*\/[fsq]\b/i, '包含 Windows 强制删除', true],
    [/\b(?:rmdir|rd)\b[^\r\n;&|]*\/s\b/i, '包含目录递归删除', true],
    [/\b(?:shutdown|reboot|restart-computer|stop-computer)\b/i, '包含关机或重启命令', true],
    [/\b(?:mkfs(?:\.[a-z0-9]+)?|format-volume|clear-disk)\b/i, '包含格式化或清空磁盘', true],
    [/\bformat(?:\.com)?\s+(?:[a-z]:|\\\\\.\\)/i, '包含 Windows 磁盘格式化', true],
    [isDirectDeviceWrite, '包含直接磁盘写入', true],
    [/\bdocker\s+(?:system|volume|builder|network)\s+prune\b/i, '包含 Docker 清理命令', false],
    [/\bkubectl\s+delete\b/i, '包含 Kubernetes 删除命令', true],
    [/\bterraform\s+destroy\b/i, '包含 Terraform 资源销毁', true],
    [isDestructiveGitClean, '包含 Git 强制清理未跟踪文件', true],
    [/\bgit\s+reset\s+--hard\b/i, '包含 Git 强制重置', true],
    [/\bdrop\s+(?:database|schema|table)\b/i, '包含删除数据库对象', true],
    [/\btruncate\s+table\b/i, '包含清空表数据', true],
]

export function getDangerCheck (command: string): DangerCheckResult {
    const matches = builtInChecks.filter(([matcher]) => (
        typeof matcher === 'function' ? matcher(command) : matcher.test(command)
    ))

    return {
        dangerous: matches.length > 0,
        reasons: matches.map(([, reason]) => reason),
        requiresTypedConfirm: matches.some(([, , highRisk]) => highRisk),
    }
}

function isDestructiveGitClean (command: string): boolean {
    return tokenizeShellCommands(command).some(tokens => {
        const options = getGitCleanOptions(tokens)
        return options ? hasDestructiveGitCleanOptions(options) : false
    })
}

function isDirectDeviceWrite (command: string): boolean {
    return tokenizeShellCommands(command).some(tokens => {
        const ddIndex = findCommandIndex(tokens, 'dd')
        if (ddIndex < 0) {
            return false
        }
        return tokens.slice(ddIndex + 1).some(token => {
            const output = /^of=(.+)$/i.exec(token)
            return output ? isBlockDevicePath(output[1]) : false
        })
    })
}

function getGitCleanOptions (tokens: string[]): string[] | null {
    const gitIndex = findCommandIndex(tokens, 'git')
    if (gitIndex < 0) {
        return null
    }
    let index = gitIndex + 1
    while (index < tokens.length) {
        const token = tokens[index]
        if (token === '--') {
            index++
            break
        }
        if (!token.startsWith('-')) {
            break
        }
        const optionName = token.split('=', 1)[0]
        index += gitGlobalOptionsWithValue.has(optionName) && !token.includes('=') ? 2 : 1
    }
    if (tokens[index]?.toLowerCase() !== 'clean') {
        return null
    }
    return tokens.slice(index + 1)
}

function hasDestructiveGitCleanOptions (options: string[]): boolean {
    let force = false
    let dryRun = false
    for (let index = 0; index < options.length; index++) {
        const option = options[index]
        if (option === '--') {
            break
        }
        if (option === '--exclude') {
            index++
            continue
        }
        if (option.startsWith('--exclude=')) {
            continue
        }
        if (option === '--force') {
            force = true
            continue
        }
        if (option === '--dry-run') {
            dryRun = true
            continue
        }
        if (/^-[^-]/.test(option)) {
            const shortOptions = option.slice(1)
            for (let flagIndex = 0; flagIndex < shortOptions.length; flagIndex++) {
                const flag = shortOptions[flagIndex]
                if (flag === 'e') {
                    if (flagIndex === shortOptions.length - 1) {
                        index++
                    }
                    break
                }
                force = force || flag === 'f'
                dryRun = dryRun || flag === 'n'
            }
        }
    }
    return force && !dryRun
}

function findCommandIndex (tokens: string[], command: string): number {
    const index = tokens.findIndex(token => getExecutableName(token) === command)
    if (index <= 0) {
        return index
    }
    const prefix = tokens.slice(0, index)
    let prefixIndex = 0
    while (prefixIndex < prefix.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix[prefixIndex])) {
        prefixIndex++
    }
    const assignmentsOnly = prefixIndex === prefix.length
    return assignmentsOnly || commandWrappers.has(getExecutableName(prefix[prefixIndex])) ? index : -1
}

function getExecutableName (token: string): string {
    const normalized = token.replace(/\\/g, '/')
    return (normalized.split('/').pop() || '').replace(/\.exe$/i, '').toLowerCase()
}

function isBlockDevicePath (path: string): boolean {
    if (/^\\\\\.\\PhysicalDrive\d+$/i.test(path)) {
        return true
    }
    if (unixBlockDevicePatterns.some(pattern => pattern.test(path))) {
        return true
    }
    const lvmPath = /^\/dev\/([^/]+)\/([^/]+)$/.exec(path)
    return Boolean(lvmPath && !nonLvmDeviceDirectories.has(lvmPath[1].toLowerCase()))
}

function tokenizeShellCommands (value: string): string[][] {
    const commands: string[][] = []
    let tokens: string[] = []
    let token = ''
    let quote = ''

    const pushToken = (): void => {
        if (token) {
            tokens.push(token)
            token = ''
        }
    }
    const pushCommand = (): void => {
        pushToken()
        if (tokens.length) {
            commands.push(tokens)
            tokens = []
        }
    }

    for (let index = 0; index < value.length; index++) {
        const character = value[index]
        if (quote) {
            if (character === quote) {
                quote = ''
            } else {
                token += character
            }
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
        } else if (character === '\r' || character === '\n' || character === ';' || character === '&' || character === '|') {
            pushCommand()
        } else if (/\s/.test(character)) {
            pushToken()
        } else {
            token += character
        }
    }
    pushCommand()
    return commands
}
