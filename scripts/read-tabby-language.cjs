// Only return the language, never configuration contents or YAML error excerpts.
const fs = require('fs')
const yaml = require('js-yaml')

try {
    const config = yaml.load(fs.readFileSync(process.argv[2], 'utf8'))
    if (config && typeof config.language === 'string') {
        process.stdout.write(config.language.trim())
    }
} catch {
    // An unavailable or malformed configuration falls back to the Windows UI language.
}
