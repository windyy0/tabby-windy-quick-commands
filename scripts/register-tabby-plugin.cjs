const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const localPackages = ['tabby-windy-quick-commands', 'tabby-windy-quick-commands-dev']

function assertUnlinkedPath (file) {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
        let stat
        try { stat = fs.lstatSync(current) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (stat?.isSymbolicLink()) {
            throw new Error(`Refusing to modify metadata through a symlink: ${current}`)
        }
        if (path.dirname(current) === current) break
    }
}

function readJson (file) {
    assertUnlinkedPath(file)
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function localLockEntry (manifest) {
    // These are copied local bundles, not the old registry tarball. In particular,
    // retaining an old resolved/integrity pair can restore the wrong build.
    const entry = {}
    for (const field of ['version', 'license', 'engines', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu']) {
        if (manifest[field] !== undefined) entry[field] = manifest[field]
    }
    return entry
}

function registerTabbyPlugin (pluginsDir, packageName) {
    if (!localPackages.includes(packageName)) throw new Error(`Unexpected local plugin: ${packageName}`)
    pluginsDir = path.resolve(pluginsDir)
    const packagePath = path.join(pluginsDir, 'package.json')
    const pkg = readJson(packagePath)
    pkg.dependencies ??= {}
    const manifests = new Map()
    for (const name of localPackages) {
        // Repair the old self-reference for either channel. Removing Dev also
        // resolves stable's dependencies, so leaving stable broken is not enough.
        if (name !== packageName && pkg.dependencies[name] !== `file:node_modules/${name}`) continue
        const directory = path.join(pluginsDir, 'node_modules', name)
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing a linked local plugin: ${directory}`)
        const manifest = readJson(path.join(directory, 'package.json'))
        if (manifest.name !== name || typeof manifest.version !== 'string' || !manifest.version) {
            throw new Error(`Invalid installed plugin manifest: ${directory}`)
        }
        manifests.set(name, manifest)
        pkg.dependencies[name] = manifest.version
    }

    const updates = new Map([[packagePath, pkg]])
    for (const relative of ['package-lock.json', 'npm-shrinkwrap.json', 'node_modules/.package-lock.json']) {
        const file = path.join(pluginsDir, relative)
        if (!fs.existsSync(file)) continue
        const lock = readJson(file)
        if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) {
            throw new Error(`Unsupported lockfile format; metadata was not changed: ${file}`)
        }
        const hidden = relative.startsWith('node_modules/')
        if (!hidden) {
            lock.packages[''] ??= { name: pkg.name, version: pkg.version }
            lock.packages[''].dependencies = { ...pkg.dependencies }
        }
        for (const [name, manifest] of manifests) {
            lock.packages[`node_modules/${name}`] = localLockEntry(manifest)
            if (lock.lockfileVersion === 2) {
                lock.dependencies ??= {}
                lock.dependencies[name] = { version: manifest.version }
            }
        }
        updates.set(file, lock)
    }
    // Without a root lockfile, Arborist uses the actual installed tree. Do not
    // create a partial lockfile that would drop unrelated plugins/dependencies.
    const changes = [...updates].map(([file, value]) => ({
        file, original: fs.readFileSync(file), next: Buffer.from(JSON.stringify(value, null, 2) + '\n'),
    })).filter(change => !change.original.equals(change.next))
    if (!changes.length) return { packages: [...manifests.keys()], backupDir: null }

    const backupDir = path.join(pluginsDir, '.windy-install-backups', crypto.randomUUID())
    assertUnlinkedPath(backupDir)
    for (const change of changes) {
        const backup = path.join(backupDir, path.relative(pluginsDir, change.file))
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        fs.writeFileSync(backup, change.original, { flag: 'wx' })
    }
    const written = []
    try {
        for (const change of changes) {
            const temporary = change.file + `.windy-${crypto.randomUUID()}.tmp`
            try {
                fs.writeFileSync(temporary, change.next, { flag: 'wx' })
                fs.renameSync(temporary, change.file)
                written.push(change)
            } finally {
                if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
            }
        }
    } catch (error) {
        for (const change of written.reverse()) fs.writeFileSync(change.file, change.original)
        throw error
    }
    return { packages: [...manifests.keys()], backupDir }
}

module.exports = { registerTabbyPlugin }

if (require.main === module) {
    try {
        const result = registerTabbyPlugin(process.argv[2], process.argv[3])
        console.log(`Registered local plugin versions: ${result.packages.join(', ')}`)
        if (result.backupDir) console.log(`Previous installation metadata: ${result.backupDir}`)
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
