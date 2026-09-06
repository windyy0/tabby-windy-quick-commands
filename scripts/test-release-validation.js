const assert = require('node:assert/strict')
const { spawnNpm } = require('./npm-command')
const {
    compareVersions,
    validatePackageLock,
    validateUpdateNotesDocument,
} = require('./release-validation')

const packageJson = {
    name: 'tabby-example',
    version: '1.6.0',
    files: ['dist', 'update-notes.json'],
}
const updateNotes = {
    version: '1.6.0',
    'zh-CN': {
        title: '更新标题',
        sections: [{ title: '新增', items: ['功能'] }],
    },
    en: {
        title: 'Update title',
        sections: [{ title: 'Added', items: ['Feature'] }],
    },
}

const npmVersionResult = spawnNpm(['--version'], { encoding: 'utf8' })
assert.equal(npmVersionResult.error, undefined)
assert.equal(npmVersionResult.status, 0)
assert.match(npmVersionResult.stdout, /^\d+\.\d+\.\d+/)

assert.equal(compareVersions('1.6.0', '1.5.2'), 1)
assert.equal(compareVersions('1.6.0-beta.1', '1.6.0'), -1)
assert.equal(compareVersions('1.6.0-beta.10', '1.6.0-beta.2'), 1)
assert.throws(() => compareVersions('01.6.0', '1.6.0'), /无法比较版本号/)
assert.doesNotThrow(() => validateUpdateNotesDocument(packageJson, updateNotes))
assert.doesNotThrow(() => validateUpdateNotesDocument(packageJson, {
    version: packageJson.version,
    'zh-CN': { title: '新增设置页悬浮目录导航' },
    en: { title: 'Add floating section navigation to Settings' },
}))
for (const sections of [null, [], 'invalid', [{ title: '新增', items: [] }]]) {
    assert.throws(() => validateUpdateNotesDocument(packageJson, {
        ...updateNotes,
        'zh-CN': { title: '更新标题', sections },
    }))
}
assert.doesNotThrow(() => validatePackageLock(packageJson, {
    version: '1.6.0',
    packages: { '': { version: '1.6.0' } },
}))
assert.throws(
    () => validateUpdateNotesDocument(packageJson, { ...updateNotes, version: '1.5.2' }),
    /必须与 package\.json 一致/,
)
assert.throws(
    () => validateUpdateNotesDocument(packageJson, { ...updateNotes, version: ' 1.6.0 ' }),
    /必须与 package\.json 一致/,
)
assert.throws(
    () => validatePackageLock(packageJson, { version: '1.5.2', packages: { '': { version: '1.5.2' } } }),
    /版本不一致/,
)
assert.throws(
    () => validateUpdateNotesDocument({ ...packageJson, version: '01.6.0' }, { ...updateNotes, version: '01.6.0' }),
    /版本号无效/,
)

console.log('[PASS] 发布资料校验')
