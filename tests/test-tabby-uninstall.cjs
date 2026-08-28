const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const { registerTabbyPlugin } = require('../scripts/register-tabby-plugin.cjs')

const stable = 'tabby-windy-quick-commands'
const dev = `${stable}-dev`
const other = 'tabby-other'
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function addPlugin (root, name, version) {
    write(path.join(root, 'node_modules', name, 'package.json'), { name, version, main: 'dist/index.js' })
    fs.mkdirSync(path.join(root, 'node_modules', name, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', name, 'dist/index.js'), `// ${name} ${version}`)
}

function fixture (root, withLock = true) {
    addPlugin(root, stable, '1.7.0')
    addPlugin(root, dev, '1.7.0-dev.local')
    addPlugin(root, other, '1.0.0')
    const pkg = { name: 'plugins', version: '1.0.0', dependencies: {
        [stable]: `file:node_modules/${stable}`, [dev]: `file:node_modules/${dev}`, [other]: '1.0.0',
    } }
    write(path.join(root, 'package.json'), pkg)
    if (withLock) {
        const lock = { name: 'plugins', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
            '': { ...pkg, dependencies: { [stable]: '^1.6.3', [other]: '1.0.0' } },
            [`node_modules/${stable}`]: { version: '1.6.3', resolved: 'https://registry.invalid/old.tgz', integrity: 'old-registry-hash' },
            [`node_modules/${other}`]: { version: '1.0.0' },
        } }
        write(path.join(root, 'package-lock.json'), lock)
        write(path.join(root, 'node_modules/.package-lock.json'), { ...lock, packages: {
            [`node_modules/${stable}`]: lock.packages[`node_modules/${stable}`],
            [`node_modules/${other}`]: lock.packages[`node_modules/${other}`],
        } })
    }
}

function snapshot (directory) {
    const result = new Map()
    function visit (dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) visit(file)
            else result.set(path.relative(directory, file), fs.readFileSync(file).toString('base64'))
        }
    }
    visit(directory)
    return result
}

async function main () {
    const root = path.resolve(process.argv[2])
    // Reuse npm's shipped Arborist, the same package-manager engine Tabby uses.
    // The caller supplies npm-cli.js, so no global npm install or network is needed.
    const Arborist = createRequire(path.resolve(process.argv[3]))('@npmcli/arborist')
    const uninstall = (directory, name) => new Arborist({
        path: directory, save: false, audit: false, fund: false, offline: true, ignoreScripts: true,
    }).reify({ rm: [name] })

    if (process.argv[4] === '--installed') {
        const stablePath = path.join(root, 'node_modules', stable)
        const dataPath = path.join(path.dirname(root), 'windy-quick-commands-dev')
        const beforeStable = snapshot(stablePath)
        const beforeData = snapshot(dataPath)
        await uninstall(root, dev)
        assert(!fs.existsSync(path.join(root, 'node_modules', dev)))
        assert.deepEqual(snapshot(stablePath), beforeStable, 'Uninstall must preserve the installed stable package')
        assert.deepEqual(snapshot(dataPath), beforeData, 'Uninstall is not Dev data cleanup')
        assert(!read(path.join(root, 'package.json')).dependencies[dev])
        console.log('[PASS] Built Dev package can be uninstalled with the Tabby package-manager API; stable and Dev data preserved')
        return
    }

    for (const withLock of [true, false]) {
        const directory = path.join(root, withLock ? 'locked profile' : 'profile without lock')
        fixture(directory, withLock)
        const originalPackage = fs.readFileSync(path.join(directory, 'package.json'))
        const beforeStable = snapshot(path.join(directory, 'node_modules', stable))
        const beforeOther = snapshot(path.join(directory, 'node_modules', other))
        if (withLock) {
            await assert.rejects(uninstall(directory, dev), error => error.code === 'ENOENT', 'Old self-referential registration must reproduce the failure')
        }
        const repair = registerTabbyPlugin(directory, dev)
        assert(repair.backupDir)
        assert.deepEqual(fs.readFileSync(path.join(repair.backupDir, 'package.json')), originalPackage)
        assert.deepEqual(snapshot(path.join(directory, 'node_modules', stable)), beforeStable)
        const pkg = read(path.join(directory, 'package.json'))
        assert.equal(pkg.dependencies[stable], '1.7.0')
        assert.equal(pkg.dependencies[dev], '1.7.0-dev.local')
        assert.equal(pkg.dependencies[other], '1.0.0')
        assert.equal(registerTabbyPlugin(directory, dev).backupDir, null, 'Repeated registration should not rewrite metadata')
        if (withLock) {
            for (const relative of ['package-lock.json', 'node_modules/.package-lock.json']) {
                const lock = read(path.join(directory, relative))
                assert.deepEqual(lock.packages[`node_modules/${stable}`], { version: '1.7.0' })
                assert.deepEqual(lock.packages[`node_modules/${other}`], { version: '1.0.0' })
            }
        } else {
            assert(!fs.existsSync(path.join(directory, 'package-lock.json')), 'Do not create a partial root lockfile')
        }
        await uninstall(directory, dev)
        assert(!fs.existsSync(path.join(directory, 'node_modules', dev)))
        assert.deepEqual(snapshot(path.join(directory, 'node_modules', stable)), beforeStable)
        assert.deepEqual(snapshot(path.join(directory, 'node_modules', other)), beforeOther)
        assert(!read(path.join(directory, 'package.json')).dependencies[dev])
        // Follow-up operations must not restore the removed Dev package or fetch
        // unpublished versions of another installed local build.
        await uninstall(directory, other)
        assert(!fs.existsSync(path.join(directory, 'node_modules', dev)))
        assert.deepEqual(snapshot(path.join(directory, 'node_modules', stable)), beforeStable)
        addPlugin(directory, dev, '1.7.0-dev.local')
        registerTabbyPlugin(directory, dev)
        const beforeDev = snapshot(path.join(directory, 'node_modules', dev))
        await uninstall(directory, stable)
        assert.deepEqual(snapshot(path.join(directory, 'node_modules', dev)), beforeDev)
    }

    const invalid = path.join(root, 'invalid lock')
    fixture(invalid)
    fs.writeFileSync(path.join(invalid, 'package-lock.json'), '{invalid')
    const beforeInvalid = fs.readFileSync(path.join(invalid, 'package.json'))
    assert.throws(() => registerTabbyPlugin(invalid, dev))
    assert.deepEqual(fs.readFileSync(path.join(invalid, 'package.json')), beforeInvalid, 'Failed preflight must not change package.json')
    console.log('[PASS] Client uninstall regression: stale self-references, lock synchronization, repeated operations and other plugins preserved')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
