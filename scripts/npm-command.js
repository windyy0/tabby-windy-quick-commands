const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function findNpmCli () {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
    return candidates.find(candidate => (
        typeof candidate === 'string' &&
        /npm-cli\.m?js$/i.test(candidate) &&
        fs.existsSync(candidate)
    )) || null
}

const npmCli = findNpmCli()

function spawnNpm (args, options = {}) {
    if (npmCli) {
        return spawnSync(process.execPath, [npmCli, ...args], {
            windowsHide: true,
            ...options,
        })
    }
    return spawnSync('npm', args, {
        shell: process.platform === 'win32',
        windowsHide: true,
        ...options,
    })
}

module.exports = { spawnNpm }
