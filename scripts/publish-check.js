const path = require('node:path')
const { spawnNpm } = require('./npm-command')
const { validateRelease } = require('./release-validation')

const projectRoot = path.resolve(__dirname, '..')

function fail (message) {
    console.error(`\n\x1b[1;31m发布检查失败：${message}\x1b[0m`)
    process.exit(1)
}

try {
    const release = validateRelease({ projectRoot })
    console.log(`\n待发布：${release.packageName}@${release.version}`)
    console.log(`中文标题：${release.chineseTitle}`)
    console.log(`英文标题：${release.englishTitle}`)
} catch (error) {
    fail(error instanceof Error ? error.message : error)
}

const steps = [
    { label: 'npm run typecheck', args: ['run', 'typecheck'] },
    { label: 'npm test', args: ['test'] },
    { label: 'npm pack --dry-run', args: ['pack', '--dry-run'] },
]

const border = '========================================'

for (const step of steps) {
    const result = spawnNpm(step.args, {
        cwd: projectRoot,
        stdio: 'inherit',
        windowsHide: true,
    })

    if (result.error || result.status !== 0) {
        const reason = result.error ? `（${result.error.message}）` : ''
        console.error(`\n\x1b[1;31m${border}\n  发布检查失败：${step.label}${reason}\n  请处理以上错误后重试。\n${border}\x1b[0m`)
        process.exit(result.status ?? 1)
    }
}

console.error(`\n\x1b[1;32m${border}\n  发布检查全部通过，可以执行 npm publish。\n${border}\x1b[0m`)
