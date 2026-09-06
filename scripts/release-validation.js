const fs = require('node:fs')
const path = require('node:path')
const { spawnNpm } = require('./npm-command')

const requiredLanguages = ['zh-CN', 'en']

function assertObject (value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(message)
    }
}

function readJson (filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
        throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : error}`)
    }
}

function parseVersion (version) {
    if (typeof version !== 'string') {
        return null
    }
    const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
    if (!match) {
        return null
    }
    const prereleaseParts = match[4] ? match[4].split('.') : []
    if (prereleaseParts.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
        return null
    }
    return {
        core: match.slice(1, 4).map(Number),
        prerelease: prereleaseParts.map(part => /^\d+$/.test(part) ? Number(part) : part),
    }
}

function compareVersions (left, right) {
    const a = parseVersion(left)
    const b = parseVersion(right)
    if (!a || !b) {
        throw new Error(`无法比较版本号：${left} / ${right}`)
    }
    for (let index = 0; index < 3; index++) {
        if (a.core[index] !== b.core[index]) {
            return a.core[index] > b.core[index] ? 1 : -1
        }
    }
    if (!a.prerelease.length || !b.prerelease.length) {
        if (a.prerelease.length === b.prerelease.length) {
            return 0
        }
        return a.prerelease.length ? -1 : 1
    }
    const length = Math.max(a.prerelease.length, b.prerelease.length)
    for (let index = 0; index < length; index++) {
        const leftPart = a.prerelease[index]
        const rightPart = b.prerelease[index]
        if (leftPart === rightPart) {
            continue
        }
        if (leftPart === undefined || rightPart === undefined) {
            return leftPart === undefined ? -1 : 1
        }
        if (typeof leftPart === 'number' && typeof rightPart === 'string') {
            return -1
        }
        if (typeof leftPart === 'string' && typeof rightPart === 'number') {
            return 1
        }
        return leftPart > rightPart ? 1 : -1
    }
    return 0
}

function validateUpdateNotesDocument (packageJson, updateNotes) {
    assertObject(updateNotes, 'update-notes.json 必须是 JSON 对象。')
    if (!parseVersion(packageJson.version)) {
        throw new Error(`package.json 的版本号无效：${packageJson.version || '未填写'}`)
    }
    if (updateNotes.version !== packageJson.version) {
        throw new Error(`update-notes.json 的 version 必须与 package.json 一致（当前应为 ${packageJson.version}）。`)
    }
    if (!Array.isArray(packageJson.files) || !packageJson.files.includes('update-notes.json')) {
        throw new Error('package.json 的 files 未包含 update-notes.json。')
    }
    for (const language of requiredLanguages) {
        const document = updateNotes[language]
        assertObject(document, `update-notes.json 缺少 ${language} 更新说明。`)
        if (typeof document.title !== 'string' || !document.title.trim()) {
            throw new Error(`update-notes.json 的 ${language} 更新说明缺少 title。`)
        }
        if (document.sections !== undefined && (!Array.isArray(document.sections) || !document.sections.length)) {
            throw new Error(`update-notes.json 的 ${language} 更新说明至少需要一个 sections 项。`)
        }
        ;(document.sections || []).forEach((section, index) => {
            assertObject(section, `update-notes.json 的 ${language} 第 ${index + 1} 个分组格式无效。`)
            if (typeof section.title !== 'string' || !section.title.trim()) {
                throw new Error(`update-notes.json 的 ${language} 第 ${index + 1} 个分组缺少 title。`)
            }
            if (!Array.isArray(section.items) || !section.items.length || section.items.some(item => typeof item !== 'string' || !item.trim())) {
                throw new Error(`update-notes.json 的 ${language} 第 ${index + 1} 个分组需要至少一条有效 items。`)
            }
        })
        if (document.notice !== undefined && (typeof document.notice !== 'string' || !document.notice.trim())) {
            throw new Error(`update-notes.json 的 ${language} notice 必须是非空字符串。`)
        }
    }
}

function validatePackageLock (packageJson, packageLock) {
    assertObject(packageLock, 'package-lock.json 必须是 JSON 对象。')
    const rootVersion = packageLock.packages && packageLock.packages[''] && packageLock.packages[''].version
    if (packageLock.version !== packageJson.version || rootVersion !== packageJson.version) {
        throw new Error(`package.json 与 package-lock.json 版本不一致（${packageJson.version} / ${packageLock.version || '缺失'} / ${rootVersion || '缺失'}）。`)
    }
}

function getLatestPublishedVersion (packageName, projectRoot) {
    const result = spawnNpm(['view', packageName, 'version', '--json'], {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
    })
    if (result.error) {
        throw new Error(`无法运行 npm：${result.error.message}`)
    }
    if (result.status !== 0) {
        const output = `${result.stdout || ''}\n${result.stderr || ''}`
        if (/E404|404 Not Found/i.test(output)) {
            return null
        }
        throw new Error(`无法查询 npm 最新版本：${String(result.stderr || result.stdout || '未知错误').trim()}`)
    }
    try {
        const parsed = JSON.parse(result.stdout)
        return typeof parsed === 'string' ? parsed : null
    } catch {
        throw new Error(`npm 返回了无效版本信息：${String(result.stdout || '').trim()}`)
    }
}

function validateRelease ({ projectRoot = path.resolve(__dirname, '..'), checkRegistry = true } = {}) {
    const packageJson = readJson(path.join(projectRoot, 'package.json'), 'package.json')
    if (typeof packageJson.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageJson.name)) {
        throw new Error('package.json 缺少有效的包名。')
    }
    const packageLock = readJson(path.join(projectRoot, 'package-lock.json'), 'package-lock.json')
    const updateNotesPath = path.join(projectRoot, 'update-notes.json')
    if (!fs.existsSync(updateNotesPath)) {
        throw new Error('缺少 update-notes.json。')
    }
    const updateNotes = readJson(updateNotesPath, 'update-notes.json')
    validatePackageLock(packageJson, packageLock)
    validateUpdateNotesDocument(packageJson, updateNotes)

    const latestVersion = checkRegistry ? getLatestPublishedVersion(packageJson.name, projectRoot) : null
    if (latestVersion && compareVersions(packageJson.version, latestVersion) <= 0) {
        throw new Error(`待发布版本 ${packageJson.version} 必须高于 npm 最新版本 ${latestVersion}。`)
    }
    return {
        packageName: packageJson.name,
        version: packageJson.version,
        latestVersion,
        chineseTitle: updateNotes['zh-CN'].title.trim(),
        englishTitle: updateNotes.en.title.trim(),
    }
}

module.exports = {
    compareVersions,
    validatePackageLock,
    validateRelease,
    validateUpdateNotesDocument,
}
