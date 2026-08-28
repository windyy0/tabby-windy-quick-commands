const fs = require('fs')
const yaml = require('js-yaml')

const configPath = process.argv[2]
const pluginConfigPath = process.argv[3]
const legacyConfigKey = process.argv[4] || 'windyCommandCenter'
const dataDirectoryName = process.argv[5] || 'windy-quick-commands'
const namespaces = {
    windyCommandCenter: 'windy-quick-commands',
    windyCommandCenterDev: 'windy-quick-commands-dev',
}
if (namespaces[legacyConfigKey] !== dataDirectoryName) {
    throw new Error('Unknown plugin config namespace')
}

if (!configPath || !pluginConfigPath || !fs.existsSync(configPath) || !fs.existsSync(pluginConfigPath)) {
    process.exit(0)
}

const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'))
if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, legacyConfigKey)) {
    process.exit(0)
}

delete parsed[legacyConfigKey]
const backupPath = `${configPath}.${dataDirectoryName}.backup`
const temporaryPath = `${configPath}.${dataDirectoryName}.tmp`
fs.copyFileSync(configPath, backupPath)
fs.writeFileSync(temporaryPath, yaml.dump(parsed, { lineWidth: -1, noRefs: true }), 'utf8')
try {
    fs.renameSync(temporaryPath, configPath)
} catch {
    fs.copyFileSync(temporaryPath, configPath)
    fs.unlinkSync(temporaryPath)
}
console.log(`Removed legacy ${legacyConfigKey} from ${configPath}`)
