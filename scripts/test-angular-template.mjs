import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { parseTemplate } from '@angular/compiler'

const sourcePaths = [
    path.join(process.cwd(), 'src', 'quickCommandsSettingsTab.component.ts'),
    path.join(process.cwd(), 'src', 'activityLog', 'activityLog.component.ts'),
]

for (const sourcePath of sourcePaths) {
    const source = fs.readFileSync(sourcePath, 'utf8')
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const templates = []
    const visit = node => {
        if (
            ts.isPropertyAssignment(node) &&
            node.name.getText(sourceFile) === 'template' &&
            (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))
        ) {
            templates.push(node.initializer.text)
            return
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (!templates.length) {
        throw new Error(`未找到 Angular 模板：${sourcePath}`)
    }
    for (const template of templates) {
        const parsed = parseTemplate(template, sourcePath, { preserveWhitespaces: true })
        if (parsed.errors?.length) {
            throw new Error(parsed.errors.map(error => error.toString()).join('\n'))
        }
    }
}

console.log('[PASS] Angular 设置与活动日志模板 JIT 语法校验')
