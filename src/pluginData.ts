import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { pluginIdentity } from './pluginIdentity'

export const pluginDataResetEvent = `${pluginIdentity.dataDirectory}-data-reset`
const generationFile = '.data-generation'
const resettingRevisionPrefix = 'resetting:'
const executionPrefix = '.execution-'

function rejectLinks (target: string): void {
    let current = path.resolve(target)
    while (true) {
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error('数据路径包含符号链接或目录联接，已停止操作。')
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error }
        }
        const parent = path.dirname(current)
        if (parent === current) { break }
        current = parent
    }
}

function checkTree (directory: string): void {
    rejectLinks(directory)
    if (!fs.existsSync(directory)) { return }
    for (const name of fs.readdirSync(directory)) {
        const child = path.join(directory, name)
        let stat: fs.Stats
        try { stat = fs.lstatSync(child) } catch (error) {
            // A completed execution can release its own lease during preflight.
            if (name.startsWith(executionPrefix) && (error as NodeJS.ErrnoException).code === 'ENOENT') { continue }
            throw error
        }
        if (stat.isSymbolicLink()) {
            throw new Error('数据路径包含符号链接或目录联接，已停止操作。')
        }
        if (stat.isDirectory()) { checkTree(child) }
    }
}

function processExists (pid: number): boolean {
    try { process.kill(pid, 0); return true } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
}

/** Serializes disk writes across windows and rejects writes from a pre-reset store. */
export class PluginDataAccess {
    readonly directory: string | null
    private revision: string | null = null

    constructor (configPath: string | null, readonly identity = pluginIdentity) {
        if (!['windy-quick-commands', 'windy-quick-commands-dev'].includes(identity.dataDirectory)) {
            throw new Error('插件数据路径无效，已停止操作。')
        }
        this.directory = configPath ? path.resolve(path.dirname(configPath), identity.dataDirectory) : null
        if (this.directory) {
            this.revision = this.readRevision()
            // Ordinary readers do not contend with writers. A reset's temporary
            // generation must not be paired with a snapshot of the old config.
            if (this.revision && !this.revision.startsWith(resettingRevisionPrefix)) { return }
            this.lock(() => {
                fs.mkdirSync(this.directory!, { recursive: true })
                const marker = path.join(this.directory!, generationFile)
                const revision = this.readRevision()
                // With the lock acquired, a remaining reset marker belongs to a
                // failed/interrupted reset. Fresh stores can recover and retry.
                if (!revision || revision.startsWith(resettingRevisionPrefix)) {
                    fs.writeFileSync(marker, randomUUID(), { flag: revision === null ? 'wx' : 'w' })
                }
                this.revision = this.readRevision()
            })
        }
    }

    isCurrent (): boolean {
        return !this.directory || this.revision === this.readRevision()
    }

    assertCurrent (): void {
        if (!this.isCurrent()) {
            throw new Error('插件数据已在其他窗口重置，请重启 Tabby 后再操作。')
        }
    }

    write<T> (action: () => T): T {
        return this.lock(() => { this.assertCurrent(); return action() })
    }

    reset (defaults: Record<string, unknown>): void {
        if (!this.directory) { throw new Error('无法定位插件数据目录，未清理数据。') }
        this.write(() => {
            const directory = this.directory!
            // Validate the resolved, allowlisted child and every descendant before deletion.
            checkTree(directory)
            for (const name of fs.readdirSync(directory)) {
                if (!name.startsWith(executionPrefix)) { continue }
                const pid = Number(name.slice(executionPrefix.length).split('-')[0])
                if (!Number.isSafeInteger(pid) || pid <= 0 || processExists(pid)) {
                    throw new Error('当前插件仍有命令正在执行，请停止执行后再重置插件数据。')
                }
            }
            const revision = randomUUID()
            const resettingRevision = `${resettingRevisionPrefix}${randomUUID()}`
            try {
                // Invalidate all old writers before any deletion, including partial failures.
                fs.writeFileSync(path.join(directory, generationFile), resettingRevision)
                fs.rmSync(directory, { recursive: true, force: true })
                fs.mkdirSync(directory, { recursive: true })
                fs.writeFileSync(path.join(directory, generationFile), resettingRevision, { flag: 'wx' })
                fs.writeFileSync(path.join(directory, 'plugin-config.json'), `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx' })
                // Publish a different generation only after the new config exists.
                fs.writeFileSync(path.join(directory, generationFile), revision)
                this.revision = revision
            } catch (error) {
                throw new Error(`重置插件数据失败，部分数据可能已删除。请重启 Tabby 后重试。详情：${error instanceof Error ? error.message : String(error)}`)
            }
        })
    }

    beginExecution (): () => void {
        if (!this.directory) { return () => undefined }
        const lease = path.join(this.directory, `${executionPrefix}${process.pid}-${randomUUID()}`)
        this.write(() => fs.writeFileSync(lease, '', { flag: 'wx' }))
        return () => {
            // This UUID names only our completed execution. Removing it cannot
            // restore old data or remove a newer run's lease, so no writer lock
            // is needed. A reset/earlier release may already have removed it.
            rejectLinks(lease)
            try { fs.unlinkSync(lease) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error }
            }
        }
    }

    private readRevision (): string | null {
        if (!this.directory) { return null }
        try { return fs.readFileSync(path.join(this.directory, generationFile), 'utf8') } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null }
            throw error
        }
    }

    private lock<T> (action: () => T): T {
        if (!this.directory) { return action() }
        rejectLinks(this.directory)
        const parent = path.dirname(this.directory)
        fs.mkdirSync(parent, { recursive: true })
        const prefix = `.${this.identity.dataDirectory}.lock-`
        const name = `${prefix}${process.pid}-${randomUUID()}`
        const lockPath = path.join(parent, name)
        // Publish our unique claim BEFORE listing competitors. If two writers
        // overlap, the later claim sees the earlier one (or both abort). Claims
        // stay present throughout the action; their paths are never reused.
        fs.writeFileSync(lockPath, '', { flag: 'wx' })
        try {
            for (const other of fs.readdirSync(parent)) {
                if (other === name || !other.startsWith(prefix)) { continue }
                const owner = Number(other.slice(prefix.length).split('-')[0])
                if (!Number.isSafeInteger(owner) || owner <= 0 || processExists(owner)) {
                    throw new Error('插件数据正在被其他窗口使用，请稍后重试。')
                }
                // Only remove the captured dead process's UUID, never a shared
                // pathname that another writer could have reacquired meanwhile.
                const stalePath = path.join(parent, other)
                rejectLinks(stalePath)
                try { fs.unlinkSync(stalePath) } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error }
                }
            }
            return action()
        } finally {
            fs.unlinkSync(lockPath)
        }
    }
}
