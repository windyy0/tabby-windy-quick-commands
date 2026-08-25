# Tabby Windy Quick Commands

[Simplified Chinese](./README.md) | [English](./README.en.md)

A local quick-command manager for the [Tabby](https://tabby.sh/) terminal.

The plugin adds a Quick Commands button to the upper-right corner of Tabby and opens a drawer from the right. It provides a central place to manage, search, and run frequently used commands, with support for shortcuts, multi-session sending, line-by-line execution, output triggers, and command-library import and export.

> This project has not been tested exhaustively. I built it with AI assistance because I could not find a quick-command plugin that felt both practical and polished. There may still be bugs and unhandled cases. Feel free to open an issue, and I will improve it over time. 🫨

## Project Links

- Source code: [windyy0/tabby-windy-quick-commands](https://github.com/windyy0/tabby-windy-quick-commands)
- Bug reports and suggestions: [GitHub Issues](https://github.com/windyy0/tabby-windy-quick-commands/issues)
- npm package: [tabby-windy-quick-commands](https://www.npmjs.com/package/tabby-windy-quick-commands)

## Screenshot

### Overview

![Quick Commands interface](https://raw.githubusercontent.com/windyy0/tabby-windy-quick-commands/main/docs/images/overview.png)

## Features

- Toggle the drawer from the toolbar or with a keyboard shortcut
- Search, create, edit, delete, duplicate, favorite, and pin commands
- Assign a keyboard shortcut to an individual command
- Choose between whole-command paste and line-by-line execution
- Run output triggers after the full command is sent or bind them to a specific line in line-by-line mode
- Send to the current terminal or broadcast to every open terminal session
- Import and export command libraries and plugin configuration
- Automatically switch between Chinese and English interfaces

## Installation

### Install from the Tabby Plugin Manager

After the package has been published to npm, open `Settings -> Plugins` in Tabby and search for:

```text
windy-quick-commands
```

Fully restart Tabby after installation.

### Install from Source

The repository includes a local installation script for Windows. After preparing the development environment described below, run these commands in the repository directory:

```powershell
npm ci
npm run install:tabby:restart
```

The script builds the plugin, copies the minimal runtime files into Tabby's user plugin directory, and restarts Tabby. To install without restarting, run:

```powershell
npm run install:tabby
```

## Usage

Click the Quick Commands button in the upper-right corner of Tabby to open the drawer. To configure the global toggle shortcut, open `Settings -> Hotkeys` and search for "Quick Commands."

### Import and Export

- **Export commands** in the drawer exports commands, categories, and output triggers only.
- **Export** on the Settings page exports the command library and all plugin settings, but excludes runtime logs and usage statistics.
- Both files use the unified v1 format and can be recognized from either the drawer or the Settings page. Importing a configuration file from the drawer extracts its commands only. Importing from Settings lets you choose between importing commands and importing the full configuration.
- **Restore defaults** resets plugin settings while keeping existing commands, categories, output triggers, runtime logs, and usage statistics.

> The export-file `version` remains fixed at `1` and will not increase with later format changes. The new v1 format is not compatible with command-library or configuration backups created in older formats.

### Output Triggers

In short: match condition -> successful match -> rule action -> after-match flow. A separate action can run when the rule times out.

An output trigger waits for specified terminal output before deciding how execution should continue. It is useful for workflows that must wait for terminal feedback, such as login prompts, successful builds, or deployment results.

1. Add a rule under a command's **Output triggers** section.
2. Choose when it runs: after the full command is sent, or after a specified line runs in line-by-line mode.
3. Enter a success or error match using plain text or a regular expression.
4. Configure the success or error action, the after-match flow, and the timeout. A separate timeout action runs if the wait expires.

Success and error matches can independently do nothing, send a custom command, or run an existing command. After the action finishes, execution enters the shared after-match flow:

- Full-command rules can continue to the next rule or stop automation for that session.
- Line-specific rules can continue to the next rule, skip the remaining rules for that line and continue to the next line, or stop the remaining line-by-line execution.

> Multiple rules with the same trigger timing run in order. When sending to multiple terminals, each session matches its output independently.

The interface is designed to work with a wide range of color themes.

## Development

### Requirements and Tools

- [Tabby website](https://tabby.sh/): install the Tabby client; the latest stable release is recommended.
- [Latest Tabby release](https://github.com/Eugeny/tabby/releases/latest): download installers and review release notes.
- [Node.js](https://nodejs.org/): Node.js 18 or later is required; npm is included with Node.js.
- [Git](https://git-scm.com/): clone the repository and manage versions.
- [PowerShell 7](https://learn.microsoft.com/powershell/): the Windows installation and restart scripts require `pwsh`; tests and builds do not otherwise require Windows.
- Optional editor: [Visual Studio Code](https://code.visualstudio.com/) with its built-in TypeScript support.
- An [npm account](https://www.npmjs.com/).

> Tabby currently depends on Angular 15, so this project uses the compatible TypeScript 4.9 release. The repository configures VS Code and Cursor to use the workspace TypeScript version from `node_modules`. If your editor still reports deprecation warnings from a newer TypeScript version, reload the window or run `TypeScript: Restart TS Server`.

### Local Installation

Install dependencies and install the plugin into the local Tabby plugin directory:

```powershell
npm ci
npm run install:tabby
```

> `npm ci` is recommended. Use `npm install` if the lockfile is missing, unusable, or needs to be updated.

Run tests and build the plugin:

```powershell
npm test
npm run build
```

Install into the local Tabby instance and restart it:

```powershell
npm run install:tabby:restart
```

**To uninstall the plugin, click Uninstall in Tabby's Plugin Manager.**

---

Tabby development resources:

- [Tabby source repository](https://github.com/Eugeny/tabby)
- [Tabby Plugin API documentation](https://docs.tabby.sh/)
- [Tabby development guide (HACKING.md)](https://github.com/Eugeny/tabby/blob/master/HACKING.md)
- [Tabby Core API](https://docs.tabby.sh/classes/LocaleService.html)

Common development commands:

| Command                           | Description                                               |
| --------------------------------- | --------------------------------------------------------- |
| `npm run typecheck`               | Check TypeScript types                                    |
| `npm test`                        | Compile and run tests                                     |
| `npm run clean`                   | Remove `dist` and `dist-tests`                            |
| `npm run build`                   | Clean and build `dist`                                    |
| `npm run watch`                   | Continuously rebuild when source files change             |
| `npm run install:tabby`           | Build and install into the local Tabby instance           |
| `npm run install:tabby:restart`   | Build, install, and restart Tabby                         |
| `npm run publish:check`           | Run all pre-publish checks and preview the npm package    |
| `npm run release:validate`        | Validate versions, update notes, and the latest npm version |
| `npm run release`                 | Run all checks, confirm, and publish to npm               |
| `npm pack`                        | Create a local npm installation package                   |
| `npm run clean:pack`              | Remove local `.tgz` installation packages                 |

The plugin entry point is `dist/index.js`. The `dist` directory is not committed to Git; it is generated before builds and npm publishing.

## Publishing to npm

> Packages whose names begin with `tabby-` and include the `tabby-plugin` keyword can be discovered by Tabby's Plugin Manager after publication.

### Release Steps

```powershell
# 1. Run this for the first release or after your login expires
npm login

# 2. Choose one command to update the versions in package.json and package-lock.json
npm version patch --no-git-tag-version # Fixes and small changes
npm version minor --no-git-tag-version # New features
npm version major --no-git-tag-version # Breaking changes

# 3. Edit update-notes.json, synchronize its version, and add Chinese and English notes

# 4. Validate and publish
npm run release
```

This command verifies the npm login, version, and update notes; runs type checking, tests, and a package preview; and publishes only after confirmation. It does not modify Git history.

Run `npm run publish:check` to validate without publishing. Running `npm publish` directly also validates the version and update notes automatically.

### Update Notes

```json
{
  "version": "1.6.0",
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

The `version` must match `package.json` and `package-lock.json`. Both languages require a `title`, `sections`, and at least one item; `notice` is optional. Other interface languages fall back to English.

Only the current release notes need to be maintained; they do not accumulate in this file. The plugin checks the npm `latest` version, reads the corresponding notes through jsDelivr, and automatically assembles the update history. Versions without a notes file display a fallback message.

## License

This project is licensed under the [MIT License](./LICENSE).
