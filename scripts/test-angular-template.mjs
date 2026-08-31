import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { parseTemplate } from '@angular/compiler'

const sourcePath = path.join(process.cwd(), 'src', 'quickCommandsSettingsTab.component.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let template = ''

const visit = node => {
    if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sourceFile) === 'template' &&
        (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))
    ) {
        template = node.initializer.text
        return
    }
    ts.forEachChild(node, visit)
}

visit(sourceFile)
if (!template) {
    throw new Error(`未找到 Angular 模板：${sourcePath}`)
}

const parsed = parseTemplate(template, sourcePath, { preserveWhitespaces: true })
if (parsed.errors?.length) {
    throw new Error(parsed.errors.map(error => error.toString()).join('\n'))
}

console.log('[PASS] Angular 设置模板 JIT 语法校验')
