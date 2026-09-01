<h1 align="center">Tabby Windy Quick Commands</h1>

<p align="center">
  一个面向 <a href="https://tabby.sh/">Tabby</a> 终端的本地快速命令管理插件。
</p>

<p align="center">
  <strong>简体中文</strong> &nbsp;·&nbsp; <a href="./README.en.md">English</a>
</p>

插件在 Tabby 右上角提供快速命令按钮，并从右侧展开抽屉，用于集中管理、搜索和执行常用命令。支持快捷键、多会话发送、逐行执行、输出触发器，以及命令库导入导出。

> 没有仔细的测试过，就纯觉得没有好用点好看点的相关快速命令的插件，用AI辅助写了一个。可能存在大量的bug还有一些没考虑的，见谅🫨可以提issue，慢慢改~

## 项目链接

- GitHub 源码仓库：[windyy0/tabby-windy-quick-commands](https://github.com/windyy0/tabby-windy-quick-commands)
- 问题反馈：[GitHub Issues](https://github.com/windyy0/tabby-windy-quick-commands/issues)
- npm 包：[tabby-windy-quick-commands](https://www.npmjs.com/package/tabby-windy-quick-commands)

## 截图

### 预览

![快速命令界面](https://raw.githubusercontent.com/windyy0/tabby-windy-quick-commands/main/docs/images/overview.png)

## 功能

- 通过工具栏按钮或快捷键开关抽屉
- 键盘快捷键操作，焦点切换
- 搜索、新建、编辑、删除、复制、收藏和置顶命令
- 为单条命令录制快捷键
- 整段粘贴和逐行执行两种模式
- 输出触发器可在整个命令发送后运行，也可绑定到逐行模式中的指定命令行
- 发送到当前终端，或广播到所有已打开的终端会话
- 导入、导出命令库和插件配置
- 中文界面与英文界面自动切换

## 安装

### 从 Tabby 插件管理器安装

发布到 npm 后，在 Tabby 中打开 `设置 -> 插件`，搜索：

```text
windy-quick-commands
```

安装完成后请完整重启 Tabby。

### 从源码安装

仓库提供了适用于 Windows 的本地安装脚本。准备好下方开发环境后，在仓库目录执行：

```powershell
npm ci
npm run install:tabby:restart
```

脚本会构建插件，将最小运行文件复制到 Tabby 的用户插件目录，并重启 Tabby。也可以只安装、不重启：

```powershell
npm run install:tabby
```

## 使用

点击 Tabby 右上角的快速命令按钮打开抽屉。
默认用 `Escape` 在抽屉搜索和活动终端之间切换焦点，用 `Ctrl+Alt+H` 显示或隐藏左侧快捷键提示。

> 首次使用时候，会根据当前tabby客户端语言创建示例分类和命令。

### 导入与导出

- 抽屉中的“导出命令”只导出命令、分类和输出触发器。
- 设置页的“导出”导出命令库和全部插件设置，但不包含运行日志和使用统计。
- 两种文件统一使用 v1 格式，抽屉和设置页都可识别。在抽屉导入配置文件时只提取命令；在设置页导入时，可选择只导入命令或导入完整配置。
- “恢复默认配置”只重置插件设置，会保留现有命令、分类、输出触发器、运行日志和使用统计。

> 导出文件的 `version` 固定为 `1`，不会随后续格式调整递增。新的 v1 格式不兼容旧版命令库或配置备份。

### 输出触发器

简单点说就是 匹配条件->成功匹配->规则->成功匹配动作->匹配后动作->超时动作

输出触发器会等待终端输出指定内容，再决定是否继续执行。适合登录提示、构建完成、部署结果等需要等待终端反馈的场景。

1. 在命令的“输出触发器”中添加规则。
2. 选择触发时机：整个命令发送后，或逐行模式下的指定命令行执行后。
3. 填写“成功匹配”或“错误匹配”，可选择普通文本或正则表达式。
4. 设置成功或错误后的动作、“匹配后流程”和超时时间；等待超时后会执行单独的“超时后”动作。

成功匹配和错误匹配可分别选择不执行、发送自定义命令或执行已有命令；动作完成后，再进入统一的“匹配后流程”：

- 整个命令规则：继续下一条规则，或停止该会话自动化。
- 指定行规则：继续下一条规则、跳过该行剩余规则并继续下一行，或停止后续逐行执行。

> 同一触发时机下的多条规则按顺序执行；发送到多个终端时，每个会话独立匹配输出。

适配了各种配色主题，应该没啥问题。

## 开发

### 环境和工具准备

- [Tabby 官网](https://tabby.sh/)：安装 Tabby 客户端；建议使用当前稳定版。
- [Tabby 最新版本](https://github.com/Eugeny/tabby/releases/latest)：下载安装包和查看发布说明。
- [Node.js](https://nodejs.org/)：需要 Node.js 18 或更高版本，npm 随 Node.js 安装。
- [Git](https://git-scm.com/)：用于克隆仓库和版本管理。
- [PowerShell 7](https://learn.microsoft.com/powershell/)：Windows 本地安装/重启/清理 脚本需要 `pwsh`；单纯测试和构建不依赖 Windows。
- 可选编辑器：[Visual Studio Code](https://code.visualstudio.com/) 及其内置 TypeScript 支持。
- [NPM 账号](https://www.npmjs.com)。

> Tabby 当前依赖 Angular 15，因此项目使用其兼容的 TypeScript 4.9。仓库已配置 VS Code/Cursor 使用 `node_modules/typescript` 中的工作区版本；若编辑器仍显示新版 TypeScript 的弃用提示，请重载窗口或执行 `TypeScript: Restart TS Server`。

### 本地安装

安装依赖，安装到本机tabby插件目录下：

```powershell
npm ci
npm run install:tabby
npm run install:tabby:dev #开发版
```

`npm ci` 和 `npm install` 都用于安装项目依赖，在本仓库根目录执行，任选其一即可：

| 命令 | 安装行为 | 适用场景 |
| --- | --- | --- |
| `npm ci` | 先删除当前项目的 `node_modules`，再严格按 `package-lock.json` 安装，不修改锁文件；锁文件缺失或与 `package.json` 不一致时会报错 | 复现仓库的固定依赖环境、自动化测试 |
| `npm install` | 不先清空整个 `node_modules`，按依赖声明和可用的锁文件安装，必要时生成或更新锁文件 | 日常本地开发、首次生成锁文件或调整依赖 |

> 本地开发可以直接使用 `npm install`，`npm ci` 不是必须的。两者只安装本项目的依赖，不会自动安装或升级 Tabby 中的插件。

运行测试和构建：

```powershell
npm test
npm run build
```

安装到本机 Tabby并重启：

```powershell
npm run install:tabby:restart
npm run install:tabby:dev:restart #开发版
```

**卸载时直接在 Tabby 插件管理器中点击卸载即可。**

---

Tabby 开发相关资料：

- [Tabby 源码仓库](https://github.com/Eugeny/tabby)
- [Tabby 插件 API 文档](https://docs.tabby.sh/)
- [Tabby 开发说明 HACKING.md](https://github.com/Eugeny/tabby/blob/master/HACKING.md)
- [Tabby Core API](https://docs.tabby.sh/classes/LocaleService.html)

常用开发命令：

| 命令                              | 说明                            |
| --------------------------------- | ------------------------------- |
| `npm run typecheck`             | 检查 TypeScript 类型            |
| `npm test`                      | 编译并运行测试                  |
| `npm run clean`                 | 清理 `dist` 和 `dist-tests` |
| `npm run build`                 | 清理并构建 `dist`             |
| `npm run build:dev`             | 构建开发版到 `dist-dev`，不安装 |
| `npm run watch`                 | 监听源码变化并持续构建          |
| `npm run install:tabby`         | 构建并安装到本机 Tabby          |
| `npm run install:tabby:restart` | 构建、安装并重启 Tabby          |
| `npm run install:tabby:dev`     | 构建并安装开发版，保留现有 Dev 数据 |
| `npm run install:tabby:dev:restart` | 构建、安装开发版并重启 Tabby |
| `npm run clean:tabby:dev`       | 清理 Dev 数据；运行中确认后关闭、清理并重启，已关闭时仅清理 |
| `npm run publish:check`         | 完整执行发布前检查并预览 npm 包 |
| `npm run release:validate`      | 校验版本号、更新说明与 npm 最新版本 |
| `npm run release`               | 完整检查、二次确认并发布到 npm  |
| `npm pack`                      | 生成本地 npm 安装包             |
| `npm run clean:pack`            | 清理本地 `.tgz` 安装包        |

插件入口为 `dist/index.js`。`dist` 不提交到 Git，而是在构建和 npm 发布前生成。

### 本地开发版 Dev（与正式版并存）

| 项目 | 正式版 | 开发版 |
| --- | --- | --- |
| 本地包名 | `tabby-windy-quick-commands` | `tabby-windy-quick-commands-dev` |
| 数据目录（Tabby 配置目录下） | `windy-quick-commands` | `windy-quick-commands-dev` |
| 构建目录 | `dist` | `dist-dev` |
| 默认命令库 | “默认”分类中的一条示例命令，已收藏、不置顶 | 与正式版相同 |
| 默认设置、执行和快捷键 | 正常功能 | 与正式版相同 |
| 更新信息和历史 | 正式包发布信息 | 读取同一正式包，缓存与检查更新偏好独立 |
| 更新安装 | 在线安装正式包 | 更新本地源码后重新安装 Dev，不安装正式包 |
| 旧配置迁移 | 正式版命名空间 | 相同逻辑，使用 Dev 命名空间 |

Windows 默认开发版数据路径为 `%APPDATA%\tabby\windy-quick-commands-dev`。清空命令只删除这个目录（包括配置、备份、日志、统计和更新缓存）

自定义 Tabby 配置目录需对安装和数据操作使用对应路径：
```powershell
#示例 文件夹可以更改，安装正式版也可以使用这个参数
npm run install:tabby:dev -- -TabbyPluginsDir 'D:\TabbyProfile\plugins'
npm run clean:tabby:dev -- -TabbyConfigDir 'D:\TabbyProfile'
```

清理dev数据配置：
`clean:tabby:dev` 检测到 Tabby 运行中时，提示“关闭 → 清理 Dev 数据 → 重启”，仅按回车确认；
Ctrl+C 或其他输入取消，非交互环境不会自动确认。
Tabby 原本已关闭时，只清理，不询问、不启动；之后自行打开 Tabby 即可。

回车确认提示跟随tabby客户端语言，失败尝试Windows显示语言，目前只测试过Windows。

### 更新源
根据网络质量优先选择。

**检查更新**
- npm 官方：`registry.npmjs.org`
- npmmirror：`registry.npmmirror.com`

**更新历史**
- jsDelivr
- npmmirror`/files`

> npmmirror的unpkg功能需要自行添加到白名单，才能正常读取文件。[GitHub上的npmmirror白名单项目](https://github.com/cnpm/unpkg-white-list)


## 发布到 npm

> 包名以 `tabby-` 开头并包含 `tabby-plugin` 关键词，发布后即可被 Tabby 插件管理器发现。

### 发布步骤

```powershell
# 1. 首次发布或登录过期时执行
npm login

# 2. 三选一：同步 package.json 和 package-lock.json 的版本
npm version patch --no-git-tag-version # 修复、小改动
npm version minor --no-git-tag-version # 新功能、小版本
npm version major --no-git-tag-version # 不兼容改动、大版本

# 3. 编辑 update-notes.json，同步 version 并填写中英文说明

# 4. 检查并发布
npm run release
```

该命令会检查登录状态、版本与更新说明，运行类型检查、测试和打包预览；按回车确认后才会发布，不会操作 Git。

只检查可运行 `npm run publish:check`。直接运行 `npm publish` 时也会自动校验版本和更新说明。

### 更新说明

更新维护文件`update-notes.json`，每次只需要维护本次发布内容，无需累积历史。

```json
{
  "version": "1.0.0",
  "zh-CN": {
    "title": "本次更新标题",
    "sections": [
      {
        "title": "新增",
        "items": ["新增功能一", "新增功能二"]
      }
    ],
    "notice": "更新完成后需要重启 Tabby。"
  },
  "en": {
    "title": "Update title",
    "sections": [
      {
        "title": "Added",
        "items": ["New feature one", "New feature two"]
      }
    ],
    "notice": "Restart Tabby after installation."
  }
}
```

`version` 必须与 `package.json`、`package-lock.json` 一致；中英文的 `title`、`sections` 和至少一条 `items` 必填，`notice` 可省略。其他界面语言回退到英文。


## License

本项目采用 [MIT License](./LICENSE)。
