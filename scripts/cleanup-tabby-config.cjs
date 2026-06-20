const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const configPath = process.argv[2]
const pluginConfigPath = process.argv[3]

if (!configPath || !pluginConfigPath || !fs.existsSync(configPath) || !fs.existsSync(pluginConfigPath)) {
    process.exit(0)
}

const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'))
if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, 'windyCommandCenter')) {
    process.exit(0)
}

delete parsed.windyCommandCenter
const backupPath = `${configPath}.windy-quick-commands.backup`
const temporaryPath = `${configPath}.windy-quick-commands.tmp`
fs.copyFileSync(configPath, backupPath)
fs.writeFileSync(temporaryPath, yaml.dump(parsed, { lineWidth: -1, noRefs: true }), 'utf8')
try {
    fs.renameSync(temporaryPath, configPath)
} catch {
    fs.copyFileSync(temporaryPath, configPath)
    fs.unlinkSync(temporaryPath)
}
console.log(`Removed legacy windyCommandCenter from ${configPath}`)
