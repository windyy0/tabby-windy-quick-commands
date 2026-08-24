const { validateRelease } = require('./release-validation')

try {
    const result = validateRelease()
    const latest = result.latestVersion ? `（npm 最新 ${result.latestVersion}）` : '（npm 尚未发布）'
    console.log(`\n发布资料校验通过：${result.packageName}@${result.version} ${latest}`)
    console.log(`中文标题：${result.chineseTitle}`)
    console.log(`英文标题：${result.englishTitle}`)
} catch (error) {
    console.error(`\n\x1b[1;31m发布资料校验失败：${error instanceof Error ? error.message : error}\x1b[0m`)
    process.exitCode = 1
}
