const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { spawnNpm } = require('./npm-command')

const projectRoot = path.resolve(__dirname, '..')

function runNpm (args) {
    const result = spawnNpm(args, {
        cwd: projectRoot,
        stdio: 'inherit',
        windowsHide: true,
    })
    if (result.error) {
        throw new Error(`无法运行 npm：${result.error.message}`)
    }
    if (result.status !== 0) {
        throw new Error(`npm ${args.join(' ')} 执行失败。`)
    }
}

async function confirmRelease () {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('一键发布需要在交互式终端中运行。')
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const updateNotes = JSON.parse(fs.readFileSync(path.join(projectRoot, 'update-notes.json'), 'utf8'))
    console.log('\n========================================')
    console.log(`  待发布：${packageJson.name}@${packageJson.version}`)
    console.log(`  中文：${updateNotes['zh-CN']?.title || '未填写'}`)
    console.log(`  English: ${updateNotes.en?.title || 'Missing'}`)
    console.log('========================================\n')
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => terminal.question(`输入版本号 ${packageJson.version} 确认发布：`, resolve))
    terminal.close()
    if (String(answer).trim() !== packageJson.version) {
        throw new Error('版本号不匹配，已取消发布。')
    }
}

async function main () {
    console.log('\n检查 npm 登录状态...')
    runNpm(['whoami'])
    console.log('\n运行完整发布检查...')
    runNpm(['run', 'publish:check'])
    await confirmRelease()
    runNpm(['publish'])
}

void main().catch(error => {
    console.error(`\n\x1b[1;31m发布已停止：${error instanceof Error ? error.message : error}\x1b[0m`)
    process.exitCode = 1
})
