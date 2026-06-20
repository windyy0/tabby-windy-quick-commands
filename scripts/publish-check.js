const { spawnSync } = require('node:child_process')

const steps = [
    'npm run typecheck',
    'npm test',
    'npm pack --dry-run',
]

const border = '========================================'

for (const step of steps) {
    const result = spawnSync(step, {
        shell: true,
        stdio: 'inherit',
    })

    if (result.status !== 0) {
        console.error(`\n\x1b[1;31m${border}\n  发布检查失败：${step}\n  请处理以上错误后重试。\n${border}\x1b[0m`)
        process.exit(result.status ?? 1)
    }
}

console.error(`\n\x1b[1;32m${border}\n  发布检查全部通过，可以执行 npm publish。\n${border}\x1b[0m`)
