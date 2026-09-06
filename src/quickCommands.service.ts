import { Injectable, Optional } from '@angular/core'
import { SettingsTabComponent } from 'tabby-settings'
import { AppService, ConfigService, HotkeysService, LogService, Logger, PlatformService } from 'tabby-core'
import {
    AutomationLogEntry,
    ExecutionMode,
    ImportMode,
    QuickAutomationRule,
    QuickCommand,
    QuickCommandsConfig,
} from './types'
import { createDefaultQuickCommandsConfig } from './configProvider'
import {
    applyImportPreview,
    buildImportPreview,
    ImportPreview,
    normalizeCommandConfig,
    normalizeCommandText,
    parseImportPayload,
    quickCommandsFileFormat,
    quickCommandsFileVersion,
    resolveSelectedCommand,
    sanitizeAutomationReferences,
} from './commandLibrary'
import {
    findShortcutConflict,
    flattenHotkeysConfig,
    isValidShortcut,
    normalizeShortcut,
    normalizeShortcutKey,
    shortcutFromKeyboardEvent,
} from './shortcutManager'
import { shouldHandleDelegatedAction } from './delegatedClick'
import { getDangerCheck } from './safety'
import { getExecutableLineCount } from './scriptParser'
import { CommandUsageStats, QuickCommandsRuntimeStore } from './runtimeStorage'
import { isValidOutputPattern } from './outputAutomation'
import { pluginConfigChangedEvent, QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { QuickCommandsI18n } from './i18n'
import { quickCommandIcons as icons } from './quickCommandsIcons'
import { QuickCommandsPluginUpdateService } from './pluginUpdate.service'
import { pluginIdentity } from './pluginIdentity'
import { pluginDataResetEvent } from './pluginData'
import { fitCategoryPrefix } from './categoryLayout'
import {
    formatPluginHotkeyBinding,
    PluginHotkeyAction,
    pluginHotkeyBindingId,
    pluginHotkeyDefinitions,
    readPluginHotkeyBindings,
    reservedQuickCommandsShortcuts,
} from './pluginHotkeys'
import {
    ExecutionRunState,
    ExecutionTarget,
    QuickCommandsExecutionRunner,
} from './executionRunner'
import { ActivityLogService } from './activityLog/activityLog.service'
import { activityLogSizeValue, normalizeActivityLogRetention } from './activityLog/activityLog.retention'
import { ActivityLogDraft, ActivityLogStatus } from './activityLog/activityLog.types'

require('./quickCommands.css')

type TerminalTabLike = ExecutionTarget
type DrawerFocusArea = 'drawer' | 'terminal'
type DrawerFocusTarget = 'search' | 'surface'

interface WindowControlsOverlayLike {
    visible: boolean
    getTitlebarAreaRect: () => DOMRect
    addEventListener: (type: 'geometrychange', listener: () => void) => void
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
    windowControlsOverlay?: WindowControlsOverlayLike
}

interface ExecutionSummary {
    modeLabel: string
    targetCount: number
    targetNames: string[]
    lineCount: number
    autoEnter: boolean
    danger: boolean
    reasons: string[]
    requiresTypedConfirm: boolean
    requiredText: string
    requiresConfirm: boolean
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class QuickCommandsService {
    private root?: HTMLElement
    private visible = false
    private running = false
    private filter = ''
    private focusArea: DrawerFocusArea = 'terminal'
    private drawerFocusTarget: DrawerFocusTarget = 'search'
    private focusAreaBeforeRootClick: DrawerFocusArea | null = null
    private searchReturnCategory: string | null = null
    private searchReturnCommandId: string | null = null
    private message = ''
    private pendingExecutionId: string | null = null
    private pendingDeleteId: string | null = null
    private pendingRuleDeleteId: string | null = null
    private addingCommand = false
    private newCommandName = ''
    private newCommandNameEdited = false
    private newCommandDescription = ''
    private movingCommandId: string | null = null
    private moveTargetCategory = ''
    private moveCategoryMenuOpen = false
    private editingCommandId: string | null = null
    private editCommandName = ''
    private editCommandDescription = ''
    private addingCategory = false
    private renamingCategory = false
    private deletingCategory = false
    private categoryInput = ''
    private pendingFailureMessage = ''
    private confirmInput = ''
    private composingSearch = false
    private importPreview: ImportPreview | null = null
    private draggedCommandId: string | null = null
    private draggedCategory: string | null = null
    private categoryDropPlacement: 'before' | 'after' = 'before'
    private categoryMenuOpen = false
    private targetMenuOpen = false
    private commandMenuOpen = false
    private categoryOverflowOpen = false
    private libraryMenuOpen = false
    private categoryActionsOpen = false
    private automationRuleMenuKey: string | null = null
    private resizeMove?: (event: MouseEvent) => void
    private resizeEnd?: () => void
    private runState?: ExecutionRunState
    private executionRunner?: QuickCommandsExecutionRunner
    private ruleHeadResizeObserver?: ResizeObserver
    private targetKeys = new WeakMap<TerminalTabLike, string>()
    private nextTargetKey = 0
    private renderedCommandId: string | null = null
    private pendingAutomationRuleScrollId: string | null = null
    private writingPluginConfig = false
    private pluginConfigDirty = false
    private pendingPluginConfigWrite: Record<string, unknown> | null = null
    private pluginConfigWriteTimer: number | null = null
    private windowControlsOverlayBound = false
    private activityLogSizeWarningShown = false
    private readonly pluginConfigWriteDelay = 400
    private runtimeStore: QuickCommandsRuntimeStore
    private activityLog: ActivityLogService
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private state: QuickCommandsConfig
    private logger: Logger

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        log: LogService,
        private i18n: QuickCommandsI18n,
        private pluginUpdate: QuickCommandsPluginUpdateService,
        @Optional() private hotkeys?: HotkeysService,
    ) {
        this.logger = log.create('quick-commands')
        this.runtimeStore = new QuickCommandsRuntimeStore(platform.getConfigPath())
        this.activityLog = new ActivityLogService(platform.getConfigPath())
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(platform.getConfigPath())
        this.state = this.readConfig()
        this.state.automationLogs = this.activityLog.prune(normalizeActivityLogRetention(this.state as unknown as Record<string, unknown>))

        this.config.ready$.subscribe(() => {
            this.state = this.readConfig(true)
            this.state.automationLogs = this.activityLog.prune(normalizeActivityLogRetention(this.state as unknown as Record<string, unknown>))
            this.render()
        })
        window.addEventListener(pluginConfigChangedEvent, () => {
            if (this.writingPluginConfig) {
                return
            }
            this.cancelScheduledPluginConfigWrite()
            this.pluginConfigDirty = false
            this.state = this.readConfig(true)
            this.state.automationLogs = this.activityLog.prune(normalizeActivityLogRetention(this.state as unknown as Record<string, unknown>))
            this.render()
        })
        window.addEventListener('beforeunload', () => this.persistPluginConfig())
        window.addEventListener(pluginDataResetEvent, () => {
            this.cancelScheduledPluginConfigWrite()
            this.pluginConfigDirty = false
            this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
            this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
            this.activityLog = new ActivityLogService(this.platform.getConfigPath())
            this.state = this.readConfig()
            this.filter = ''
            this.searchReturnCategory = null
            this.searchReturnCommandId = null
            this.editingCommandId = null
            this.editCommandName = ''
            this.editCommandDescription = ''
            this.message = ''
            this.close()
        })
        document.addEventListener('keydown', event => this.handleDocumentKeyDown(event), true)
        document.addEventListener('click', event => this.handleDocumentClick(event))
        document.addEventListener('focusin', event => this.handleDocumentFocusIn(event))
        this.i18n.localeChanged$.subscribe(() => {
            if (this.addingCommand && !this.newCommandNameEdited) {
                this.newCommandName = this.getDefaultNewCommandName()
            }
            this.render()
        })
        this.pluginUpdate.state$.subscribe(() => this.render())
        const nativeHotkeys = this.hotkeys?.unfilteredHotkey$
        if (nativeHotkeys) {
            nativeHotkeys.subscribe(hotkey => this.handleMatchedPluginHotkey(hotkey))
        }
    }

    toggle (): void {
        if (this.visible) {
            this.close()
        } else {
            this.open()
        }
    }

    open (): void {
        this.showDrawer()
        if (this.state.drawerInitialFocus === 'terminal' && this.focusCurrentTerminal()) {
            return
        }
        this.focusDrawerSearch()
    }

    openCommand (commandId: string): void {
        this.state = this.readConfig(true)
        const command = this.state.commands.find(item => item.id === commandId)
        if (!command) { return }
        this.filter = ''
        this.searchReturnCategory = null
        this.searchReturnCommandId = null
        this.updateConfig({
            selectedCategory: command.category || '默认',
            selectedCommandId: command.id,
            moreSettingsCollapsed: false,
        }, true, false)
        this.showDrawer()
        this.focusDrawerSearch()
    }

    private showDrawer (): void {
        this.visible = true
        this.ensureRoot()
        this.syncWindowControlsOverlay()
        // This attribute deliberately has no channel-specific CSS prefix. Both
        // bundles use DOM order to agree which visible drawer owns Ctrl+Enter.
        this.root!.setAttribute('data-windy-quick-commands-drawer', 'open')
        document.body.appendChild(this.root!)
        this.render()
    }

    private isForegroundDrawer (): boolean {
        const drawers = document.querySelectorAll('[data-windy-quick-commands-drawer="open"]')
        return this.visible && drawers[drawers.length - 1] === this.root
    }

    get dataDirectory (): string | null {
        return this.pluginConfigStore.dataAccess.directory
    }

    restoreInitialState (): void {
        if (this.running) {
            throw new Error('当前插件仍有命令正在执行，请停止执行后再重置插件数据。')
        }
        if (this.pluginUpdate.snapshot.status === 'installing') {
            throw new Error('插件正在更新，请更新完成后再重置插件数据。')
        }
        this.pluginConfigStore.reset(createDefaultQuickCommandsConfig(this.i18n.language))
        window.dispatchEvent(new CustomEvent(pluginDataResetEvent))
    }

    close (): void {
        this.persistPluginConfig()
        this.visible = false
        this.root?.removeAttribute('data-windy-quick-commands-drawer')
        this.pendingExecutionId = null
        this.pendingDeleteId = null
        this.pendingRuleDeleteId = null
        this.addingCommand = false
        this.resetNewCommandDraft()
        this.movingCommandId = null
        this.moveTargetCategory = ''
        this.moveCategoryMenuOpen = false
        this.addingCategory = false
        this.renamingCategory = false
        this.deletingCategory = false
        this.categoryInput = ''
        this.categoryMenuOpen = false
        this.targetMenuOpen = false
        this.commandMenuOpen = false
        this.categoryOverflowOpen = false
        this.libraryMenuOpen = false
        this.categoryActionsOpen = false
        this.importPreview = null
        this.render()
        this.focusCurrentTerminal()
    }

    private ensureRoot (): void {
        if (!this.root) {
            this.root = document.createElement('div')
            this.root.className = 'tqc-root'
            this.root.addEventListener('keydown', event => this.handleRootKeyDown(event))
            this.root.addEventListener('click', event => this.handleRootClick(event), true)
            this.root.addEventListener('click', event => this.handleDelegatedRootClick(event))
            this.root.addEventListener('dragstart', event => this.handleDelegatedCommandDragStart(event))
            this.root.addEventListener('dragover', event => this.handleDelegatedCommandDragOver(event))
            this.root.addEventListener('drop', event => this.handleDelegatedCommandDrop(event))
            this.root.addEventListener('dragend', event => this.handleDelegatedCommandDragEnd(event))
            document.body.appendChild(this.root)
            this.bindWindowControlsOverlay()
        }
    }

    private bindWindowControlsOverlay (): void {
        if (this.windowControlsOverlayBound) {
            return
        }
        const overlay = typeof navigator === 'undefined'
            ? undefined
            : (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay
        if (!overlay) {
            return
        }
        this.windowControlsOverlayBound = true
        overlay.addEventListener('geometrychange', () => this.syncWindowControlsOverlay())
        window.addEventListener('resize', () => this.syncWindowControlsOverlay())
    }

    private syncWindowControlsOverlay (): void {
        if (!this.root) {
            return
        }
        const overlay = typeof navigator === 'undefined'
            ? undefined
            : (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay
        if (!overlay) {
            return
        }
        if (!overlay.visible) {
            this.root.style.setProperty('--tqc-window-controls-width', '0px')
            this.root.style.setProperty('--tqc-window-controls-height', '0px')
            return
        }
        const rect = overlay.getTitlebarAreaRect()
        const controlRightEdge = Math.max(0, rect.x + rect.width)
        const controlWidth = Math.max(0, window.innerWidth - controlRightEdge)
        const controlHeight = Math.max(0, rect.y + rect.height)
        this.root.style.setProperty('--tqc-window-controls-width', `${controlWidth}px`)
        this.root.style.setProperty('--tqc-window-controls-height', `${controlHeight}px`)
    }

    private render (): void {
        if (!this.root) {
            return
        }

        const shouldRestoreDrawerFocus = this.shouldRestoreDrawerFocusAfterRender()
        const detailScrollTop = this.root.querySelector<HTMLElement>('.tqc-detail')?.scrollTop || 0
        const listScrollTop = this.root.querySelector<HTMLElement>('.tqc-list')?.scrollTop || 0
        const commands = this.getFilteredCommands()
        const selected = resolveSelectedCommand(commands, this.state.selectedCommandId)
        this.renderedCommandId = selected?.id || null
        const categories = this.getCategories()
        const terminals = this.getTerminalTabs()
        const currentTerminal = this.getCurrentTerminalTab()
        const targetCount = this.getTargetTabs().length
        const danger = selected ? this.getDanger(selected.command).dangerous : false
        const hint = this.message || this.getHint(selected, targetCount, danger)
        const canSort = Boolean(selected && this.canSortSelectedCategory())
        const searching = Boolean(this.filter.trim())

        this.root.className = `tqc-root${this.visible ? ' tqc-open' : ''}${searching ? ' tqc-searching' : ''}${this.state.showOperationHints ? ' tqc-hints-visible' : ''} tqc-focus-${this.focusArea}`
        this.root.style.setProperty('--tqc-width', `${this.clampWidth(this.state.drawerWidth)}px`)
        this.root.innerHTML = `
          <aside class="tqc-drawer" aria-label="${this.escapeAttr(this.i18n.text(pluginIdentity.title))}">
            ${this.state.showOperationHints ? this.renderShortcutRail() : ''}
            <div class="tqc-resize-handle" data-role="resize-handle" title="调整宽度"></div>
            <div class="tqc-interactive-surface" data-role="drawer-surface" tabindex="-1">
              <header class="tqc-header">
              <div class="tqc-top-row">
                <button class="tqc-icon-button" type="button" data-action="collapse" aria-label="${this.escapeAttr(this.i18n.text('收起'))}">${icons.collapse}</button>
                ${this.shouldShowUpdateReminder() ? `
                  <button class="tqc-update-button" type="button" data-action="update-settings" aria-label="${this.escapeAttr(this.i18n.text('查看插件更新'))}">
                    <span class="tqc-update-dot" aria-hidden="true"></span><span>${this.escape(this.i18n.text('有更新'))}</span>
                  </button>
                ` : ''}
              </div>
              <div class="tqc-titlebar">
                <div class="tqc-title">${icons.bolt}<span>${this.escape(this.i18n.text(pluginIdentity.title))}</span></div>
                <div class="tqc-header-menu-shell">
                  <button class="tqc-secondary${this.libraryMenuOpen ? ' tqc-active' : ''}" type="button" data-action="toggle-library-menu" aria-haspopup="menu" aria-expanded="${this.libraryMenuOpen}">命令库 ${icons.chevron}</button>
                  ${this.libraryMenuOpen ? `
                    <div class="tqc-action-menu" role="menu">
                      <button type="button" role="menuitem" data-action="import">${icons.import}<span>导入命令</span></button>
                      <button type="button" role="menuitem" data-action="export">${icons.export}<span>导出命令</span></button>
                    </div>
                  ` : ''}
                </div>
                <button class="tqc-icon-button" type="button" data-action="settings" title="设置">${icons.settings}</button>
                <button class="tqc-icon-button" type="button" data-action="close" title="关闭">${icons.close}</button>
              </div>
              <div class="tqc-search-row">
                <input class="tqc-search" data-role="search" placeholder="搜索命令" value="${this.escapeAttr(this.filter)}">
                ${this.filter ? `<button class="tqc-icon-button tqc-search-clear" type="button" data-action="clear-search" data-tooltip="清空搜索" aria-label="清空搜索">${icons.clear}</button>` : ''}
              </div>
              <input class="tqc-hidden-file" type="file" accept="application/json,.json" data-role="import-file">
              <div class="tqc-categories">
                <div class="tqc-category-scroll">
                  ${categories.map(category => `
                    <button class="tqc-chip${this.state.selectedCategory === category ? ' tqc-active' : ''}" type="button" data-i18n-skip data-category="${this.escapeAttr(category)}" ${this.canDragCategory(category) ? 'draggable="true"' : ''}>
                      ${this.escape(this.getCategoryLabel(category))}
                    </button>
                  `).join('')}
                </div>
                <div class="tqc-category-actions">
                  <button class="tqc-icon-button tqc-category-overflow-toggle${this.categoryOverflowOpen ? ' tqc-active' : ''}" type="button" data-action="toggle-category-overflow" data-role="category-overflow-toggle" ${this.categoryOverflowOpen ? '' : 'data-tooltip="更多分类"'} aria-label="${this.categoryOverflowOpen ? '收起更多分类' : '更多分类'}" aria-haspopup="menu" aria-expanded="${this.categoryOverflowOpen}"><span class="tqc-category-overflow-label" data-role="category-overflow-label" data-i18n-skip hidden></span>${icons.chevron}</button>
                  <button class="tqc-icon-button" type="button" data-action="add-category" title="添加分类">${icons.plus}</button>
                  <div class="tqc-category-action-menu-shell">
                    <button class="tqc-icon-button${this.categoryActionsOpen ? ' tqc-active' : ''}" type="button" data-action="toggle-category-actions" ${this.categoryActionsOpen ? 'aria-label="分类操作"' : 'title="分类操作"'} aria-haspopup="menu" aria-expanded="${this.categoryActionsOpen}">${icons.more}</button>
                    ${this.categoryActionsOpen ? `
                      <div class="tqc-action-menu" role="menu">
                        <button type="button" role="menuitem" data-action="rename-category" ${this.canRenameSelectedCategory() ? '' : 'disabled'}>${icons.edit}<span>重命名分类</span></button>
                        <button class="tqc-menu-danger" type="button" role="menuitem" data-action="delete-category" ${this.canDeleteSelectedCategory() ? '' : 'disabled'}>${icons.trash}<span>删除分类</span></button>
                      </div>
                    ` : ''}
                  </div>
                </div>
                ${this.categoryOverflowOpen ? `
                  <div class="tqc-category-overflow-menu" role="menu">
                    <input class="tqc-category-overflow-search" data-role="category-overflow-search" placeholder="搜索分类">
                    <div class="tqc-category-overflow-options">
                      ${categories.map(category => `
                        <button class="tqc-category-overflow-option${this.state.selectedCategory === category ? ' tqc-active' : ''}" type="button" role="menuitem" data-i18n-skip data-category="${this.escapeAttr(category)}" data-category-overflow-option ${this.canDragCategory(category) ? 'draggable="true"' : ''}>
                          ${this.escape(this.getCategoryLabel(category))}
                        </button>
                      `).join('')}
                    </div>
                  </div>
                ` : ''}
              </div>
              </header>

              <main class="tqc-body">
              <div class="tqc-list-pane">
                <section class="tqc-list">
                  ${commands.length ? commands.map(command => this.renderCommandListItem(command, selected?.id === command.id)).join('') : '<div class="tqc-empty">没有匹配的命令</div>'}
                </section>
                <div class="tqc-list-actions">
                  <button class="tqc-icon-button" type="button" data-action="new" title="新建命令">${icons.plus}</button>
                  <div class="tqc-list-sort">
                    <button class="tqc-icon-button" type="button" data-action="move-up" title="${canSort ? '上移命令' : '请进入具体分类排序'}" ${canSort ? '' : 'disabled'}>${icons.up}</button>
                    <button class="tqc-icon-button" type="button" data-action="move-down" title="${canSort ? '下移命令' : '请进入具体分类排序'}" ${canSort ? '' : 'disabled'}>${icons.down}</button>
                  </div>
                </div>
              </div>

              <section class="tqc-detail">
                ${selected ? this.renderDetail(selected, terminals.length, currentTerminal) : this.renderEmptyDetail()}
              </section>
              </main>

              <footer class="tqc-footer">
                <div class="tqc-hint${danger ? ' tqc-danger' : ''}">${this.escape(hint)}</div>
                ${this.renderFooter(selected, targetCount)}
              </footer>
            </div>
          </aside>
          ${this.renderOverlays(selected)}
          <div class="tqc-tooltip" data-role="tooltip" role="tooltip"></div>
        `

        this.i18n.localizeElement(this.root)
        this.layoutCategories()
        this.bindEvents()
        this.restoreScroll(detailScrollTop, listScrollTop)
        this.scrollToPendingAutomationRule()
        this.focusSelectedOverflowCategory()
        this.restoreDrawerFocusAfterRender(shouldRestoreDrawerFocus)
    }

    private renderShortcutRail (): string {
        const drawerFocused = this.focusArea === 'drawer'
        const focusShortcut = this.getPrimaryHotkeyLabel('switchFocus')
        const compactFocusShortcut = this.getCompactHotkeyLabel(focusShortcut)
        const hintsShortcut = this.getPrimaryHotkeyLabel('toggleHints')
        const hintsTooltip = `${hintsShortcut}：${this.i18n.text('隐藏/显示快捷键提示')}`
        const focusTitle = drawerFocused ? '抽屉焦点' : '终端焦点'
        return `
          <aside class="tqc-shortcut-rail tqc-shortcut-rail-${drawerFocused ? 'drawer' : 'terminal'}"
            aria-label="${this.escapeAttr(`快捷键，当前${focusTitle}`)}" aria-live="polite">
            <div class="tqc-shortcut-rail-head">
              <span class="tqc-shortcut-rail-icon" tabindex="0" data-tooltip="${this.escapeAttr(hintsTooltip)}">${icons.keyboard}</span>
              <span class="tqc-shortcut-rail-head-label">快捷键</span>
            </div>
            <div class="tqc-shortcut-rail-items">
              <div class="tqc-shortcut-rail-item tqc-shortcut-rail-focus" title="${this.escapeAttr(focusShortcut)}">
                <span class="tqc-shortcut-rail-key">${this.escape(compactFocusShortcut)}</span>
                <span class="tqc-shortcut-rail-label" data-role="shortcut-rail-focus-label">${drawerFocused ? '终端' : '搜索'}</span>
              </div>
              <div class="tqc-shortcut-rail-item tqc-shortcut-rail-navigation">
                <span class="tqc-shortcut-rail-key">↑ ↓</span><span class="tqc-shortcut-rail-label">命令</span>
              </div>
              <div class="tqc-shortcut-rail-item tqc-shortcut-rail-navigation tqc-shortcut-rail-category">
                <span class="tqc-shortcut-rail-key">← →</span><span class="tqc-shortcut-rail-label">分类</span>
              </div>
              <div class="tqc-shortcut-rail-item tqc-shortcut-rail-navigation">
                <span class="tqc-shortcut-rail-key">Enter</span><span class="tqc-shortcut-rail-label">执行</span>
              </div>
              <div class="tqc-shortcut-rail-item tqc-shortcut-rail-terminal-action" title="Ctrl+Enter">
                <span class="tqc-shortcut-rail-key tqc-shortcut-rail-key-stacked"><span>Ctrl+</span><span>Enter</span></span>
                <span class="tqc-shortcut-rail-label">执行</span>
              </div>
            </div>
          </aside>
        `
    }

    private renderCommandListItem (command: QuickCommand, selected: boolean): string {
        const badges = [
            this.state.selectedCategory === '全部' ? `<span class="tqc-pill" data-i18n-skip>${this.escape(this.getCategoryLabel(command.category))}</span>` : '',
            command.shortcut ? `<span class="tqc-kbd">${this.escape(command.shortcut)}</span>` : '',
            command.pinned ? '<span class="tqc-pill">置顶</span>' : '',
            command.favorite ? '<span class="tqc-pill">收藏</span>' : '',
        ].filter(Boolean)
        return `
          <div class="tqc-command-shell">
            <button class="tqc-command${selected ? ' tqc-selected' : ''}" type="button" draggable="true" data-command-id="${this.escapeAttr(command.id)}">
              <div class="tqc-command-top">
                <div class="tqc-command-name" data-i18n-skip title="${this.escapeAttr(command.name)}">${this.escape(command.name)}</div>
              </div>
              ${command.description ? `<div class="tqc-command-desc" data-i18n-skip>${this.escape(command.description)}</div>` : ''}
              ${badges.length ? `<div class="tqc-command-meta">${badges.join('')}</div>` : ''}
            </button>
            <button class="tqc-icon-button tqc-command-edit" type="button" data-action="edit-command" data-command-edit-id="${this.escapeAttr(command.id)}" data-tooltip="编辑名称和说明" aria-label="编辑名称和说明">${icons.edit}</button>
            <button class="tqc-icon-button tqc-command-run" type="button" data-action="execute-command" data-command-execute-id="${this.escapeAttr(command.id)}" data-tooltip="执行命令" data-tooltip-command-name="${this.escapeAttr(command.name)}" aria-label="执行命令">${icons.run}</button>
          </div>
        `
    }

    private renderDetail (command: QuickCommand, terminalCount: number, currentTerminal: TerminalTabLike | null): string {
        return `
          <div class="tqc-detail-head">
            <div class="tqc-command-actions">
              <button class="tqc-icon-button${command.favorite ? ' tqc-active' : ''}" type="button" data-action="toggle-favorite" data-tooltip="收藏/取消收藏" aria-label="收藏/取消收藏">${command.favorite ? icons.starFilled : icons.star}</button>
              <button class="tqc-icon-button${command.pinned ? ' tqc-active' : ''}" type="button" data-action="toggle-pin" data-tooltip="置顶/取消置顶" aria-label="置顶/取消置顶">${command.pinned ? icons.pinFilled : icons.pin}</button>
              <button class="tqc-icon-button tqc-menu-danger" type="button" data-action="delete" data-tooltip="删除命令" aria-label="删除命令">${icons.trash}</button>
              <div class="tqc-command-menu-shell">
                <button class="tqc-icon-button${this.commandMenuOpen ? ' tqc-active' : ''}" type="button" data-action="toggle-command-menu" ${this.commandMenuOpen ? '' : 'data-tooltip="更多操作"'} aria-label="更多操作" aria-haspopup="menu" aria-expanded="${this.commandMenuOpen}">${icons.more}</button>
                ${this.commandMenuOpen ? `
                  <div class="tqc-command-menu" role="menu">
                    <button type="button" role="menuitem" data-action="duplicate" data-tooltip="复制当前命令并创建新的命令项">${icons.duplicate}<span>复制为新命令</span></button>
                    <button type="button" role="menuitem" data-action="move-command">${icons.move}<span>移动命令</span></button>
                  </div>
                ` : ''}
              </div>
            </div>
          </div>

          ${this.renderCommandEditorCard(command)}
          ${this.renderExecutionOptions(command, terminalCount, currentTerminal)}
          ${this.renderCommandDetailsCard(command)}
          ${this.renderMoreSettingsCard(command)}
        `
    }

    private renderCommandDetailsCard (command: QuickCommand): string {
        return `
          <div class="tqc-card">
            <div class="tqc-card-head tqc-collapsible">
              <div class="tqc-card-title">
                <span class="tqc-label">基础信息</span>
                <div class="tqc-card-summary">名称、分类与说明</div>
              </div>
              <button class="tqc-mini" type="button" data-action="toggle-detail">${icons.chevron} ${this.state.basicInfoCollapsed ? '展开' : '折叠'}</button>
            </div>
            ${this.state.basicInfoCollapsed ? '' : `<div class="tqc-card-content">
              <div class="tqc-field-grid">
                <label>
                  <span class="tqc-label">名称</span>
                  <input class="tqc-input" data-field="name" value="${this.escapeAttr(command.name)}">
                </label>
                <label>
                  <span class="tqc-label">分类</span>
                  ${this.renderCategoryDropdown(command.category)}
                </label>
              </div>
              <label class="tqc-full-field" style="margin-top:10px">
                <span class="tqc-label">说明</span>
                <input class="tqc-input" data-field="description" value="${this.escapeAttr(command.description)}">
              </label>
            </div>`}
          </div>
        `
    }

    private renderCommandEditorCard (command: QuickCommand): string {
        const lineCount = command.command ? command.command.split(/\r?\n/).length : 0
        return `
          <div class="tqc-card tqc-command-card">
            <label>
              <div class="tqc-card-head">
                <span class="tqc-label">命令内容</span>
                <span class="tqc-card-summary" data-role="command-line-count">${lineCount} 行</span>
              </div>
              <div class="tqc-command-editor-shell">
                <textarea class="tqc-textarea tqc-command-editor" data-field="command" data-role="command-editor" rows="1" style="--tqc-command-height:${Math.max(lineCount, 1) * 1.48}em" spellcheck="false">${this.escape(command.command)}</textarea>
                <div class="tqc-command-line-endings" aria-hidden="true"><div class="tqc-command-line-endings-inner" data-role="command-line-endings">${this.renderCommandLineEndings(command.command, command.autoEnter)}</div></div>
              </div>
            </label>
            ${this.state.executionMode === 'line' ? this.renderLineDelayEditor(command) : ''}
          </div>
        `
    }

    private renderCommandLineEndings (commandText: string, autoEnter: boolean): string {
        const lines = commandText.split(/\r?\n/)
        return lines
            .map((_line, index) => {
                const enter = index < lines.length - 1 || autoEnter
                return `<span class="tqc-command-line-ending${enter ? '' : ' tqc-no-enter'}">${enter ? '↵' : '×↵'}</span>`
            })
            .join('')
    }


    private renderLineDelayEditor (command: QuickCommand): string {
        const lines = command.command.split(/\r?\n/)
        return `
          <div data-role="line-settings" style="margin-top:12px">
            <div class="tqc-card-head">
              <span class="tqc-label">逐行执行设置</span>
              <span class="tqc-card-summary">延迟 / 执行后状态 / 输出规则</span>
            </div>
            <div class="tqc-code${lines.length > 7 ? ' tqc-code-scroll' : ''}" aria-label="逐行设置">
              ${lines.map((line, index) => {
                  const executable = Boolean(line.trim() && !line.trim().startsWith('#'))
                  const pauseAfter = executable && command.linePauses?.[index] === true
                  const ruleCount = executable
                      ? command.automationRules.filter(rule => rule.triggerLine === index + 1).length
                      : 0
                  const ruleAction = ruleCount ? 'focus-line-rules' : 'add-line-rule'
                  const ruleTooltip = ruleCount
                      ? `查看第 ${index + 1} 行的 ${ruleCount} 条输出规则`
                      : `为第 ${index + 1} 行添加输出规则`
                  return `
                <div class="tqc-code-line${executable ? '' : ' tqc-non-executable'}${pauseAfter ? ' tqc-pause-after' : ''}">
                  <div class="tqc-line-no">${index + 1}</div>
                  <div class="tqc-line-text" title="${this.escapeAttr(line || ' ')}">${this.escape(line || ' ')}</div>
                  <div class="tqc-line-tools">
                    <input class="tqc-input tqc-line-delay" type="number" min="0" step="100" data-line-delay="${index}" title="该行延迟" value="${this.escapeAttr(String(command.lineDelays?.[index] ?? command.lineDelay))}"${executable ? '' : ' disabled'}>
                    <button class="tqc-icon-button tqc-line-pause${pauseAfter ? ' tqc-active' : ''}" type="button" data-line-pause="${index}" data-tooltip="${pauseAfter ? '点击改为执行后继续' : '点击改为执行后暂停'}" aria-label="${pauseAfter ? '当前为执行后暂停，点击改为执行后继续' : '当前为执行后继续，点击改为执行后暂停'}" aria-pressed="${pauseAfter}"${executable ? '' : ' disabled'}>${pauseAfter ? `${icons.play}<span>执行后暂停</span>` : `${icons.pause}<span>执行后继续</span>`}</button>
                    <button class="tqc-icon-button tqc-line-rule${ruleCount ? ' tqc-has-rules' : ''}" type="button" data-line-rule-action="${ruleAction}" data-rule-line="${index + 1}" data-tooltip="${ruleTooltip}" aria-label="${ruleTooltip}"${executable ? '' : ' disabled'}>${icons.bolt}<span>${ruleCount ? `规则 ${ruleCount}` : '规则 +'}</span></button>
                  </div>
                </div>
              `}).join('')}
            </div>
          </div>
        `
    }

    private renderExecutionOptions (command: QuickCommand, terminalCount: number, currentTerminal: TerminalTabLike | null): string {
        return `
          <div class="tqc-card tqc-execution-card">
            <span class="tqc-label">执行设置</span>
            <div class="tqc-mode-row">
              ${this.renderModeButton('paste', '粘贴', '原样发送')}
              ${this.renderModeButton('line', '逐行', '可暂停/继续')}
            </div>
            <div class="tqc-field-grid${this.state.executionMode === 'line' ? '' : ' tqc-single'}">
              <label>
                <span class="tqc-label">目标会话</span>
                ${this.renderTargetDropdown(terminalCount, currentTerminal)}
              </label>
              ${this.state.executionMode === 'line' ? `<label>
                <span class="tqc-label">默认逐行间隔</span>
                <input class="tqc-input" type="number" min="0" step="100" data-field="lineDelay" value="${this.escapeAttr(String(command.lineDelay))}">
              </label>` : ''}
            </div>
            <div style="margin-top:10px">
              <label class="tqc-checkbox">
                <input class="tqc-checkbox-control" type="checkbox" data-role="auto-enter" aria-label="发送后自动回车" ${command.autoEnter ? 'checked' : ''}>
                <span>发送后自动回车</span>
              </label>
            </div>
          </div>
        `
    }

    private renderTargetDropdown (terminalCount: number, currentTerminal: TerminalTabLike | null): string {
        const currentLabel = `当前会话${currentTerminal ? `：${this.getTabTitle(currentTerminal)}` : ''}`
        const allLabel = `所有会话（${terminalCount}）`
        const selectedLabel = this.state.targetMode === 'all' ? allLabel : currentLabel
        return `
          <div class="tqc-target-select">
            <button class="tqc-select" type="button" data-action="target-menu-toggle" aria-haspopup="listbox" aria-expanded="${this.targetMenuOpen}">
              <span title="${this.escapeAttr(selectedLabel)}">${this.escape(selectedLabel)}</span>
              ${icons.chevron}
            </button>
            ${this.targetMenuOpen ? `
              <div class="tqc-target-menu" role="listbox">
                <button class="tqc-target-option${this.state.targetMode === 'current' ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${this.state.targetMode === 'current'}" data-action="target-select" data-target-value="current" title="${this.escapeAttr(currentLabel)}">${this.escape(currentLabel)}</button>
                <button class="tqc-target-option${this.state.targetMode === 'all' ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${this.state.targetMode === 'all'}" data-action="target-select" data-target-value="all" title="${this.escapeAttr(allLabel)}">${this.escape(allLabel)}</button>
              </div>
            ` : ''}
          </div>
        `
    }

    private renderMoreSettingsCard (command: QuickCommand): string {
        const summary = [
            command.shortcut ? `快捷键 ${command.shortcut}` : '',
            command.automationRules.length ? `${command.automationRules.length} 条自动化规则` : '',
        ].filter(Boolean).join(' · ')
        return `
          <div class="tqc-card">
            <div class="tqc-card-head">
              <div class="tqc-card-title">
                <span class="tqc-label">更多设置</span>
                ${summary ? `<div class="tqc-card-summary">${this.escape(summary)}</div>` : ''}
              </div>
              <button class="tqc-mini" type="button" data-action="toggle-more-settings">${icons.chevron} ${this.state.moreSettingsCollapsed ? '展开' : '折叠'}</button>
            </div>
            ${this.state.moreSettingsCollapsed ? '' : `
              <div class="tqc-more-content">
                <label>
                  <span class="tqc-label">快捷键</span>
                  <span class="tqc-shortcut-field">
                    <input class="tqc-input" data-field="shortcut" data-role="shortcut-input" aria-label="命令快捷键" aria-describedby="tqc-command-shortcut-hint" placeholder="点击录入" readonly value="${this.escapeAttr(command.shortcut || '')}">
                    <button class="tqc-icon-button" type="button" data-action="clear-shortcut" title="清空快捷键">${icons.clear}</button>
                  </span>
                  <span class="tqc-field-hint" id="tqc-command-shortcut-hint" data-role="shortcut-hint" aria-live="polite">设置后，在终端中按下快捷键即可执行命令。</span>
                </label>
                <div class="tqc-more-section">
                  <div class="tqc-card-head tqc-automation-toolbar">
                    <span class="tqc-label">输出触发器</span>
                    <div class="tqc-automation-actions">
                      <button class="tqc-mini" type="button" data-action="toggle-all-rules" ${command.automationRules.length ? '' : 'disabled'}>${icons.chevron} ${command.automationRules.some(rule => !rule.collapsed) ? '全部折叠' : '全部展开'}</button>
                      <button class="tqc-mini" type="button" data-action="add-rule">${icons.plus} 规则</button>
                    </div>
                  </div>
                  <div class="tqc-rule-list">
                    ${this.renderAutomationRuleGroups(command)}
                  </div>
                </div>
              </div>
            `}
          </div>
        `
    }

    private renderAutomationRuleGroups (command: QuickCommand): string {
        if (!command.automationRules.length) {
            return '<div class="tqc-muted">暂无规则</div>'
        }
        const lines = command.command.split(/\r?\n/)
        const groups = new Map<number, QuickAutomationRule[]>()
        command.automationRules.forEach(rule => {
            const triggerLine = Math.max(0, Number(rule.triggerLine) || 0)
            const group = groups.get(triggerLine) || []
            group.push(rule)
            groups.set(triggerLine, group)
        })
        const triggerLines = Array.from(groups.keys()).sort((left, right) => {
            if (left === 0) {
                return 1
            }
            if (right === 0) {
                return -1
            }
            return left - right
        })
        return triggerLines.map(triggerLine => {
            const line = triggerLine > 0 ? lines[triggerLine - 1] : ''
            const executable = triggerLine === 0 || Boolean(line?.trim() && !line.trim().startsWith('#'))
            const title = triggerLine === 0 ? '整个命令发送后' : `第 ${triggerLine} 行执行后`
            const preview = triggerLine > 0
                ? executable ? line.trim() : '当前行不存在或不可执行'
                : ''
            return `
              <div class="tqc-rule-group" data-rule-group-line="${triggerLine}">
                <div class="tqc-rule-group-head">
                  <span class="tqc-rule-group-title">${this.escape(title)}</span>
                  ${preview ? `<span class="tqc-rule-group-preview" data-i18n-skip title="${this.escapeAttr(preview)}">${this.escape(preview)}</span>` : ''}
                  ${executable ? `<button class="tqc-mini" type="button" data-action="${triggerLine ? 'add-line-rule' : 'add-rule'}"${triggerLine ? ` data-rule-line="${triggerLine}"` : ''}>${icons.plus} 规则</button>` : ''}
                </div>
                ${groups.get(triggerLine)?.map((rule, groupIndex) => this.renderAutomationRule(command, rule, groupIndex)).join('') || ''}
              </div>
            `
        }).join('')
    }

    private renderAutomationRule (command: QuickCommand, rule: QuickAutomationRule, index: number): string {
        const invalidWaitPattern = !isValidOutputPattern(rule.waitFor, rule.matchMode, rule.waitForLogic)
        const invalidErrorPattern = !isValidOutputPattern(rule.errorPattern, rule.matchMode, rule.errorPatternLogic)
        const ruleNumber = rule.triggerLine > 0 ? `${rule.triggerLine}-${index + 1}` : String(index + 1)
        const triggerOptions = this.getAutomationRuleTriggerOptions(command, rule)
        const triggerLineText = rule.triggerLine > 0 ? command.command.split(/\r?\n/)[rule.triggerLine - 1] : ''
        const invalidTriggerLine = rule.triggerLine > 0 && !Boolean(triggerLineText?.trim() && !triggerLineText.trim().startsWith('#'))
        return `
          <div class="tqc-rule${rule.enabled ? '' : ' tqc-rule-disabled'}" data-rule-id="${this.escapeAttr(rule.id)}">
            <div class="tqc-rule-head">
              <div class="tqc-rule-title">
                <strong>规则 ${ruleNumber}</strong>
                <label class="tqc-checkbox" data-tooltip="启用规则">
                  <input class="tqc-checkbox-control" type="checkbox" data-rule-field="enabled" aria-label="启用规则" ${rule.enabled ? 'checked' : ''}>
                  <span class="tqc-rule-enable-text">启用规则</span>
                </label>
              </div>
              <div class="tqc-rule-head-actions">
                <button class="tqc-mini tqc-rule-delete" type="button" data-action="remove-rule" data-rule-action-id="${this.escapeAttr(rule.id)}" data-tooltip="删除规则" aria-label="删除规则">${icons.trash}<span class="tqc-rule-delete-text">删除规则</span></button>
                <button class="tqc-mini" type="button" data-action="toggle-rule-collapsed" data-rule-action-id="${this.escapeAttr(rule.id)}">${icons.chevron} ${rule.collapsed ? '展开' : '折叠'}</button>
              </div>
            </div>
            ${rule.collapsed ? '' : `
            <div class="tqc-field-grid tqc-three">
              <label>
                <span class="tqc-label">规则名</span>
                <input class="tqc-input" data-rule-field="name" value="${this.escapeAttr(rule.name)}">
              </label>
              <label>
                <span class="tqc-label">触发时机</span>
                ${this.renderAutomationRuleSelect(rule, 'triggerLine', String(rule.triggerLine), triggerOptions)}
              </label>
              <label>
                <span class="tqc-label">匹配方式</span>
                ${this.renderAutomationRuleSelect(rule, 'matchMode', rule.matchMode, [
                    { value: 'literal', label: '普通文本' },
                    { value: 'regex', label: '正则表达式' },
                ])}
              </label>
            </div>
            <div class="tqc-field-grid">
              ${this.renderAutomationPatternField(rule, 'waitFor', 'waitForLogic', '成功匹配')}
              ${this.renderAutomationPatternField(rule, 'errorPattern', 'errorPatternLogic', '错误匹配')}
            </div>
            ${invalidWaitPattern || invalidErrorPattern ? '<div class="tqc-rule-warning">正则表达式无效，请修正后再执行。</div>' : ''}
            ${invalidTriggerLine ? '<div class="tqc-rule-warning">绑定的命令行不存在或不可执行，请重新选择触发时机。</div>' : ''}
            ${rule.triggerLine > 0 && this.state.executionMode !== 'line' ? '<div class="tqc-field-hint">该规则仅在逐行模式下生效。</div>' : ''}
            <div class="tqc-field-grid">
              <div>
                <span class="tqc-label">成功后执行</span>
                ${this.renderAutomationRuleAction(rule, 'match')}
              </div>
              <div>
                <span class="tqc-label">错误后执行</span>
                ${this.renderAutomationRuleAction(rule, 'error')}
              </div>
            </div>
            <div class="tqc-field-grid tqc-single">
              <div>
                <span class="tqc-label">匹配后流程</span>
                ${this.renderAutomationMatchFlow(rule)}
              </div>
            </div>
            <div class="tqc-field-grid">
              <label>
                <span class="tqc-label">超时 ms</span>
                <input class="tqc-input" type="number" data-rule-field="timeoutMs" data-tooltip="等待成功或错误输出的最长时间，单位为毫秒；到时后执行右侧的超时动作，最少 100ms。" value="${this.escapeAttr(String(rule.timeoutMs))}">
              </label>
              <div>
                <span class="tqc-label">超时后</span>
                ${this.renderAutomationRuleAction(rule, 'timeout')}
              </div>
            </div>
            <div class="tqc-field-hint">每个会话独立匹配；后续规则只读取上一条规则结束后的新输出。</div>
            `}
          </div>
        `
    }

    private getAutomationRuleTriggerOptions (
        command: QuickCommand,
        rule: QuickAutomationRule,
    ): Array<{ value: string, label: string }> {
        const options = [{ value: '0', label: '整个命令发送后' }]
        command.command.split(/\r?\n/).forEach((line, index) => {
            const text = line.trim()
            if (text && !text.startsWith('#')) {
                const preview = text.length > 42 ? `${text.slice(0, 42)}…` : text
                options.push({ value: String(index + 1), label: `第 ${index + 1} 行执行后：${preview}` })
            }
        })
        if (rule.triggerLine > 0 && !options.some(option => option.value === String(rule.triggerLine))) {
            options.push({ value: String(rule.triggerLine), label: `第 ${rule.triggerLine} 行（当前不可执行）` })
        }
        return options
    }

    private renderAutomationPatternField (
        rule: QuickAutomationRule,
        patternField: 'waitFor' | 'errorPattern',
        logicField: 'waitForLogic' | 'errorPatternLogic',
        label: string,
    ): string {
        return `
          <div>
            <span class="tqc-label">${label}</span>
            ${this.renderAutomationRuleSelect(rule, logicField, rule[logicField], [
                { value: 'single', label: '单条匹配' },
                { value: 'any', label: '任一行匹配' },
                { value: 'all', label: '全部行匹配' },
            ])}
            <textarea class="tqc-textarea tqc-rule-pattern" data-rule-field="${patternField}" rows="${rule[logicField] === 'single' ? '1' : '3'}" spellcheck="false" placeholder="${rule[logicField] === 'single' ? '输入匹配文本' : '每行一个匹配文本'}">${this.escape(rule[patternField])}</textarea>
          </div>
        `
    }

    private renderAutomationRuleAction (rule: QuickAutomationRule, outcome: 'match' | 'error' | 'timeout'): string {
        if (outcome === 'timeout') {
            return `
              ${this.renderAutomationRuleSelect(rule, 'timeoutAction', rule.timeoutAction, [
                { value: 'continue', label: '继续下一条规则' },
                { value: 'stop', label: rule.triggerLine > 0 ? '停止后续逐行执行' : '停止该会话自动化' },
                { value: 'custom', label: '发送自定义命令' },
                { value: 'command', label: '执行已有命令' },
              ])}
              ${this.renderAutomationActionDetail(rule, 'timeout', rule.timeoutAction)}
            `
        }
        const actionField = outcome === 'match' ? 'onMatchAction' : 'onErrorAction'
        const actionValue = outcome === 'match' ? rule.onMatchAction : rule.onErrorAction
        return `
          ${this.renderAutomationRuleSelect(rule, actionField, actionValue, [
            { value: 'none', label: '不执行' },
            { value: 'stop', label: rule.triggerLine > 0 ? '停止后续逐行执行' : '停止该会话自动化' },
            { value: 'custom', label: '发送自定义命令' },
            { value: 'command', label: '执行已有命令' },
          ])}
          ${this.renderAutomationActionDetail(rule, outcome, actionValue)}
        `
    }

    private renderAutomationMatchFlow (rule: QuickAutomationRule): string {
        const options = [
            { value: 'continue', label: '继续下一条规则' },
            ...(rule.triggerLine > 0
                ? [{ value: 'nextLine', label: '跳过该行剩余规则，继续下一行' }]
                : []),
            {
                value: 'stop',
                label: rule.triggerLine > 0 ? '停止后续逐行执行' : '停止该会话自动化',
            },
        ]
        return this.renderAutomationRuleSelect(rule, 'matchFlow', rule.matchFlow, options)
    }

    private renderAutomationActionDetail (
        rule: QuickAutomationRule,
        outcome: 'match' | 'error' | 'timeout',
        action: string,
    ): string {
        if (action === 'custom') {
            const field = outcome === 'match'
                ? 'onMatchCommand'
                : outcome === 'error'
                    ? 'onErrorCommand'
                    : 'onTimeoutCommand'
            const autoEnterField = outcome === 'match'
                ? 'onMatchAutoEnter'
                : outcome === 'error'
                    ? 'onErrorAutoEnter'
                    : 'onTimeoutAutoEnter'
            return `
              <div class="tqc-rule-action-detail">
                <textarea class="tqc-textarea tqc-rule-command" data-rule-field="${field}" rows="2" spellcheck="false" placeholder="输入要发送到终端的命令">${this.escape(rule[field])}</textarea>
                <label class="tqc-checkbox">
                  <input class="tqc-checkbox-control" type="checkbox" data-rule-field="${autoEnterField}" ${rule[autoEnterField] ? 'checked' : ''}>
                  <span>发送后自动回车</span>
                </label>
              </div>
            `
        }
        if (action === 'command') {
            const field = outcome === 'match'
                ? 'onMatchCommandId'
                : outcome === 'error'
                    ? 'onErrorCommandId'
                    : 'onTimeoutCommandId'
            return `
              <div class="tqc-rule-action-detail">
                ${this.renderAutomationCommandPicker(rule, field, rule[field])}
              </div>
            `
        }
        return ''
    }

    private renderAutomationCommandPicker (rule: QuickAutomationRule, field: string, selectedId: string): string {
        const menuKey = `${rule.id}:${field}`
        const open = this.automationRuleMenuKey === menuKey
        const options = this.getAutomationCommandOptions(selectedId)
        const selectedLabel = options.find(option => option.value === selectedId)?.label || '请选择命令'
        const selectedCommandExists = Boolean(selectedId && this.state.commands.some(command => command.id === selectedId))
        const selectedTitle = open ? '' : ` title="${this.escapeAttr(selectedLabel)}"`
        return `
          <div class="tqc-rule-select" data-rule-menu-key="${this.escapeAttr(menuKey)}">
            <button class="tqc-select" type="button" data-action="rule-menu-toggle" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(field)}" aria-haspopup="listbox" aria-expanded="${open}"${selectedCommandExists ? ' data-i18n-skip' : ''}${selectedTitle}>
              <span>${this.escape(selectedLabel)}</span>
              ${icons.chevron}
            </button>
            ${open ? `
              <div class="tqc-rule-menu" role="listbox">
                <input class="tqc-input tqc-rule-command-search" data-role="automation-command-search" placeholder="搜索命令">
                ${options.map(option => `
                  <button class="tqc-rule-option${option.value === selectedId ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${option.value === selectedId}" data-i18n-skip data-action="rule-option-select" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(field)}" data-rule-value="${this.escapeAttr(option.value)}" data-command-search-text="${this.escapeAttr(option.label.toLowerCase())}" title="${this.escapeAttr(option.label)}">${this.escape(option.label)}</button>
                `).join('')}
                <div class="tqc-rule-menu-empty" data-role="automation-command-empty" hidden>没有匹配的命令</div>
              </div>
            ` : ''}
          </div>
        `
    }

    private renderAutomationRuleSelect (
        rule: QuickAutomationRule,
        field: string,
        selectedValue: string,
        options: Array<{ value: string, label: string }>,
    ): string {
        const menuKey = `${rule.id}:${field}`
        const open = this.automationRuleMenuKey === menuKey
        const selectedLabel = options.find(option => option.value === selectedValue)?.label || '请选择'
        const selectedTitle = open ? '' : ` title="${this.escapeAttr(selectedLabel)}"`
        return `
          <div class="tqc-rule-select" data-rule-menu-key="${this.escapeAttr(menuKey)}">
            <button class="tqc-select" type="button" data-action="rule-menu-toggle" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(String(field))}" aria-haspopup="listbox" aria-expanded="${open}"${selectedTitle}>
              <span>${this.escape(selectedLabel)}</span>
              ${icons.chevron}
            </button>
            ${open ? `
              <div class="tqc-rule-menu" role="listbox">
                ${options.map(option => `
                  <button class="tqc-rule-option${option.value === selectedValue ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${option.value === selectedValue}" data-action="rule-option-select" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(String(field))}" data-rule-value="${this.escapeAttr(option.value)}" title="${this.escapeAttr(option.label)}">${this.escape(option.label)}</button>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `
    }

    private renderCategoryDropdown (currentCategory: string): string {
        const categories = Array.from(new Set([
            currentCategory,
            ...this.getOrderedRealCategories(),
        ].filter(category => category && !this.isSystemCategory(category))))
        return `
          <div class="tqc-category-select">
            <button class="tqc-select" type="button" data-action="category-menu-toggle">
              <span${currentCategory ? ' data-i18n-skip' : ''}>${this.escape(currentCategory ? this.getCategoryLabel(currentCategory) : '未分类')}</span>
              ${icons.chevron}
            </button>
            ${this.categoryMenuOpen ? `
              <div class="tqc-category-menu">
                ${categories.map(category => `
                  <button class="tqc-category-option${category === currentCategory ? ' tqc-active' : ''}" type="button" data-i18n-skip data-action="category-select" data-category-value="${this.escapeAttr(category)}">
                    ${this.escape(category)}
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `
    }

    private getAutomationCommandOptions (selectedId: string): Array<{ value: string, label: string }> {
        const options: Array<{ value: string, label: string }> = []
        if (selectedId && !this.state.commands.some(command => command.id === selectedId)) {
            options.push({ value: selectedId, label: `命令不存在（${selectedId}）` })
        }
        this.state.commands.forEach(command => {
            options.push({ value: command.id, label: `${command.name} · ${command.category}` })
        })
        return options
    }

    private renderFooter (selected: QuickCommand | null, targetCount: number): string {
        if (this.running && this.runState) {
            const stateText = this.runState.waitingManual
                ? '等待确认'
                : this.runState.paused ? '已暂停' : '运行中'
            return `
              <div class="tqc-run-status">
                <span class="tqc-pill">${stateText}</span>
                <span class="tqc-muted">第 ${this.runState.currentStep}/${this.runState.totalSteps} 步，源行 ${this.runState.sourceLine || '-'}</span>
                ${this.runState.waitingRuleName ? `<span class="tqc-muted">正在等待：${this.escape(this.runState.waitingRuleName)}</span>` : ''}
              </div>
              <div class="tqc-footer-row" style="margin-top:10px">
                <button class="tqc-secondary" type="button" data-action="${this.runState.paused ? 'resume' : 'pause'}">${this.runState.paused ? icons.play : icons.pause} ${this.runState.paused ? '继续' : '暂停'}</button>
                <button class="tqc-primary" type="button" data-action="stop">${icons.stop} 停止</button>
              </div>
            `
        }
        return `
          <div class="tqc-footer-row">
            <button class="tqc-secondary" type="button" data-action="copy" ${selected ? '' : 'disabled'}>${icons.copy} 复制</button>
            <button class="tqc-primary" type="button" data-action="execute" ${selected ? '' : 'disabled'}>
              <span>执行 (${targetCount || 0})</span><span class="tqc-kbd">Ctrl+Enter</span>
            </button>
          </div>
        `
    }

    private renderOverlays (selected: QuickCommand | null): string {
        if (this.importPreview) {
            return this.renderImportPreviewDialog()
        }
        if (this.pendingRuleDeleteId) {
            return this.renderDeleteRuleDialog()
        }
        if (this.addingCommand) {
            return this.renderAddCommandDialog()
        }
        if (this.movingCommandId) {
            return this.renderMoveCommandDialog()
        }
        if (this.pendingDeleteId) {
            const command = this.state.commands.find(item => item.id === this.pendingDeleteId)
            return this.renderDeleteDialog(command)
        }
        if (this.editingCommandId) {
            return this.renderEditCommandDialog()
        }
        if (this.addingCategory) {
            return this.renderAddCategoryDialog()
        }
        if (this.renamingCategory) {
            return this.renderRenameCategoryDialog()
        }
        if (this.deletingCategory) {
            return this.renderDeleteCategoryDialog()
        }
        if (this.pendingFailureMessage) {
            return this.renderFailureDialog()
        }
        if (this.pendingExecutionId && selected?.id === this.pendingExecutionId) {
            return this.renderExecutionConfirmDialog(selected)
        }
        return ''
    }

    private renderEditCommandDialog (): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="edit-command-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="编辑命令信息" data-role="confirm-dialog">
              <div class="tqc-confirm-title">编辑名称和说明</div>
              <div class="tqc-confirm-desc">修改后会立即更新左侧命令列表。</div>
              <label style="display:block;margin-top:12px">
                <span class="tqc-label">名称</span>
                <input class="tqc-input" data-role="edit-command-name" value="${this.escapeAttr(this.editCommandName)}">
              </label>
              <label style="display:block;margin-top:10px">
                <span class="tqc-label">说明</span>
                <input class="tqc-input" data-role="edit-command-description" value="${this.escapeAttr(this.editCommandDescription)}">
              </label>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="edit-command-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="edit-command-save">保存</button>
              </div>
            </div>
          </div>
        `
    }

    private renderAddCommandDialog (): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="new-command-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="新增名称和说明" data-role="confirm-dialog">
              <div class="tqc-confirm-title">新增名称和说明</div>
              <div class="tqc-confirm-desc">保存后，新命令会添加到左侧命令列表。</div>
              <label style="display:block;margin-top:12px">
                <span class="tqc-label">名称</span>
                <input class="tqc-input" data-role="new-command-name" value="${this.escapeAttr(this.newCommandName)}">
              </label>
              <label style="display:block;margin-top:10px">
                <span class="tqc-label">说明</span>
                <input class="tqc-input" data-role="new-command-description" value="${this.escapeAttr(this.newCommandDescription)}">
              </label>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="new-command-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="new-command-save">保存</button>
              </div>
            </div>
          </div>
        `
    }

    private renderMoveCommandDialog (): string {
        const command = this.state.commands.find(item => item.id === this.movingCommandId)
        const categories = this.getOrderedRealCategories()
        return `
          <div class="tqc-confirm-backdrop" data-action="move-command-cancel">
            <div class="tqc-confirm tqc-move-confirm${this.moveCategoryMenuOpen ? ' tqc-selecting' : ''}" role="dialog" aria-modal="true" aria-label="移动命令" data-role="confirm-dialog">
              <div class="tqc-confirm-title">移动命令</div>
              <div class="tqc-confirm-desc">移动命令 <strong${command?.name ? ' data-i18n-skip' : ''}>[${this.escape(command?.name || '未命名命令')}]</strong> 到指定分类。</div>
              <label>
                <span class="tqc-label">目标分类</span>
                <div class="tqc-move-select${this.moveCategoryMenuOpen ? ' tqc-open' : ''}">
                  <button class="tqc-select tqc-move-select-button" type="button" data-action="toggle-move-category-menu" aria-haspopup="listbox" aria-expanded="${this.moveCategoryMenuOpen}">
                    <span${this.moveTargetCategory ? ' data-i18n-skip' : ''}>${this.escape(this.moveTargetCategory || '请选择')}</span>${icons.chevron}
                  </button>
                  ${this.moveCategoryMenuOpen ? `<div class="tqc-move-select-menu" role="listbox">
                    ${categories.map(category => `<button class="tqc-move-select-option${category === this.moveTargetCategory ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${category === this.moveTargetCategory}" data-i18n-skip data-action="select-move-category" data-move-category="${this.escapeAttr(category)}">${this.escape(category)}</button>`).join('')}
                  </div>` : ''}
                </div>
              </label>
              <label class="tqc-checkbox tqc-move-follow">
                <input class="tqc-checkbox-control" type="checkbox" data-role="move-follow-category" ${this.state.moveNavigateAfterMove ? 'checked' : ''}>
                <span>移动后跳转到目标分类</span>
              </label>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="move-command-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="move-command-confirm" ${command && this.moveTargetCategory ? '' : 'disabled'}>移动</button>
              </div>
            </div>
          </div>
        `
    }

    private renderExecutionConfirmDialog (command: QuickCommand): string {
        const summary = this.buildExecutionSummary(command, this.getTargetTabs())
        return `
          <div class="tqc-confirm-backdrop" data-action="execute-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="确认执行" data-role="confirm-dialog">
              <div class="tqc-confirm-title">确认执行：${this.escape(command.name)}</div>
              <div class="tqc-confirm-desc">请确认目标会话和执行方式；实际确认规则以设置为准。</div>
              ${this.renderSummary(summary)}
              ${summary.reasons.length ? `<div class="tqc-card tqc-risk" style="margin-top:10px"><span class="tqc-label">风险提示</span><strong>${this.escape(summary.reasons.join('、'))}</strong></div>` : ''}
              ${summary.requiresTypedConfirm ? `
                <label style="display:block;margin-top:10px">
                  <span class="tqc-label">输入 ${this.escape(summary.requiredText)} 确认</span>
                  <input class="tqc-input" data-role="confirm-input" value="${this.escapeAttr(this.confirmInput)}">
                </label>
              ` : ''}
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="execute-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="execute-confirm">确认发送</button>
              </div>
            </div>
          </div>
        `
    }

    private renderImportPreviewDialog (): string {
        const preview = this.importPreview
        if (!preview) {
            return ''
        }
        const fileConflicts = preview.conflicts.filter(conflict => conflict.scope === 'file').length
        const existingConflicts = preview.conflicts.length - fileConflicts
        const visibleConflicts = preview.conflicts.slice(0, 5)
        const hiddenConflictCount = preview.conflicts.length - visibleConflicts.length
        return `
          <div class="tqc-confirm-backdrop" data-action="import-cancel">
            <div class="tqc-confirm tqc-import-preview" role="dialog" aria-modal="true" aria-label="导入预览" data-role="confirm-dialog">
              <div class="tqc-confirm-title">导入预览</div>
              <div class="tqc-import-version">
                <span>命令库版本</span>
                <strong>v${preview.sourceVersion}</strong>
              </div>
              <div class="tqc-import-stats">
                <div class="tqc-import-stat"><span>新增</span><strong>${preview.added.length}</strong></div>
                <div class="tqc-import-stat"><span>覆盖</span><strong>${preview.overwritten.length}</strong></div>
                <div class="tqc-import-stat${existingConflicts ? ' tqc-import-stat-warning' : ''}"><span>现有库冲突</span><strong>${existingConflicts}</strong></div>
                <div class="tqc-import-stat${fileConflicts ? ' tqc-import-stat-warning' : ''}"><span>文件内部冲突</span><strong>${fileConflicts}</strong></div>
              </div>
              <div class="tqc-import-rules">
                <strong class="tqc-import-section-title">导入规则</strong>
                <span>合并会跳过全部冲突；替换会忽略与现有库的冲突，但跳过文件内部冲突。</span>
              </div>
              ${preview.conflicts.length ? `
                <div class="tqc-import-conflicts">
                  <div class="tqc-import-conflicts-head">
                    <strong>冲突详情</strong>
                    <span>${preview.conflicts.length}</span>
                  </div>
                  <div class="tqc-import-conflict-list">
                    ${visibleConflicts.map(conflict => `
                      <div class="tqc-import-conflict-row">
                        <span class="tqc-import-conflict-source">${conflict.scope === 'file' ? '文件' : '现有库'}</span>
                        <div class="tqc-import-conflict-copy">
                          <strong data-i18n-skip>${this.escape(conflict.command.name)}</strong>
                          <span>${this.escape(conflict.reason)}</span>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                  ${hiddenConflictCount ? `<div class="tqc-import-conflict-more">另有 ${hiddenConflictCount} 条冲突未显示。</div>` : ''}
                </div>
              ` : ''}
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="import-cancel">取消</button>
                <button class="tqc-secondary" type="button" data-action="import-replace">替换导入</button>
                <button class="tqc-primary" type="button" data-action="import-merge">合并导入</button>
              </div>
            </div>
          </div>
        `
    }

    private renderDeleteRuleDialog (): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="rule-delete-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="删除规则" data-role="confirm-dialog">
              <div class="tqc-confirm-title">删除规则</div>
              <div class="tqc-confirm-desc">确认删除该输出触发器规则？此操作不可撤销。</div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="rule-delete-cancel">取消</button>
                <button class="tqc-primary tqc-danger-action" type="button" data-action="rule-delete-confirm">删除</button>
              </div>
            </div>
          </div>
        `
    }

    private renderDeleteDialog (command: QuickCommand | undefined): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="delete-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="删除命令" data-role="confirm-dialog">
              <div class="tqc-confirm-title">删除命令</div>
              <div class="tqc-confirm-desc">删除命令 <strong${command?.name ? ' data-i18n-skip' : ''}>[${this.escape(command?.name || '未命名命令')}]</strong>？</div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="delete-cancel">取消</button>
                <button class="tqc-primary tqc-danger-action" type="button" data-action="delete-confirm">删除</button>
              </div>
            </div>
          </div>
        `
    }

    private renderAddCategoryDialog (): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="category-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="添加分类" data-role="confirm-dialog">
              <div class="tqc-confirm-title">添加分类</div>
              <div class="tqc-confirm-desc">新分类会显示在分类栏里，可以先建空分类，再向其中添加命令。</div>
              <label>
                <span class="tqc-label">分类名称</span>
                <input class="tqc-input" data-role="category-input" value="${this.escapeAttr(this.categoryInput)}" autofocus>
              </label>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="category-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="category-confirm">添加</button>
              </div>
            </div>
          </div>
        `
    }

    private renderRenameCategoryDialog (): string {
        return `
          <div class="tqc-confirm-backdrop" data-action="category-rename-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="重命名分类" data-role="confirm-dialog">
              <div class="tqc-confirm-title">重命名分类</div>
              <div class="tqc-confirm-desc">将“${this.escape(this.state.selectedCategory)}”修改为新的分类名称。</div>
              <label>
                <span class="tqc-label">分类名称</span>
                <input class="tqc-input" data-role="category-input" value="${this.escapeAttr(this.categoryInput)}" autofocus>
              </label>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="category-rename-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="category-rename-confirm">保存</button>
              </div>
            </div>
          </div>
        `
    }

    private renderDeleteCategoryDialog (): string {
        const category = this.state.selectedCategory
        const count = this.state.commands.filter(command => command.category === category).length
        return `
          <div class="tqc-confirm-backdrop" data-action="category-delete-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="删除分类" data-role="confirm-dialog">
              <div class="tqc-confirm-title">删除分类：<span data-i18n-skip>${this.escape(category)}</span></div>
              <div class="tqc-confirm-desc">
                ${count
                    ? `该分类包含 <strong>[${count} <span>条命令</span>]</strong>。确认后将同时删除这些命令，此操作无法撤销。`
                    : '该分类中没有命令，确认删除该分类？'}
              </div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="category-delete-cancel">取消</button>
                <button class="tqc-primary tqc-danger-action" type="button" data-action="category-delete-confirm">${count ? '删除分类和命令' : '删除分类'}</button>
              </div>
            </div>
          </div>
        `
    }

    private renderFailureDialog (): string {
        return `
          <div class="tqc-confirm-backdrop">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="失败处理" data-role="confirm-dialog">
              <div class="tqc-confirm-title">逐行执行暂停</div>
              <div class="tqc-confirm-desc">${this.escape(this.pendingFailureMessage)}</div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="failure-stop">停止</button>
                <button class="tqc-primary" type="button" data-action="failure-continue">继续</button>
              </div>
            </div>
          </div>
        `
    }

    private renderSummary (summary: ExecutionSummary): string {
        const targetText = summary.targetCount ? summary.targetNames : ['没有可用会话']
        return `
          <div class="tqc-summary">
            <div class="tqc-summary-row">
              <span>模式</span>
              <strong>${this.escape(summary.modeLabel)}</strong>
            </div>
            <div class="tqc-summary-row">
              <span>目标</span>
              <div class="tqc-target-list">
                ${targetText.slice(0, 4).map(name => `<span class="tqc-pill" title="${this.escapeAttr(name)}">${this.escape(name)}</span>`).join('')}
                ${targetText.length > 4 ? `<span class="tqc-pill">+${targetText.length - 4}</span>` : ''}
              </div>
            </div>
            <div class="tqc-summary-row">
              <span>内容</span>
              <span>${summary.lineCount} 行，${summary.autoEnter ? '发送后回车' : '不自动回车'}</span>
            </div>
          </div>
        `
    }

    private renderEmptyDetail (): string {
        return `
          <div class="tqc-card">
            <div class="tqc-empty">新建一条命令，或者调整搜索条件。</div>
          </div>
        `
    }

    private renderModeButton (mode: ExecutionMode, title: string, subtitle: string): string {
        return `
          <button class="tqc-mode${this.state.executionMode === mode ? ' tqc-active' : ''}" type="button" data-mode="${mode}">
            <strong>${this.escape(title)}</strong>
            <span>${this.escape(subtitle)}</span>
          </button>
        `
    }

    private bindEvents (): void {
        if (!this.root) {
            return
        }

        this.root.querySelectorAll<HTMLElement>('[data-category]').forEach(element => {
            element.addEventListener('click', () => {
                this.categoryOverflowOpen = false
                this.updateConfig({
                    selectedCategory: element.dataset.category || '全部',
                })
            })
            element.addEventListener('dragstart', event => {
                const category = element.dataset.category || ''
                if (!this.canDragCategory(category)) {
                    event.preventDefault()
                    return
                }
                this.draggedCategory = category
                event.dataTransfer?.setData('text/plain', category)
            })
            element.addEventListener('dragover', event => {
                if (this.draggedCategory && this.canDragCategory(element.dataset.category || '')) {
                    event.preventDefault()
                    this.updateCategoryDropIndicator(element, event)
                }
            })
            element.addEventListener('dragleave', () => {
                this.clearCategoryDropIndicators(element)
            })
            element.addEventListener('drop', event => {
                event.preventDefault()
                const target = element.dataset.category || ''
                if (this.draggedCategory && target) {
                    this.reorderCategory(this.draggedCategory, target, this.categoryDropPlacement)
                }
                this.clearCategoryDropIndicators()
            })
            element.addEventListener('dragend', () => {
                this.draggedCategory = null
                this.clearCategoryDropIndicators()
            })
        })

        const categoryOverflowSearch = this.root.querySelector<HTMLInputElement>('[data-role="category-overflow-search"]')
        categoryOverflowSearch?.addEventListener('input', () => {
            const filter = categoryOverflowSearch.value.trim().toLowerCase()
            this.root?.querySelectorAll<HTMLElement>('[data-category-overflow-option]').forEach(option => {
                const category = (option.dataset.category || '').toLowerCase()
                const visibleInBar = option.dataset.categoryVisible === 'true'
                option.hidden = visibleInBar || Boolean(filter && !category.includes(filter))
            })
        })

        this.root.querySelectorAll<HTMLInputElement>('[data-role="automation-command-search"]').forEach(input => {
            input.addEventListener('click', event => event.stopPropagation())
            input.addEventListener('input', () => {
                const menu = input.closest<HTMLElement>('.tqc-rule-menu')
                const filter = input.value.trim().toLowerCase()
                let visibleCount = 0
                menu?.querySelectorAll<HTMLElement>('[data-command-search-text]').forEach(option => {
                    const visible = !filter || (option.dataset.commandSearchText || '').includes(filter)
                    option.hidden = !visible
                    if (visible) {
                        visibleCount++
                    }
                })
                const empty = menu?.querySelector<HTMLElement>('[data-role="automation-command-empty"]')
                if (empty) {
                    empty.hidden = visibleCount > 0
                }
            })
        })
        if (this.root.querySelector('[data-role="automation-command-search"]')) {
            window.requestAnimationFrame(() => {
                this.root?.querySelector<HTMLInputElement>('[data-role="automation-command-search"]')?.focus()
            })
        }

        this.root.querySelectorAll<HTMLElement>('[data-mode]').forEach(element => {
            element.addEventListener('click', () => {
                const mode = element.dataset.mode as ExecutionMode
                this.updateConfig({
                    executionMode: mode,
                })
            })
        })

        const search = this.root.querySelector<HTMLInputElement>('[data-role="search"]')
        search?.addEventListener('compositionstart', () => {
            this.composingSearch = true
        })
        search?.addEventListener('compositionend', () => {
            this.composingSearch = false
            this.updateSearch(search)
        })
        search?.addEventListener('input', () => {
            if (!this.composingSearch) {
                this.updateSearch(search)
            }
        })

        const confirmInput = this.root.querySelector<HTMLInputElement>('[data-role="confirm-input"]')
        confirmInput?.addEventListener('input', () => {
            this.confirmInput = confirmInput.value
        })
        if (confirmInput) {
            window.requestAnimationFrame(() => confirmInput.focus())
        }

        const editCommandName = this.root.querySelector<HTMLInputElement>('[data-role="edit-command-name"]')
        const editCommandDescription = this.root.querySelector<HTMLInputElement>('[data-role="edit-command-description"]')
        editCommandName?.addEventListener('input', () => {
            this.editCommandName = editCommandName.value
        })
        editCommandDescription?.addEventListener('input', () => {
            this.editCommandDescription = editCommandDescription.value
        })
        const handleEditCommandKey = (event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault()
                this.saveCommandListEdit()
            } else if (event.key === 'Escape') {
                event.preventDefault()
                this.closeCommandListEdit()
            }
        }
        editCommandName?.addEventListener('keydown', handleEditCommandKey)
        editCommandDescription?.addEventListener('keydown', handleEditCommandKey)
        if (editCommandName) {
            window.requestAnimationFrame(() => {
                editCommandName.focus()
                editCommandName.select()
            })
        }

        const newCommandName = this.root.querySelector<HTMLInputElement>('[data-role="new-command-name"]')
        const newCommandDescription = this.root.querySelector<HTMLInputElement>('[data-role="new-command-description"]')
        newCommandName?.addEventListener('input', () => {
            this.newCommandName = newCommandName.value
            this.newCommandNameEdited = true
        })
        newCommandDescription?.addEventListener('input', () => {
            this.newCommandDescription = newCommandDescription.value
        })
        const handleNewCommandKey = (event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault()
                this.createCommand()
            } else if (event.key === 'Escape') {
                event.preventDefault()
                this.closeAddCommand()
            }
        }
        newCommandName?.addEventListener('keydown', handleNewCommandKey)
        newCommandDescription?.addEventListener('keydown', handleNewCommandKey)
        if (newCommandName) {
            window.requestAnimationFrame(() => {
                newCommandName.focus()
                newCommandName.select()
            })
        }

        const moveFollowCategory = this.root.querySelector<HTMLInputElement>('[data-role="move-follow-category"]')
        moveFollowCategory?.addEventListener('change', () => {
            this.updateConfig({ moveNavigateAfterMove: moveFollowCategory.checked })
        })

        const categoryInput = this.root.querySelector<HTMLInputElement>('[data-role="category-input"]')
        categoryInput?.addEventListener('input', () => {
            this.categoryInput = categoryInput.value
        })
        categoryInput?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault()
                this.categoryInput = categoryInput.value
                if (this.renamingCategory) {
                    this.confirmRenameCategory()
                } else {
                    this.confirmAddCategory()
                }
            }
        })
        if (categoryInput) {
            window.requestAnimationFrame(() => {
                if (!this.root?.contains(categoryInput)) { return }
                categoryInput.focus()
                if (this.renamingCategory) {
                    const cursor = categoryInput.value.length
                    categoryInput.setSelectionRange(cursor, cursor)
                }
            })
        }

        const importFile = this.root.querySelector<HTMLInputElement>('[data-role="import-file"]')
        importFile?.addEventListener('change', () => {
            const file = importFile.files?.[0]
            if (file) {
                void this.importCommandsFromFile(file)
            }
            importFile.value = ''
        })

        this.root.querySelectorAll<HTMLInputElement>('[data-role="shortcut-input"]').forEach(element => {
            const pressedKeys = new Map<string, string>()
            const defaultHint = this.i18n.text('设置后，在终端中按下快捷键即可执行命令。')
            const hint = element.closest('label')?.querySelector<HTMLElement>('[data-role="shortcut-hint"]') || null
            let originalShortcut = element.value
            let shortcutCandidate = ''
            let shortcutAttempted = false
            let primaryKeyId = ''
            let recording = false
            let captureFailureActive = false

            const eventId = (event: KeyboardEvent): string => event.code || event.key
            const isModifier = (key: string): boolean => ['Control', 'Alt', 'Shift', 'Meta'].includes(key)
            const previewKey = (key: string): string => ({
                Control: 'Ctrl',
                Alt: 'Alt',
                Shift: 'Shift',
                Meta: 'Meta',
            } as Record<string, string>)[key] || normalizeShortcutKey(key)
            const currentPressedKeys = (): string[] => {
                const order: Record<string, number> = { Ctrl: 0, Alt: 1, Shift: 2, Meta: 3 }
                return Array.from(new Set(pressedKeys.values()))
                    .sort((left, right) => (order[left] ?? 4) - (order[right] ?? 4))
            }
            const setHint = (message: string, error = false): void => {
                if (!hint) { return }
                hint.textContent = message
                hint.classList.toggle('tqc-field-hint-error', error)
            }
            const resetPressedKeys = (): void => {
                pressedKeys.clear()
                shortcutCandidate = ''
                shortcutAttempted = false
                primaryKeyId = ''
            }
            const showWaitingState = (): void => {
                element.value = ''
                element.placeholder = this.i18n.text('等待按键…')
                setHint(this.i18n.text('按下组合键，松开主键完成录入。'))
            }
            const showCaptureFailure = (reason: string): void => {
                captureFailureActive = true
                element.classList.add('tqc-shortcut-error')
                setHint(`${this.i18n.text('录入失败')}：${this.i18n.text(reason)}`, true)
            }
            const beginRecording = (): void => {
                originalShortcut = this.getSelectedCommand()?.shortcut || element.value
                recording = true
                captureFailureActive = false
                resetPressedKeys()
                element.classList.remove('tqc-shortcut-captured', 'tqc-shortcut-error')
                element.classList.add('tqc-shortcut-recording')
                showWaitingState()
            }
            const restoreOriginalShortcut = (): void => {
                resetPressedKeys()
                recording = false
                captureFailureActive = false
                element.value = originalShortcut
                element.placeholder = this.i18n.text('点击录入')
                element.classList.remove('tqc-shortcut-recording', 'tqc-shortcut-error')
                setHint(defaultHint)
            }

            element.addEventListener('focus', beginRecording)
            element.addEventListener('keydown', event => {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (!recording) { beginRecording() }
                if (event.repeat || event.isComposing) { return }
                captureFailureActive = false
                element.classList.remove('tqc-shortcut-error')
                if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Escape') {
                    resetPressedKeys()
                    recording = false
                    originalShortcut = ''
                    element.value = ''
                    element.placeholder = this.i18n.text('点击录入')
                    element.classList.remove('tqc-shortcut-recording', 'tqc-shortcut-error')
                    setHint(defaultHint)
                    this.updateSelectedField(element)
                    element.blur()
                    return
                }
                const keyId = eventId(event)
                if (pressedKeys.has(keyId)) { return }
                const key = previewKey(event.key)
                if (!key) { return }
                pressedKeys.set(keyId, key)
                element.value = currentPressedKeys().join('+')
                setHint(`${this.i18n.text('正在按下')}：${element.value}`)
                if (!isModifier(event.key)) {
                    if (shortcutAttempted) {
                        shortcutCandidate = ''
                    } else {
                        shortcutAttempted = true
                        primaryKeyId = keyId
                        shortcutCandidate = shortcutFromKeyboardEvent(event)
                    }
                }
            })
            element.addEventListener('keyup', event => {
                if (!recording || event.isComposing) { return }
                event.preventDefault()
                event.stopImmediatePropagation()
                if (captureFailureActive) { return }
                const keyId = eventId(event)
                const primaryKeyReleased = shortcutAttempted && keyId === primaryKeyId
                if (!pressedKeys.delete(keyId)) {
                    const key = previewKey(event.key)
                    const fallback = Array.from(pressedKeys.entries()).find(([, value]) => value === key)
                    if (fallback) { pressedKeys.delete(fallback[0]) }
                }
                if (!primaryKeyReleased) {
                    const keys = currentPressedKeys()
                    if (keys.length) {
                        element.value = keys.join('+')
                        setHint(`${this.i18n.text('正在按下')}：${element.value}`)
                    } else if (!shortcutAttempted) {
                        resetPressedKeys()
                        showWaitingState()
                    }
                    return
                }

                const shortcut = shortcutCandidate
                resetPressedKeys()
                if (!shortcut || !isValidShortcut(shortcut)) {
                    showWaitingState()
                    showCaptureFailure('快捷键需包含 Ctrl、Alt 或 Meta；也可以直接使用功能键。')
                    return
                }

                const selected = this.getSelectedCommand()
                const conflict = selected ? this.findShortcutConflict(shortcut, selected.id) : null
                if (conflict) {
                    showWaitingState()
                    showCaptureFailure(conflict.kind === 'drawer'
                        ? `快捷键与抽屉操作“${conflict.name}”冲突。`
                        : conflict.kind === 'plugin'
                            ? `快捷键与插件操作“${conflict.name}”冲突。`
                            : conflict.kind === 'tabby'
                                ? `快捷键与 Tabby 操作“${conflict.name}”冲突。`
                                : `快捷键已被“${conflict.name}”使用。`)
                    return
                }

                element.value = shortcut
                this.updateSelectedField(element)
                const savedShortcut = normalizeShortcut(this.getSelectedCommand()?.shortcut || '')
                if (savedShortcut !== normalizeShortcut(shortcut)) { return }
                originalShortcut = savedShortcut
                recording = false
                element.placeholder = this.i18n.text('点击录入')
                element.classList.remove('tqc-shortcut-recording', 'tqc-shortcut-error')
                element.classList.add('tqc-shortcut-captured')
                setHint(defaultHint)
                element.blur()
                window.setTimeout(() => element.classList.remove('tqc-shortcut-captured'), 900)
            })
            element.addEventListener('blur', () => {
                if (recording) { restoreOriginalShortcut() }
            })
        })

        this.bindLineSettings(this.root)
        this.bindNumberInputWheel(this.root)

        this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-rule-field]').forEach(element => {
            element.addEventListener('change', () => this.updateAutomationRule(element))
        })

        const autoEnter = this.root.querySelector<HTMLInputElement>('[data-role="auto-enter"]')
        const commandEditor = this.root.querySelector<HTMLTextAreaElement>('[data-role="command-editor"]')
        const commandLineEndings = this.root.querySelector<HTMLElement>('[data-role="command-line-endings"]')
        const syncCommandLineEndingsScroll = () => {
            if (commandEditor && commandLineEndings) {
                commandLineEndings.style.transform = `translateY(-${commandEditor.scrollTop}px)`
            }
        }
        const refreshCommandLineEndings = () => {
            const shell = commandEditor?.closest<HTMLElement>('.tqc-command-editor-shell')
            if (!commandEditor || !commandLineEndings || !shell) {
                return
            }
            let measure = shell.querySelector<HTMLElement>('.tqc-command-line-measure')
            if (!measure) {
                measure = document.createElement('div')
                measure.className = 'tqc-command-line-measure'
                shell.appendChild(measure)
            }
            const style = window.getComputedStyle(commandEditor)
            const contentWidth = commandEditor.clientWidth -
                (Number.parseFloat(style.paddingLeft) || 0) -
                (Number.parseFloat(style.paddingRight) || 0)
            const lineHeight = Number.parseFloat(style.lineHeight) || 19
            measure.style.width = `${Math.max(contentWidth, 1)}px`
            measure.style.font = style.font
            measure.style.letterSpacing = style.letterSpacing
            measure.style.lineHeight = style.lineHeight
            measure.style.tabSize = style.tabSize

            const lines = commandEditor.value.split(/\r?\n/)
            const markers: string[] = []
            let totalVisualLineCount = 0
            lines.forEach((line, index) => {
                measure!.textContent = line || '\u200b'
                const visualLineCount = Math.max(1, Math.round(measure!.scrollHeight / lineHeight))
                totalVisualLineCount += visualLineCount
                for (let visualLine = 1; visualLine < visualLineCount; visualLine++) {
                    markers.push('<span class="tqc-command-line-ending">↓</span>')
                }
                const enter = index < lines.length - 1 || (autoEnter?.checked ?? false)
                markers.push(`<span class="tqc-command-line-ending${enter ? '' : ' tqc-no-enter'}">${enter ? '↵' : '×↵'}</span>`)
            })
            const commandHeight = `${Math.max(totalVisualLineCount, 1) * 1.48}em`
            if (commandEditor.style.getPropertyValue('--tqc-command-height') !== commandHeight) {
                commandEditor.style.setProperty('--tqc-command-height', commandHeight)
            }
            commandLineEndings.innerHTML = markers.join('')
            syncCommandLineEndingsScroll()
        }
        commandEditor?.addEventListener('input', () => {
            const lineCount = Math.max(commandEditor.value.split(/\r?\n/).length, 1)
            commandEditor.style.setProperty('--tqc-command-height', `${lineCount * 1.48}em`)
            const lineCountElement = this.root?.querySelector<HTMLElement>('[data-role="command-line-count"]')
            if (lineCountElement) {
                lineCountElement.textContent = `${lineCount} 行`
            }
            refreshCommandLineEndings()
            this.updateSelectedCommand({ command: normalizeCommandText(commandEditor.value) }, false, false, false)
            this.refreshLineSettings(commandEditor.value)
        })
        commandEditor?.addEventListener('scroll', syncCommandLineEndingsScroll)
        commandEditor?.addEventListener('change', () => this.updateSelectedField(commandEditor, false))
        if (commandEditor) {
            window.requestAnimationFrame(refreshCommandLineEndings)
            const editorResizeObserver = new ResizeObserver(() => {
                if (!commandEditor.isConnected) {
                    editorResizeObserver.disconnect()
                    return
                }
                refreshCommandLineEndings()
            })
            editorResizeObserver.observe(commandEditor)
        }

        autoEnter?.addEventListener('change', () => {
            this.updateSelectedCommand({ autoEnter: autoEnter.checked }, false, false)
            refreshCommandLineEndings()
        })

        this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]').forEach(element => {
            if (element === commandEditor) {
                return
            }
            element.addEventListener('change', () => this.updateSelectedField(element))
        })

        this.bindTooltips()
        this.bindResizeHandle()
        this.bindResponsiveRuleHeads()
    }

    private bindResponsiveRuleHeads (): void {
        this.ruleHeadResizeObserver?.disconnect()
        this.ruleHeadResizeObserver = undefined
        const heads = Array.from(this.root?.querySelectorAll<HTMLElement>('.tqc-rule-head') || [])
        if (!heads.length) {
            return
        }

        const update = (head: HTMLElement) => {
            head.classList.remove('tqc-rule-head-compact')
            const title = head.querySelector<HTMLElement>('.tqc-rule-title')
            const actions = head.querySelector<HTMLElement>('.tqc-rule-head-actions')
            if (!title || !actions) {
                return
            }
            const style = window.getComputedStyle(head)
            const gap = Number.parseFloat(style.columnGap || style.gap) || 0
            const requiredWidth = title.scrollWidth + actions.scrollWidth + gap
            const safetySpace = 12
            head.classList.toggle('tqc-rule-head-compact', requiredWidth + safetySpace > head.clientWidth)
        }

        heads.forEach(update)
        window.requestAnimationFrame(() => heads.forEach(update))
        if (typeof ResizeObserver !== 'undefined') {
            this.ruleHeadResizeObserver = new ResizeObserver(entries => {
                entries.forEach(entry => update(entry.target as HTMLElement))
            })
            heads.forEach(head => this.ruleHeadResizeObserver?.observe(head))
        }
    }

    private bindTooltips (scope: ParentNode = this.root as ParentNode): void {
        const tooltip = this.root?.querySelector<HTMLElement>('[data-role="tooltip"]')
        if (!tooltip || !this.root) {
            return
        }

        scope.querySelectorAll<HTMLElement>('[title], [data-tooltip]').forEach(element => {
            const text = element.dataset.tooltip || element.getAttribute('title') || ''
            if (!text) {
                return
            }
            element.dataset.tooltip = text
            element.removeAttribute('title')
            if (!element.hasAttribute('aria-label')) {
                element.setAttribute('aria-label', text)
            }
            const show = () => this.showTooltip(tooltip, element, element.dataset.tooltip || text)
            const hide = () => this.hideTooltip(tooltip)
            element.addEventListener('mouseenter', show)
            element.addEventListener('mouseleave', hide)
            element.addEventListener('focus', show)
            element.addEventListener('blur', hide)
            element.addEventListener('mousedown', hide)
        })
    }

    private showTooltip (tooltip: HTMLElement, anchor: HTMLElement, text: string): void {
        tooltip.textContent = text
        const commandName = anchor.dataset.tooltipCommandName
        tooltip.classList.toggle('tqc-tooltip-command', commandName !== undefined)
        if (commandName !== undefined) {
            const label = document.createElement('span')
            label.className = 'tqc-tooltip-action-label'
            label.textContent = text
            const name = document.createElement('strong')
            name.className = 'tqc-tooltip-command-name'
            name.setAttribute('data-i18n-skip', '')
            name.textContent = commandName
            tooltip.replaceChildren(label, name)
        }
        tooltip.classList.remove('tqc-tooltip-above')
        tooltip.classList.add('tqc-tooltip-visible')
        tooltip.style.left = '0px'
        tooltip.style.top = '0px'

        const anchorRect = anchor.getBoundingClientRect()
        const tooltipRect = tooltip.getBoundingClientRect()
        const margin = 10
        const gap = 9
        const idealLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2
        const left = Math.max(margin, Math.min(window.innerWidth - tooltipRect.width - margin, idealLeft))
        const showAbove = anchorRect.bottom + gap + tooltipRect.height > window.innerHeight - margin
        const top = showAbove
            ? Math.max(margin, anchorRect.top - tooltipRect.height - gap)
            : anchorRect.bottom + gap
        const arrowLeft = Math.max(10, Math.min(tooltipRect.width - 10, anchorRect.left + anchorRect.width / 2 - left))

        tooltip.classList.toggle('tqc-tooltip-above', showAbove)
        tooltip.style.left = `${left}px`
        tooltip.style.top = `${top}px`
        tooltip.style.setProperty('--tqc-tooltip-arrow', `${arrowLeft}px`)
    }

    private hideTooltip (tooltip: HTMLElement): void {
        tooltip.classList.remove('tqc-tooltip-visible')
    }

    private restoreScroll (detailScrollTop: number, listScrollTop: number): void {
        window.requestAnimationFrame(() => {
            const detail = this.root?.querySelector<HTMLElement>('.tqc-detail')
            const list = this.root?.querySelector<HTMLElement>('.tqc-list')
            if (detail) {
                detail.scrollTop = detailScrollTop
            }
            if (list) {
                list.scrollTop = listScrollTop
            }
        })
    }

    private withPreservedScroll (callback: () => void): void {
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const detailScrollTop = this.root?.querySelector<HTMLElement>('.tqc-detail')?.scrollTop || 0
        const listScrollTop = this.root?.querySelector<HTMLElement>('.tqc-list')?.scrollTop || 0
        activeElement?.blur()
        callback()
        this.restoreScroll(detailScrollTop, listScrollTop)
    }

    private scrollToPendingAutomationRule (): void {
        const ruleId = this.pendingAutomationRuleScrollId
        if (!ruleId) {
            return
        }
        this.pendingAutomationRuleScrollId = null
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                const rule = Array.from(this.root?.querySelectorAll<HTMLElement>('[data-rule-id]') || [])
                    .find(element => element.dataset.ruleId === ruleId)
                rule?.scrollIntoView({ block: 'nearest' })
            })
        })
    }

    private layoutCategories (): void {
        if (this.filter.trim()) {
            return
        }
        const scroll = this.root?.querySelector<HTMLElement>('.tqc-category-scroll')
        const toggle = this.root?.querySelector<HTMLElement>('[data-role="category-overflow-toggle"]')
        if (!scroll || !toggle) {
            return
        }

        const chips = Array.from(scroll.querySelectorAll<HTMLElement>('[data-category]'))
        const label = toggle.querySelector<HTMLElement>('[data-role="category-overflow-label"]')
        const measurements = chips.map(chip => ({
            category: chip.dataset.category || '',
            width: chip.getBoundingClientRect().width,
        }))
        const getVisibleCategories = (): Set<string> => {
            const style = window.getComputedStyle(scroll)
            const available = Math.max(0, scroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0))
            const gap = parseFloat(style.columnGap || style.gap) || 8
            return new Set(fitCategoryPrefix(measurements, available, gap))
        }

        toggle.classList.remove('tqc-category-overflow-selected')
        const overflowAction = this.i18n.text(this.categoryOverflowOpen ? '收起更多分类' : '更多分类')
        if (this.categoryOverflowOpen) {
            delete toggle.dataset.tooltip
        } else {
            toggle.dataset.tooltip = overflowAction
        }
        toggle.setAttribute('aria-label', overflowAction)
        if (label) {
            label.hidden = true
            label.textContent = ''
        }

        let visible = getVisibleCategories()
        if (measurements.some(item => item.category === this.state.selectedCategory) && !visible.has(this.state.selectedCategory)) {
            const selectedLabel = this.getCategoryLabel(this.state.selectedCategory)
            const proxyDescription = `${selectedLabel} · ${overflowAction}`
            toggle.classList.add('tqc-category-overflow-selected')
            if (!this.categoryOverflowOpen) {
                toggle.dataset.tooltip = proxyDescription
            }
            toggle.setAttribute('aria-label', proxyDescription)
            if (label) {
                label.hidden = false
                label.textContent = selectedLabel
            }
            // The labelled proxy uses more horizontal space, so measure the stable
            // prefix again after the grid has resized around it.
            visible = getVisibleCategories()
        }

        chips.forEach(chip => {
            chip.hidden = !visible.has(chip.dataset.category || '')
        })

        const overflowCategories = chips
            .map(chip => chip.dataset.category || '')
            .filter(category => !visible.has(category))
        toggle.hidden = overflowCategories.length === 0

        this.root?.querySelectorAll<HTMLElement>('[data-category-overflow-option]').forEach(option => {
            const visibleInBar = visible.has(option.dataset.category || '')
            option.dataset.categoryVisible = String(visibleInBar)
            option.hidden = visibleInBar
        })
        const search = this.root?.querySelector<HTMLInputElement>('[data-role="category-overflow-search"]')
        if (search) {
            search.hidden = overflowCategories.length <= 10
        }

        if (!overflowCategories.length && this.categoryOverflowOpen) {
            this.closeCategoryOverflowMenu()
        }
    }

    private focusSelectedOverflowCategory (): void {
        if (!this.categoryOverflowOpen) {
            return
        }
        window.requestAnimationFrame(() => {
            if (!this.categoryOverflowOpen) { return }
            const options = Array.from(this.root?.querySelectorAll<HTMLElement>('[data-category-overflow-option]') || [])
                .filter(option => !option.hidden)
            const target = options.find(option => option.dataset.category === this.state.selectedCategory) || options[0]
            target?.focus()
            target?.scrollIntoView({ block: 'nearest' })
        })
    }

    private updateCategoryDropIndicator (element: HTMLElement, event: DragEvent): void {
        const rect = element.getBoundingClientRect()
        const isOverflowOption = element.hasAttribute('data-category-overflow-option')
        this.categoryDropPlacement = (isOverflowOption
            ? event.clientY > rect.top + rect.height / 2
            : event.clientX > rect.left + rect.width / 2) ? 'after' : 'before'
        this.clearCategoryDropIndicators()
        element.classList.add(this.categoryDropPlacement === 'after' ? 'tqc-drop-after' : 'tqc-drop-before')
    }

    private clearCategoryDropIndicators (element?: HTMLElement): void {
        const targets = element ? [element] : Array.from(this.root?.querySelectorAll<HTMLElement>('[data-category]') || [])
        targets.forEach(target => {
            target.classList.remove('tqc-drop-before', 'tqc-drop-after')
        })
    }

    private bindResizeHandle (): void {
        const handle = this.root?.querySelector<HTMLElement>('[data-role="resize-handle"]')
        handle?.addEventListener('mousedown', event => {
            event.preventDefault()
            const startX = event.clientX
            const startWidth = this.clampWidth(this.state.drawerWidth)
            this.resizeMove = moveEvent => {
                const nextWidth = this.clampWidth(startWidth + (startX - moveEvent.clientX))
                this.updateDrawerWidthLive(nextWidth)
            }
            this.resizeEnd = () => {
                if (this.resizeMove) {
                    document.removeEventListener('mousemove', this.resizeMove)
                }
                if (this.resizeEnd) {
                    document.removeEventListener('mouseup', this.resizeEnd)
                }
                this.persistPluginConfig()
                this.resizeMove = undefined
                this.resizeEnd = undefined
            }
            document.addEventListener('mousemove', this.resizeMove)
            document.addEventListener('mouseup', this.resizeEnd)
        })
    }

    private async handleAction (
        action: string,
        element?: HTMLElement,
        focusAreaBeforeAction: DrawerFocusArea = this.focusArea,
    ): Promise<void> {
        switch (action) {
            case 'close':
                this.close()
                return
            case 'clear-search':
                this.clearSearchAndRestoreContext()
                return
            case 'collapse':
                this.close()
                return
            case 'settings':
                this.openSettings()
                return
            case 'update-settings':
                this.openUpdateSettings()
                return
            case 'import':
                this.root?.querySelector<HTMLInputElement>('[data-role="import-file"]')?.click()
                return
            case 'export':
                await this.exportCommands()
                return
            case 'toggle-library-menu':
                this.libraryMenuOpen = !this.libraryMenuOpen
                this.categoryActionsOpen = false
                this.categoryOverflowOpen = false
                this.categoryMenuOpen = false
                this.targetMenuOpen = false
                this.commandMenuOpen = false
                this.render()
                return
            case 'import-cancel':
                this.importPreview = null
                this.render()
                return
            case 'import-merge':
                this.applyImport('merge')
                return
            case 'import-replace':
                this.applyImport('replace')
                return
            case 'new':
                this.openAddCommand()
                return
            case 'new-command-cancel':
                this.closeAddCommand()
                return
            case 'new-command-save':
                this.createCommand()
                return
            case 'add-category':
                this.categoryOverflowOpen = false
                this.openAddCategory()
                return
            case 'toggle-category-overflow':
                this.categoryOverflowOpen = !this.categoryOverflowOpen
                this.libraryMenuOpen = false
                this.categoryActionsOpen = false
                this.categoryMenuOpen = false
                this.targetMenuOpen = false
                this.commandMenuOpen = false
                this.render()
                return
            case 'toggle-category-actions':
                this.categoryActionsOpen = !this.categoryActionsOpen
                this.libraryMenuOpen = false
                this.categoryOverflowOpen = false
                this.categoryMenuOpen = false
                this.targetMenuOpen = false
                this.commandMenuOpen = false
                this.render()
                return
            case 'category-confirm':
                this.confirmAddCategory()
                return
            case 'category-cancel':
                this.addingCategory = false
                this.categoryInput = ''
                this.render()
                return
            case 'category-rename-confirm':
                this.confirmRenameCategory()
                return
            case 'category-rename-cancel':
                this.renamingCategory = false
                this.categoryInput = ''
                this.render()
                return
            case 'category-delete-confirm':
                this.confirmDeleteCategory()
                return
            case 'category-delete-cancel':
                this.deletingCategory = false
                this.render()
                return
            case 'toggle-favorite':
                this.toggleSelectedBoolean('favorite')
                return
            case 'toggle-pin':
                this.toggleSelectedBoolean('pinned')
                return
            case 'toggle-detail':
                this.withPreservedScroll(() => this.updateConfig({ basicInfoCollapsed: !this.state.basicInfoCollapsed }))
                return
            case 'toggle-more-settings':
                this.withPreservedScroll(() => this.updateConfig({ moreSettingsCollapsed: !this.state.moreSettingsCollapsed }))
                return
            case 'toggle-command-menu':
                this.commandMenuOpen = !this.commandMenuOpen
                this.libraryMenuOpen = false
                this.categoryActionsOpen = false
                this.categoryMenuOpen = false
                this.targetMenuOpen = false
                this.render()
                return
            case 'clear-shortcut':
                this.withPreservedScroll(() => this.updateSelectedCommand({ shortcut: '' }))
                return
            case 'category-menu-toggle':
                this.categoryMenuOpen = !this.categoryMenuOpen
                this.libraryMenuOpen = false
                this.categoryActionsOpen = false
                this.targetMenuOpen = false
                this.commandMenuOpen = false
                this.categoryOverflowOpen = false
                this.render()
                return
            case 'category-select':
                if (element?.dataset.categoryValue) {
                    this.categoryMenuOpen = false
                    this.updateSelectedCommand({ category: element.dataset.categoryValue }, true)
                }
                return
            case 'target-menu-toggle':
                this.targetMenuOpen = !this.targetMenuOpen
                this.libraryMenuOpen = false
                this.categoryActionsOpen = false
                this.categoryMenuOpen = false
                this.commandMenuOpen = false
                this.categoryOverflowOpen = false
                this.render()
                return
            case 'target-select':
                if (element?.dataset.targetValue === 'current' || element?.dataset.targetValue === 'all') {
                    this.targetMenuOpen = false
                    this.updateConfig({ targetMode: element.dataset.targetValue })
                }
                return
            case 'rename-category':
                this.openRenameCategory()
                return
            case 'delete-category':
                this.openDeleteCategory()
                return
            case 'move-up':
                this.moveSelectedCommand(-1)
                return
            case 'move-down':
                this.moveSelectedCommand(1)
                return
            case 'duplicate':
                this.commandMenuOpen = false
                this.duplicateSelectedCommand()
                return
            case 'move-command':
                this.commandMenuOpen = false
                this.openMoveCommand()
                return
            case 'move-command-cancel':
                this.movingCommandId = null
                this.moveTargetCategory = ''
                this.moveCategoryMenuOpen = false
                this.render()
                return
            case 'toggle-move-category-menu':
                this.moveCategoryMenuOpen = !this.moveCategoryMenuOpen
                this.render()
                return
            case 'select-move-category':
                this.moveTargetCategory = element?.dataset.moveCategory || ''
                this.moveCategoryMenuOpen = false
                this.render()
                return
            case 'move-command-confirm':
                this.confirmMoveCommand()
                return
            case 'delete':
                this.commandMenuOpen = false
                this.pendingDeleteId = this.getSelectedCommand()?.id || null
                this.render()
                return
            case 'delete-cancel':
                this.pendingDeleteId = null
                this.render()
                return
            case 'delete-confirm':
                this.deleteSelectedCommand()
                return
            case 'edit-command': {
                const commandId = element?.dataset.commandEditId
                const command = this.state.commands.find(item => item.id === commandId)
                if (command) {
                    this.editingCommandId = command.id
                    this.editCommandName = command.name
                    this.editCommandDescription = command.description
                    this.updateConfig({ selectedCommandId: command.id })
                }
                return
            }
            case 'edit-command-cancel':
                this.closeCommandListEdit()
                return
            case 'edit-command-save':
                this.saveCommandListEdit()
                return
            case 'execute-command': {
                const commandId = element?.dataset.commandExecuteId
                if (commandId && this.state.commands.some(command => command.id === commandId)) {
                    this.updateConfig({ selectedCommandId: commandId })
                    await this.executeSelectedCommand(false, focusAreaBeforeAction)
                }
                return
            }
            case 'rule-menu-toggle': {
                const ruleId = element?.dataset.ruleActionId
                const field = element?.dataset.ruleMenuField
                if (ruleId && field) {
                    const menuKey = `${ruleId}:${field}`
                    this.withPreservedScroll(() => {
                        this.automationRuleMenuKey = this.automationRuleMenuKey === menuKey ? null : menuKey
                        this.libraryMenuOpen = false
                        this.categoryActionsOpen = false
                        this.categoryMenuOpen = false
                        this.targetMenuOpen = false
                        this.commandMenuOpen = false
                        this.categoryOverflowOpen = false
                        this.render()
                    })
                }
                return
            }
            case 'rule-option-select': {
                const ruleId = element?.dataset.ruleActionId
                const field = element?.dataset.ruleMenuField
                const value = element?.dataset.ruleValue
                if (ruleId && field && value !== undefined) {
                    this.withPreservedScroll(() => {
                        this.automationRuleMenuKey = null
                        this.updateAutomationRuleValue(ruleId, field as keyof QuickAutomationRule, value, true)
                    })
                }
                return
            }
            case 'add-rule':
                this.addAutomationRule()
                return
            case 'add-line-rule':
                this.addAutomationRule(Math.max(0, Number(element?.dataset.ruleLine) || 0))
                return
            case 'toggle-all-rules':
                this.toggleAllAutomationRules()
                return
            case 'toggle-rule-collapsed':
                this.toggleAutomationRuleCollapsed(element?.dataset.ruleActionId || '')
                return
            case 'remove-rule':
                this.pendingRuleDeleteId = element?.dataset.ruleActionId || null
                this.render()
                return
            case 'rule-delete-cancel':
                this.pendingRuleDeleteId = null
                this.render()
                return
            case 'rule-delete-confirm':
                this.withPreservedScroll(() => {
                    const ruleId = this.pendingRuleDeleteId || ''
                    this.pendingRuleDeleteId = null
                    this.removeAutomationRule(ruleId)
                })
                return
            case 'copy':
                await this.copySelectedCommand()
                return
            case 'execute':
                await this.executeSelectedCommand(false, focusAreaBeforeAction)
                return
            case 'execute-confirm':
                await this.executeSelectedCommand(true, focusAreaBeforeAction)
                return
            case 'execute-cancel':
                this.pendingExecutionId = null
                this.confirmInput = ''
                this.render()
                return
            case 'pause':
                this.pauseExecution()
                return
            case 'resume':
                this.resumeExecution()
                return
            case 'stop':
                this.stopExecution()
                return
            case 'failure-continue':
                this.resolveManualFailure(false)
                return
            case 'failure-stop':
                this.resolveManualFailure(true)
                return
            default:
                return
        }
    }

    private openSettings (): void {
        this.persistPluginConfig()
        this.app.openNewTabRaw({
            type: SettingsTabComponent,
            inputs: { activeTab: pluginIdentity.settingsTabId },
        })
    }

    private updateSelectedField (
        element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        shouldRender = false,
    ): void {
        const selected = this.getSelectedCommand()
        const field = element.dataset.field as keyof QuickCommand | undefined
        if (!selected || !field) {
            return
        }

        let value: string | boolean | number = element.value
        if (field === 'autoEnter' || field === 'favorite' || field === 'pinned') {
            value = (element as HTMLInputElement).checked
        }
        if (field === 'lineDelay') {
            value = Math.max(0, Number(element.value) || 0)
        }
        if (field === 'command' && typeof value === 'string') {
            value = normalizeCommandText(value)
        }
        if (field === 'shortcut' && typeof value === 'string') {
            value = normalizeShortcut(value)
            const conflict = this.findShortcutConflict(value, selected.id)
            if (conflict) {
                this.showMessage(conflict.kind === 'drawer'
                    ? `快捷键与抽屉操作“${conflict.name}”冲突。`
                    : conflict.kind === 'plugin'
                        ? `快捷键与插件操作“${conflict.name}”冲突。`
                        : conflict.kind === 'tabby'
                            ? `快捷键与 Tabby 内置操作“${conflict.name}”冲突。`
                            : `快捷键已被“${conflict.name}”使用。`)
                value = selected.shortcut || ''
            }
        }

        this.updateSelectedCommand({ [field]: value } as Partial<QuickCommand>, field === 'category', shouldRender)
    }

    private updateSearch (search: HTMLInputElement): void {
        const cursor = search.selectionStart || search.value.length
        const previousFilter = this.filter.trim()
        const nextFilter = search.value.trim()
        const startingSearch = !previousFilter && Boolean(nextFilter)
        if (!previousFilter && nextFilter) {
            this.searchReturnCategory = this.state.selectedCategory
            this.searchReturnCommandId = this.state.selectedCommandId
            this.categoryOverflowOpen = false
            this.categoryActionsOpen = false
        }
        this.filter = search.value
        if (previousFilter && !nextFilter) {
            this.restoreSearchContext()
        } else if (nextFilter && this.state.selectedCategory !== '全部') {
            this.updateConfig({ selectedCategory: '全部' }, false)
        } else if (startingSearch || !this.refreshFilteredCommandList()) {
            this.render()
        } else {
            return
        }
        window.requestAnimationFrame(() => {
            const nextSearch = this.root?.querySelector<HTMLInputElement>('[data-role="search"]')
            nextSearch?.focus()
            nextSearch?.setSelectionRange(cursor, cursor)
        })
    }

    private clearSearchAndRestoreContext (): void {
        this.filter = ''
        this.restoreSearchContext()
        window.requestAnimationFrame(() => this.root?.querySelector<HTMLInputElement>('[data-role="search"]')?.focus())
    }

    private restoreSearchContext (): void {
        const selectedCommandId = this.searchReturnCommandId &&
            this.state.commands.some(command => command.id === this.searchReturnCommandId)
            ? this.searchReturnCommandId
            : this.state.selectedCommandId
        const selectedCategory = this.searchReturnCategory || '全部'
        this.searchReturnCategory = null
        this.searchReturnCommandId = null
        this.updateConfig({ selectedCategory, selectedCommandId }, false)
    }

    private updateLineDelay (element: HTMLInputElement): void {
        const selected = this.getSelectedCommand()
        const index = Number(element.dataset.lineDelay)
        if (!selected || !Number.isInteger(index)) {
            return
        }
        const lineDelays = [...(selected.lineDelays || [])]
        lineDelays[index] = Math.max(0, Number(element.value) || 0)
        this.updateSelectedCommand({ lineDelays }, false, false, false)
    }

    private bindLineSettings (scope: ParentNode): void {
        scope.querySelectorAll<HTMLInputElement>('[data-line-delay]').forEach(element => {
            element.addEventListener('change', () => this.updateLineDelay(element))
            element.addEventListener('blur', () => this.persistPluginConfig())
            element.addEventListener('keydown', event => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault()
                    const step = event.shiftKey ? 500 : 100
                    const direction = event.key === 'ArrowUp' ? 1 : -1
                    element.value = String(Math.max(0, (Number(element.value) || 0) + direction * step))
                    this.updateLineDelay(element)
                }
            })
        })
        scope.querySelectorAll<HTMLButtonElement>('[data-line-pause]').forEach(element => {
            element.addEventListener('click', () => this.toggleLinePause(element))
        })
        scope.querySelectorAll<HTMLButtonElement>('[data-line-rule-action]').forEach(element => {
            element.addEventListener('click', () => {
                const line = Math.max(0, Number(element.dataset.ruleLine) || 0)
                if (element.dataset.lineRuleAction === 'focus-line-rules') {
                    this.focusLineAutomationRules(line)
                } else {
                    this.addAutomationRule(line)
                }
            })
        })
    }

    private bindNumberInputWheel (scope: ParentNode): void {
        scope.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(element => {
            element.addEventListener('wheel', () => element.blur(), { passive: true })
        })
    }

    private refreshLineSettings (commandText: string): void {
        const selected = this.getSelectedCommand()
        const current = this.root?.querySelector<HTMLElement>('[data-role="line-settings"]')
        if (!selected || !current) {
            return
        }
        current.outerHTML = this.renderLineDelayEditor({ ...selected, command: commandText })
        const refreshed = this.root?.querySelector<HTMLElement>('[data-role="line-settings"]')
        if (refreshed) {
            this.bindLineSettings(refreshed)
            this.bindNumberInputWheel(refreshed)
            this.bindTooltips(refreshed)
        }
    }

    private toggleLinePause (element: HTMLButtonElement): void {
        const selected = this.getSelectedCommand()
        const index = Number(element.dataset.linePause)
        if (!selected || !Number.isInteger(index)) {
            return
        }
        const linePauses = [...(selected.linePauses || [])]
        linePauses[index] = !linePauses[index]
        this.updateSelectedCommand({ linePauses })
    }

    private updateAutomationRule (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
        const ruleElement = element.closest<HTMLElement>('[data-rule-id]')
        const ruleId = ruleElement?.dataset.ruleId
        const field = element.dataset.ruleField as keyof QuickAutomationRule | undefined
        if (!ruleId || !field) {
            return
        }
        const value = field === 'timeoutMs'
            ? Math.max(100, Number(element.value) || 10000)
            : element instanceof HTMLInputElement && element.type === 'checkbox'
                ? element.checked
                : element.value
        const shouldRender = field === 'enabled' || field === 'matchMode' ||
            field === 'waitFor' || field === 'errorPattern' ||
            field === 'waitForLogic' || field === 'errorPatternLogic' ||
            field === 'onMatchAction' || field === 'onErrorAction' || field === 'timeoutAction' ||
            field === 'triggerLine'
        if (shouldRender) {
            this.withPreservedScroll(() => this.updateAutomationRuleValue(ruleId, field, value, true))
            return
        }
        this.updateAutomationRuleValue(ruleId, field, value, false)
    }

    private updateAutomationRuleValue (
        ruleId: string,
        field: keyof QuickAutomationRule,
        value: string | number | boolean,
        shouldRender: boolean,
    ): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const normalizedValue = field === 'triggerLine'
            ? Math.max(0, Math.floor(Number(value) || 0))
            : value
        const automationRules = selected.automationRules.map(rule => (
            rule.id === ruleId ? { ...rule, [field]: normalizedValue } : rule
        ))
        this.updateSelectedCommand({ automationRules }, false, shouldRender)
    }

    private updateSelectedCommand (
        patch: Partial<QuickCommand>,
        syncCategory = false,
        shouldRender = true,
        save = true,
    ): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const commands = this.state.commands.map(command => (
            command.id === selected.id ? { ...command, ...patch } : command
        ))
        this.updateConfig({
            commands,
            selectedCommandId: selected.id,
            selectedCategory: syncCategory && typeof patch.category === 'string' ? patch.category : this.state.selectedCategory,
        }, save, shouldRender)
    }

    private toggleSelectedBoolean (field: 'favorite' | 'pinned'): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const enabled = !selected[field]
        this.updateSelectedCommand({ [field]: enabled } as Partial<QuickCommand>)
        this.recordActivity({
            category: 'command',
            action: field === 'favorite' ? 'command.favorite' : 'command.pin',
            status: 'success',
            message: `${enabled ? '已' : '已取消'}${field === 'favorite' ? '收藏' : '置顶'}命令`,
            subject: { type: 'command', id: selected.id, name: selected.name },
            details: { enabled },
        })
    }

    private openAddCommand (): void {
        this.addingCommand = true
        this.resetNewCommandDraft()
        this.render()
    }

    private closeAddCommand (): void {
        this.addingCommand = false
        this.resetNewCommandDraft()
        this.render()
    }

    private getDefaultNewCommandName (): string {
        return this.i18n.text('新命令')
    }

    private resetNewCommandDraft (): void {
        this.newCommandName = this.getDefaultNewCommandName()
        this.newCommandNameEdited = false
        this.newCommandDescription = ''
    }

    private createCommand (): void {
        const name = this.newCommandName.trim()
        if (!name) {
            this.showMessage('命令名称不能为空。')
            return
        }
        const category = this.state.selectedCategory === '全部' ||
            this.state.selectedCategory === '收藏' ||
            this.state.selectedCategory === '常用'
            ? '默认'
            : this.state.selectedCategory
        const command = normalizeCommandConfig({
            id: this.createId(),
            name,
            description: this.newCommandDescription.trim(),
            category,
            command: '',
            lineDelay: 500,
        }, () => this.createId())
        this.addingCommand = false
        this.resetNewCommandDraft()
        this.clearSearchState()
        this.updateConfig({
            commands: [...this.state.commands, command],
            selectedCommandId: command.id,
            selectedCategory: category,
        })
        this.recordActivity({
            category: 'command', action: 'command.create', status: 'success', message: '已新增命令',
            subject: { type: 'command', id: command.id, name: command.name }, details: { category },
        })
    }

    private openAddCategory (): void {
        this.addingCategory = true
        this.categoryInput = ''
        this.render()
    }

    private confirmAddCategory (): void {
        const name = this.categoryInput.trim()
        if (!name || name === '全部' || name === '收藏' || name === '常用') {
            this.showMessage('请输入有效的分类名称。')
            return
        }
        this.addingCategory = false
        this.categoryInput = ''
        if (this.getCategories().includes(name)) {
            this.updateConfig({ selectedCategory: name })
            return
        }
        this.updateConfig({
            customCategories: [...this.state.customCategories, name],
            categoryOrder: [...this.getOrderedCategories(), name],
            selectedCategory: name,
        })
        this.recordActivity({
            category: 'category', action: 'category.create', status: 'success', message: '已新增分类',
            subject: { type: 'category', name },
        })
    }

    private duplicateSelectedCommand (): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }

        const command: QuickCommand = {
            ...selected,
            id: this.createId(),
            name: `${selected.name} 副本`,
            shortcut: '',
            usageCount: 0,
            lastUsedAt: null,
        }
        this.clearSearchState()
        this.updateConfig({
            commands: [...this.state.commands, command],
            selectedCommandId: command.id,
            selectedCategory: command.category,
        })
        this.recordActivity({
            category: 'command', action: 'command.duplicate', status: 'success', message: '已复制命令',
            subject: { type: 'command', id: command.id, name: command.name },
            details: { sourceName: selected.name },
        })
    }

    private openMoveCommand (): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        this.movingCommandId = selected.id
        this.moveTargetCategory = ''
        this.moveCategoryMenuOpen = false
        this.render()
    }

    private confirmMoveCommand (): void {
        const commandId = this.movingCommandId
        const category = this.moveTargetCategory
        if (!commandId || !category || this.isSystemCategory(category)) {
            return
        }
        const moved = this.state.commands.find(command => command.id === commandId)
        const previousCategory = moved?.category || ''
        const commands = this.state.commands.map(command => (
            command.id === commandId ? { ...command, category } : command
        ))
        const navigateAfterMove = this.state.moveNavigateAfterMove
        const currentCategory = this.state.selectedCategory
        this.movingCommandId = null
        this.moveTargetCategory = ''
        this.moveCategoryMenuOpen = false
        if (navigateAfterMove) {
            this.clearSearchState()
        }
        this.updateConfig({
            commands,
            selectedCommandId: commandId,
            selectedCategory: navigateAfterMove ? category : currentCategory,
        })
        if (moved && previousCategory !== category) {
            this.recordActivity({
                category: 'command', action: 'command.move', status: 'success', message: '已移动命令',
                subject: { type: 'command', id: moved.id, name: moved.name },
                details: { from: previousCategory, to: category },
            })
        }
    }

    private clearSearchState (): void {
        this.filter = ''
        this.searchReturnCategory = null
        this.searchReturnCommandId = null
    }

    private moveSelectedCommand (direction: -1 | 1): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        if (!this.canSortSelectedCategory()) {
            this.showMessage('请先进入具体分类后再排序。')
            return
        }

        const peerIds = this.state.commands
            .filter(command => command.category === selected.category)
            .map(command => command.id)
        const peerIndex = peerIds.indexOf(selected.id)
        const nextPeerId = peerIds[peerIndex + direction]
        if (!nextPeerId) {
            return
        }

        const commands = [...this.state.commands]
        const index = commands.findIndex(command => command.id === selected.id)
        const nextIndex = commands.findIndex(command => command.id === nextPeerId)
        if (index < 0 || nextIndex < 0) {
            return
        }

        const current = commands[index]
        commands[index] = commands[nextIndex]
        commands[nextIndex] = current
        this.updateConfig({ commands })
        this.recordActivity({
            category: 'command', action: 'command.reorder', status: 'success', message: '已调整命令顺序',
            subject: { type: 'command', id: selected.id, name: selected.name },
            details: { direction: direction < 0 ? 'up' : 'down' },
        })
    }

    private reorderCommand (draggedId: string, targetId: string): void {
        if (draggedId === targetId) {
            return
        }
        const commands = [...this.state.commands]
        const from = commands.findIndex(command => command.id === draggedId)
        const to = commands.findIndex(command => command.id === targetId)
        if (from < 0 || to < 0) {
            return
        }
        if (commands[from].category !== commands[to].category) {
            this.showMessage('只能在同一分类内排序。')
            return
        }
        const [dragged] = commands.splice(from, 1)
        commands.splice(to, 0, dragged)
        this.updateConfig({ commands, selectedCommandId: draggedId })
        this.recordActivity({
            category: 'command', action: 'command.reorder', status: 'success', message: '已调整命令顺序',
            subject: { type: 'command', id: dragged.id, name: dragged.name },
        })
    }

    private reorderCategory (dragged: string, target: string, placement: 'before' | 'after'): void {
        if (dragged === target || !this.canDragCategory(dragged) || !this.canDragCategory(target)) {
            return
        }
        const categories = this.getOrderedCategories()
        const from = categories.indexOf(dragged)
        const targetIndex = categories.indexOf(target)
        let to = placement === 'after' ? targetIndex + 1 : targetIndex
        if (from < 0 || to < 0) {
            return
        }
        const [category] = categories.splice(from, 1)
        if (from < to) {
            to--
        }
        categories.splice(to, 0, category)
        this.updateConfig({ categoryOrder: categories })
        this.recordActivity({
            category: 'category', action: 'category.reorder', status: 'success', message: '已调整分类顺序',
            subject: { type: 'category', name: category },
        })
    }

    private deleteSelectedCommand (): void {
        const id = this.pendingDeleteId || this.getSelectedCommand()?.id
        if (!id) {
            return
        }
        const deleted = this.state.commands.find(command => command.id === id)
        const commands = this.state.commands
            .filter(command => command.id !== id)
            .map(command => ({
                ...command,
                automationRules: command.automationRules.map(rule => ({
                    ...rule,
                    onMatchCommandId: rule.onMatchCommandId === id ? '' : rule.onMatchCommandId,
                    onErrorCommandId: rule.onErrorCommandId === id ? '' : rule.onErrorCommandId,
                    onTimeoutCommandId: rule.onTimeoutCommandId === id ? '' : rule.onTimeoutCommandId,
                })),
            }))
        this.pendingDeleteId = null
        this.updateConfig({
            commands,
            selectedCommandId: commands[0]?.id || null,
        })
        this.persistPluginConfig()
        if (deleted) {
            this.recordActivity({
                category: 'command', action: 'command.delete', status: 'success', message: '已删除命令',
                subject: { type: 'command', id: deleted.id, name: deleted.name },
                details: { category: deleted.category },
            })
        }
    }

    private saveCommandListEdit (): void {
        const commandId = this.editingCommandId
        const name = this.editCommandName.trim()
        if (!commandId) {
            return
        }
        if (!name) {
            this.showMessage('命令名称不能为空。')
            return
        }
        const description = this.editCommandDescription.trim()
        const previous = this.state.commands.find(command => command.id === commandId)
        const commands = this.state.commands.map(command => (
            command.id === commandId
                ? { ...command, name, description }
                : command
        ))
        this.editingCommandId = null
        this.editCommandName = ''
        this.editCommandDescription = ''
        this.updateConfig({ commands, selectedCommandId: commandId })
        if (previous && (previous.name !== name || previous.description !== description)) {
            this.recordActivity({
                category: 'command', action: 'command.update', status: 'success', message: '已编辑命令',
                subject: { type: 'command', id: commandId, name },
            })
        }
    }

    private closeCommandListEdit (): void {
        this.editingCommandId = null
        this.editCommandName = ''
        this.editCommandDescription = ''
        this.render()
    }

    private openRenameCategory (): void {
        if (!this.canRenameSelectedCategory()) {
            return
        }
        this.addingCategory = false
        this.deletingCategory = false
        this.renamingCategory = true
        this.categoryInput = this.state.selectedCategory
        this.render()
    }

    private confirmRenameCategory (): void {
        const current = this.state.selectedCategory
        const nextName = this.categoryInput.trim()
        if (!this.canRenameSelectedCategory() || !nextName || this.isSystemCategory(nextName)) {
            this.showMessage('请输入有效的分类名称。')
            return
        }
        if (nextName !== current && this.getCategories().includes(nextName)) {
            this.showMessage('分类名称已存在。')
            return
        }
        this.renamingCategory = false
        this.categoryInput = ''
        if (nextName === current) {
            this.render()
            return
        }
        const commands = this.state.commands.map(command => (
            command.category === current ? { ...command, category: nextName } : command
        ))
        const customCategories = this.state.customCategories.map(category => (
            category === current ? nextName : category
        ))
        const categoryOrder = this.state.categoryOrder.map(category => (
            category === current ? nextName : category
        ))
        this.updateConfig({ commands, customCategories, categoryOrder, selectedCategory: nextName })
        this.recordActivity({
            category: 'category', action: 'category.rename', status: 'success', message: '已重命名分类',
            subject: { type: 'category', name: nextName }, details: { from: current, to: nextName },
        })
    }

    private openDeleteCategory (): void {
        if (!this.canDeleteSelectedCategory()) {
            return
        }
        this.addingCategory = false
        this.renamingCategory = false
        this.deletingCategory = true
        this.render()
    }

    private confirmDeleteCategory (): void {
        if (!this.canDeleteSelectedCategory()) {
            this.deletingCategory = false
            this.render()
            return
        }
        const category = this.state.selectedCategory
        const deletedCommandIds = new Set(
            this.state.commands
                .filter(command => command.category === category)
                .map(command => command.id),
        )
        const commands = this.state.commands
            .filter(command => command.category !== category)
            .map(command => ({
                ...command,
                automationRules: command.automationRules.map(rule => ({
                    ...rule,
                    onMatchCommandId: deletedCommandIds.has(rule.onMatchCommandId) ? '' : rule.onMatchCommandId,
                    onErrorCommandId: deletedCommandIds.has(rule.onErrorCommandId) ? '' : rule.onErrorCommandId,
                    onTimeoutCommandId: deletedCommandIds.has(rule.onTimeoutCommandId) ? '' : rule.onTimeoutCommandId,
                })),
            }))
        this.deletingCategory = false
        this.updateConfig({
            commands,
            customCategories: this.state.customCategories.filter(item => item !== category),
            categoryOrder: this.state.categoryOrder.filter(item => item !== category),
            selectedCategory: '全部',
            selectedCommandId: commands[0]?.id || null,
        })
        this.persistPluginConfig()
        this.recordActivity({
            category: 'category', action: 'category.delete', status: 'success', message: '已删除分类',
            subject: { type: 'category', name: category }, details: { commandCount: deletedCommandIds.size },
        })
    }

    private canDeleteSelectedCategory (): boolean {
        return this.state.selectedCategory !== '全部' &&
            this.state.selectedCategory !== '收藏' &&
            this.state.selectedCategory !== '常用'
    }

    private canRenameSelectedCategory (): boolean {
        return this.state.selectedCategory !== '全部' &&
            this.state.selectedCategory !== '收藏' &&
            this.state.selectedCategory !== '常用'
    }

    private canSortSelectedCategory (): boolean {
        return this.state.selectedCategory !== '全部' &&
            this.state.selectedCategory !== '收藏' &&
            this.state.selectedCategory !== '常用'
    }

    private addAutomationRule (triggerLine = 0): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const rule: QuickAutomationRule = {
            id: this.createId(),
            name: '输出匹配规则',
            enabled: true,
            collapsed: false,
            triggerLine: Math.max(0, Math.floor(triggerLine)),
            matchMode: 'literal',
            waitFor: '',
            waitForLogic: 'single',
            timeoutMs: 10000,
            errorPattern: '',
            errorPatternLogic: 'single',
            matchFlow: 'continue',
            onMatchAction: 'none',
            onMatchCommand: '',
            onMatchAutoEnter: true,
            onMatchCommandId: '',
            onErrorAction: 'none',
            onErrorCommand: '',
            onErrorAutoEnter: true,
            onErrorCommandId: '',
            onTimeoutCommand: '',
            onTimeoutAutoEnter: true,
            onTimeoutCommandId: '',
            timeoutAction: 'continue',
        }
        this.pendingAutomationRuleScrollId = rule.id
        const commands = this.state.commands.map(command => (
            command.id === selected.id
                ? { ...command, automationRules: [...command.automationRules, rule] }
                : command
        ))
        this.updateConfig({
            commands,
            selectedCommandId: selected.id,
            moreSettingsCollapsed: false,
        })
    }

    private focusLineAutomationRules (triggerLine: number): void {
        const selected = this.getSelectedCommand()
        const rule = selected?.automationRules.find(item => item.triggerLine === triggerLine)
        if (!selected || !rule) {
            this.addAutomationRule(triggerLine)
            return
        }
        this.pendingAutomationRuleScrollId = rule.id
        this.updateConfig({ moreSettingsCollapsed: false })
    }

    private toggleAutomationRuleCollapsed (ruleId: string): void {
        if (!ruleId) {
            return
        }
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const automationRules = selected.automationRules.map(rule => (
            rule.id === ruleId ? { ...rule, collapsed: !rule.collapsed } : rule
        ))
        this.withPreservedScroll(() => this.updateSelectedCommand({ automationRules }))
    }

    private toggleAllAutomationRules (): void {
        const selected = this.getSelectedCommand()
        if (!selected || !selected.automationRules.length) {
            return
        }
        const collapsed = selected.automationRules.some(rule => !rule.collapsed)
        const automationRules = selected.automationRules.map(rule => ({ ...rule, collapsed }))
        this.withPreservedScroll(() => this.updateSelectedCommand({ automationRules }))
    }

    private removeAutomationRule (ruleId: string): void {
        const selected = this.getSelectedCommand()
        if (!selected || !ruleId) {
            return
        }
        this.updateSelectedCommand({
            automationRules: selected.automationRules.filter(rule => rule.id !== ruleId),
        })
    }

    private async copySelectedCommand (): Promise<void> {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }

        try {
            await navigator.clipboard.writeText(selected.command)
            this.showMessage('命令已复制。')
        } catch (error) {
            this.logger.warn('Clipboard write failed', error)
            this.showMessage('复制失败，可以手动选中命令内容复制。')
        }
    }

    private async exportCommands (): Promise<void> {
        const payload = {
            format: quickCommandsFileFormat,
            version: quickCommandsFileVersion,
            kind: 'commands',
            exportedAt: new Date().toISOString(),
            customCategories: this.state.customCategories,
            categoryOrder: this.state.categoryOrder,
            commands: this.state.commands.map(command => this.stripCommandRuntime(command)),
        }
        const text = JSON.stringify(payload, null, 2)
        const fileName = this.renderExportFileName()
        let downloaded = false
        let copied = false

        try {
            const blob = new Blob([text], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = fileName
            link.style.display = 'none'
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            downloaded = true
        } catch (error) {
            this.logger.warn('Command export download failed', error)
        }

        try {
            await navigator.clipboard.writeText(text)
            copied = true
        } catch (error) {
            this.logger.warn('Command export clipboard failed', error)
        }
        this.showMessage(downloaded
            ? copied ? '命令库已导出，并已复制 JSON 到剪贴板。' : '命令库已导出为 JSON 文件。'
            : copied ? '文件下载失败，JSON 已复制到剪贴板。' : '导出失败，请查看 Tabby 日志。')
        this.recordActivity({
            category: 'library',
            action: 'library.export',
            status: downloaded || copied ? 'success' : 'failure',
            message: downloaded || copied ? '命令库导出成功' : '命令库导出失败',
            subject: { type: 'library', name: fileName },
            details: { commandCount: this.state.commands.length, downloaded, copied },
        })
    }

    private renderExportFileName (): string {
        const date = new Date().toISOString().slice(0, 10)
        const rendered = (this.state.exportFileName || pluginIdentity.exportFileName)
            .replace(/\{date\}/g, date)
        const name = rendered.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || `${pluginIdentity.packageName}-${date}.json`
        return /\.json$/i.test(name) ? name : `${name}.json`
    }

    private async importCommandsFromFile (file: File): Promise<void> {
        const store = this.pluginConfigStore
        try {
            if (file.size > 5 * 1024 * 1024) {
                throw new Error('导入文件不能超过 5MB。')
            }
            const text = await file.text()
            if (store !== this.pluginConfigStore || !store.dataAccess.isCurrent()) { return }
            await this.importCommandsText(text)
        } catch (error) {
            if (store !== this.pluginConfigStore || !store.dataAccess.isCurrent()) { return }
            this.logger.warn('Command import failed', error)
            const reason = error instanceof Error ? error.message : '请确认 JSON 文件格式。'
            this.showMessage(`导入失败：${reason}`)
            this.recordActivity({
                category: 'library', action: 'library.import', status: 'failure', message: '命令库导入失败',
                subject: { type: 'library', name: file.name }, details: { reason },
            })
        }
    }

    private async importCommandsText (text: string): Promise<void> {
        const parsed = parseImportPayload(text)
        const imported = parsed.commands
            .map(command => normalizeCommandConfig(command as Partial<QuickCommand>, () => this.createId()))
        if (!imported.length) {
            this.showMessage('导入文件里没有命令。')
            return
        }
        this.importPreview = buildImportPreview(this.state.commands, imported, {
            customCategories: parsed.customCategories,
            categoryOrder: parsed.categoryOrder,
            version: parsed.version,
        })
        this.showDrawer()
    }

    private applyImport (mode: ImportMode): void {
        if (!this.importPreview) {
            return
        }
        const preview = this.importPreview
        const applied = applyImportPreview(this.state.commands, preview, mode)
        const sanitized = sanitizeAutomationReferences(applied)
        const commands = sanitized.commands
        const importedCategories = Array.from(new Set(commands.map(command => command.category)))
        const customCategories = mode === 'replace'
            ? preview.customCategories
            : Array.from(new Set([...this.state.customCategories, ...preview.customCategories]))
        const categoryOrder = mode === 'replace'
            ? preview.categoryOrder.length ? preview.categoryOrder : importedCategories
            : Array.from(new Set([...this.state.categoryOrder, ...preview.categoryOrder]))
        this.importPreview = null
        this.updateConfig({
            commands,
            customCategories,
            categoryOrder,
            selectedCommandId: commands[0]?.id || null,
            selectedCategory: commands[0]?.category || '全部',
        })
        this.persistPluginConfig()
        const referenceMessage = sanitized.clearedReferences
            ? `，并清理 ${sanitized.clearedReferences} 个失效触发器引用`
            : ''
        this.showMessage(`${mode === 'merge' ? '命令库已合并导入' : '命令库已替换导入'}${referenceMessage}。`)
        this.recordActivity({
            category: 'library', action: 'library.import', status: 'success', message: '命令库导入成功',
            subject: { type: 'library', name: mode === 'merge' ? '合并导入' : '替换导入' },
            details: { mode, commandCount: commands.length, clearedReferences: sanitized.clearedReferences },
        })
    }

    private async executeSelectedCommand (
        confirmed = false,
        focusAreaBeforeSend: DrawerFocusArea = this.focusArea,
    ): Promise<void> {
        if (!this.pluginConfigStore.dataAccess.isCurrent()) {
            this.showMessage('插件数据已在其他窗口重置，请重启 Tabby 后再操作。')
            return
        }
        const selected = this.getSelectedCommand()
        if (!selected || this.running) {
            return
        }

        const targets = this.getTargetTabs()
        if (!targets.length) {
            this.showMessage('没有找到可发送命令的终端会话。')
            return
        }

        if (!selected.command.trim()) {
            this.showMessage('命令内容为空。')
            return
        }

        this.persistPluginConfig()

        const summary = this.buildExecutionSummary(selected, targets)
        if (!confirmed && summary.requiresConfirm) {
            this.pendingExecutionId = selected.id
            this.confirmInput = ''
            this.showDrawer()
            return
        }
        if (confirmed && summary.requiresTypedConfirm && this.confirmInput !== summary.requiredText) {
            this.showMessage(`请输入 ${summary.requiredText} 后再确认。`)
            return
        }

        const runner = this.createExecutionRunner()
        let releaseExecution: (() => void) | undefined
        try {
            releaseExecution = this.pluginConfigStore.dataAccess.beginExecution()
            this.running = true
            this.pendingExecutionId = null
            this.confirmInput = ''
            this.message = ''
            this.executionRunner = runner
            this.runState = runner.start(selected, this.state.executionMode)
            this.updateUsage(selected.id)
            this.addLog('info', '开始执行', selected.id, undefined, {
                mode: summary.modeLabel,
                targetNames: summary.targetNames,
                action: 'execution.start',
                status: 'info',
            })
            this.render()
            const execution = runner.execute(
                selected,
                targets,
                this.state.executionMode,
                this.state.failureStrategy,
                this.state.recentOutputLimit,
            )
            if (
                this.visible &&
                (this.state.focusTerminalAfterSend || focusAreaBeforeSend === 'terminal')
            ) {
                this.focusCurrentTerminal()
            }
            const stopped = await execution
            if (stopped) {
                this.showMessage('执行已停止。')
                return
            }
            this.addLog('info', '执行完成', selected.id, undefined, {
                mode: summary.modeLabel,
                targetNames: summary.targetNames,
                durationMs: runner.getDuration(),
                action: 'execution.complete',
                status: 'success',
            })
            this.showMessage(`已发送到 ${targets.length} 个会话。`)
        } catch (error) {
            this.logger.error('Failed to execute command', error)
            this.addLog('error', '执行失败，请查看 Tabby 日志。', selected.id, undefined, {
                mode: summary.modeLabel,
                targetNames: summary.targetNames,
                durationMs: runner.getDuration(),
                action: 'execution.fail',
                status: 'failure',
            })
            this.showMessage('执行失败，请查看 Tabby 日志。')
        } finally {
            runner.dispose()
            try { releaseExecution?.() } catch (error) { this.logger.warn('Failed to release execution marker', error) }
            this.executionRunner = undefined
            this.running = false
            this.runState = undefined
            this.pendingFailureMessage = ''
            this.render()
        }
    }

    private createExecutionRunner (): QuickCommandsExecutionRunner {
        return new QuickCommandsExecutionRunner({
            getTargetKey: target => this.getTargetKey(target),
            getTargetName: target => this.getTabTitle(target),
            getCommand: commandId => this.state.commands.find(command => command.id === commandId),
            isDangerous: command => this.getDanger(command).dangerous,
            log: (level, message, commandId, line, context) => {
                this.addLog(level, message, commandId, line, context)
            },
            warn: (message, error) => this.logger.warn(message, error),
            stateChanged: (state, pendingFailureMessage) => {
                this.runState = state
                this.pendingFailureMessage = pendingFailureMessage
                this.render()
            },
        })
    }

    private openUpdateSettings (): void {
        this.pluginUpdate.requestSettingsFocus()
        this.close()
        this.openSettings()
    }

    private shouldShowUpdateReminder (): boolean {
        const update = this.pluginUpdate.snapshot
        return update.available && !update.ignored && update.status !== 'restart'
    }

    private pauseExecution (): void {
        this.executionRunner?.pause()
    }

    private resumeExecution (): void {
        this.executionRunner?.resume()
    }

    private stopExecution (): void {
        this.executionRunner?.stop()
    }

    private resolveManualFailure (stop: boolean): void {
        this.executionRunner?.resolveManualFailure(stop)
    }

    private updateDrawerWidthLive (width: number): void {
        const drawerWidth = this.clampWidth(width)
        this.state = { ...this.state, drawerWidth }
        const root = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language))
        root.drawerWidth = drawerWidth
        this.setPluginConfig(root, false)
        this.root?.style.setProperty('--tqc-width', `${drawerWidth}px`)
        window.requestAnimationFrame(() => this.layoutCategories())
    }

    private refreshFilteredCommandList (): boolean {
        const list = this.root?.querySelector<HTMLElement>('.tqc-list')
        if (!list) {
            return false
        }
        const commands = this.getFilteredCommands()
        const selected = resolveSelectedCommand(commands, this.state.selectedCommandId)
        if ((selected?.id || null) !== this.renderedCommandId) {
            return false
        }
        const listScrollTop = list.scrollTop
        list.innerHTML = commands.length
            ? commands.map(command => this.renderCommandListItem(command, selected?.id === command.id)).join('')
            : '<div class="tqc-empty">没有匹配的命令</div>'
        this.i18n.localizeElement(list)
        this.bindTooltips(list)
        list.scrollTop = listScrollTop
        return true
    }

    private handleDocumentKeyDown (event: KeyboardEvent): void {
        if (event.defaultPrevented || event.repeat || event.isComposing) {
            return
        }

        if (document.documentElement?.hasAttribute('data-windy-quick-commands-hotkey-recording')) {
            return
        }

        if (this.visible && event.target instanceof HTMLElement && event.target.matches('[data-role="shortcut-input"]')) {
            return
        }

        if (this.visible && this.isCopyShortcut(event) && this.hasPluginTextSelection(event.target)) {
            event.stopImmediatePropagation()
            return
        }

        const shortcut = shortcutFromKeyboardEvent(event)
        const focusShortcut = shortcut || (event.key === 'Escape' ? 'Escape' : '')
        if (
            this.visible &&
            this.isForegroundDrawer() &&
            event.key === 'Escape' &&
            this.hasBlockingOverlay()
        ) {
            if (this.dismissTopOverlay()) {
                event.preventDefault()
                event.stopImmediatePropagation()
            }
            return
        }
        if (shortcut && this.getActionShortcuts('toggleDrawer').includes(shortcut)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.toggle()
            return
        }
        if (shortcut && this.getActionShortcuts('openSettings').includes(shortcut)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.openSettings()
            return
        }
        if (
            this.visible &&
            this.isForegroundDrawer() &&
            shortcut &&
            this.getActionShortcuts('toggleHints').includes(shortcut)
        ) {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.toggleOperationHints()
            return
        }
        if (
            this.visible &&
            this.isForegroundDrawer() &&
            focusShortcut &&
            this.getActionShortcuts('switchFocus').includes(focusShortcut)
        ) {
            if (this.hasBlockingOverlay()) {
                return
            }
            event.preventDefault()
            // Capture single-stroke focus switching before xterm can consume it.
            // Stopping propagation also prevents Tabby's document hotkey listener
            // from emitting the same action and toggling the focus twice.
            event.stopImmediatePropagation()
            this.toggleFocusArea()
            return
        }

        const drawerKeyboardTarget = this.isSearchInput(event.target) || this.isDrawerSurface(event.target)
        if (this.visible && this.isForegroundDrawer() && drawerKeyboardTarget) {
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.moveKeyboardCommand(event.key === 'ArrowUp' ? -1 : 1)
                return
            }
            const categoryArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            const categoryModifier = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
            const plainCategoryArrow = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
            if (!this.filter.trim() && categoryArrow && (categoryModifier || plainCategoryArrow)) {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.moveKeyboardCategory(event.key === 'ArrowLeft' ? -1 : 1)
                return
            }
            if (this.isDrawerSurface(event.target) && this.movePrintableKeyToSearch(event)) {
                return
            }
            const plainEnter = event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            const ctrlEnter = event.key === 'Enter' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            if (plainEnter || ctrlEnter) {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (!this.running && this.getSelectedCommand()) {
                    void this.executeSelectedCommand()
                }
                return
            }
        }

        const focusedCommandId = this.getFocusedCommandId(event.target)
        if (
            this.visible &&
            this.isForegroundDrawer() &&
            focusedCommandId &&
            event.key === 'Enter' &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey
        ) {
            event.preventDefault()
            event.stopImmediatePropagation()
            if (!this.running) {
                this.updateConfig({ selectedCommandId: focusedCommandId })
                void this.executeSelectedCommand()
            }
            return
        }

        if (
            this.visible &&
            event.key === 'Enter' &&
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey &&
            (!this.isEditableElement(event.target) || this.isTerminalInput(event.target) || this.isSearchInput(event.target))
        ) {
            if (!this.isForegroundDrawer()) { return }
            event.preventDefault()
            event.stopImmediatePropagation()
            if (this.running) { return }
            if (focusedCommandId) {
                this.updateConfig({ selectedCommandId: focusedCommandId })
            }
            const selected = this.getSelectedCommand()
            if (selected) {
                void this.executeSelectedCommand()
            }
            return
        }

        if (!shortcut) {
            return
        }
        if (this.isEditableElement(event.target) && !this.isTerminalInput(event.target)) {
            return
        }

        const command = this.state.commands.find(item => normalizeShortcut(item.shortcut) === shortcut)
        if (!command || this.findShortcutConflict(shortcut, command.id)) {
            return
        }

        event.preventDefault()
        event.stopPropagation()
        this.updateConfig({
            selectedCommandId: command.id,
            selectedCategory: command.category || this.state.selectedCategory,
        })
        void this.executeSelectedCommand()
    }

    private handleRootKeyDown (event: KeyboardEvent): void {
        if (!this.visible || !this.isEditableElement(event.target)) {
            return
        }

        event.stopPropagation()
    }

    private handleRootClick (event: MouseEvent): void {
        if (!this.visible) {
            return
        }

        this.focusAreaBeforeRootClick = this.focusArea
        if (this.isEditableElement(event.target)) {
            return
        }

        this.focusArea = 'drawer'
        this.drawerFocusTarget = 'surface'
        this.updateFocusPresentation()
        if (this.isDrawerInteractiveControl(event.target)) {
            return
        }

        window.requestAnimationFrame(() => {
            if (!this.visible || this.drawerFocusTarget !== 'surface') {
                return
            }
            this.focusDrawerSurface()
        })
    }

    private handleDelegatedRootClick (event: MouseEvent): void {
        const actionElement = this.getDelegatedTarget(event, '[data-action]')
        const action = actionElement?.dataset.action || ''
        const focusAreaBeforeAction = this.focusAreaBeforeRootClick || this.focusArea
        this.focusAreaBeforeRootClick = null
        if (actionElement && shouldHandleDelegatedAction(
            action,
            actionElement.classList.contains('tqc-confirm-backdrop'),
            event.target === actionElement,
        )) {
            event.preventDefault()
            event.stopPropagation()
            if (this.commandMenuOpen && action !== 'toggle-command-menu' && action !== 'duplicate' && action !== 'delete') {
                this.closeCommandMenu()
            }
            if (this.categoryOverflowOpen && action !== 'toggle-category-overflow') {
                this.closeCategoryOverflowMenu()
            }
            if (this.libraryMenuOpen && action !== 'toggle-library-menu') {
                this.closeLibraryMenu()
            }
            if (this.categoryActionsOpen && action !== 'toggle-category-actions') {
                this.closeCategoryActionsMenu()
            }
            if (this.automationRuleMenuKey && action !== 'rule-menu-toggle' && action !== 'rule-option-select') {
                this.closeAutomationRuleMenu()
            }
            void this.handleAction(action, actionElement, focusAreaBeforeAction)
            return
        }

        const commandId = this.getDelegatedTarget(event, '[data-command-id]')?.dataset.commandId
        if (commandId) {
            this.commandMenuOpen = false
            this.updateConfig({ selectedCommandId: commandId })
        }
    }

    private handleDelegatedCommandDragStart (event: DragEvent): void {
        const element = this.getDelegatedTarget(event, '[data-command-id]')
        if (!element) {
            return
        }
        this.draggedCommandId = element.dataset.commandId || null
        element.classList.add('tqc-dragging')
        event.dataTransfer?.setData('text/plain', this.draggedCommandId || '')
    }

    private handleDelegatedCommandDragOver (event: DragEvent): void {
        if (this.getDelegatedTarget(event, '[data-command-id]')) {
            event.preventDefault()
        }
    }

    private handleDelegatedCommandDrop (event: DragEvent): void {
        const targetId = this.getDelegatedTarget(event, '[data-command-id]')?.dataset.commandId
        if (!targetId || !this.draggedCommandId) {
            return
        }
        event.preventDefault()
        this.reorderCommand(this.draggedCommandId, targetId)
    }

    private handleDelegatedCommandDragEnd (event: DragEvent): void {
        const element = this.getDelegatedTarget(event, '[data-command-id]')
        this.draggedCommandId = null
        element?.classList.remove('tqc-dragging')
    }

    private getDelegatedTarget (event: Event, selector: string): HTMLElement | null {
        if (!(event.target instanceof Element)) {
            return null
        }
        const target = event.target.closest(selector)
        return target instanceof HTMLElement && this.root?.contains(target) ? target : null
    }

    private isCopyShortcut (event: KeyboardEvent): boolean {
        return event.key.toLowerCase() === 'c' &&
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey
    }

    private hasPluginTextSelection (target: EventTarget | null): boolean {
        if (!this.root) {
            return false
        }

        if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && this.root.contains(target)) {
            return target.selectionStart !== null &&
                target.selectionEnd !== null &&
                target.selectionStart !== target.selectionEnd
        }

        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
            return false
        }
        return this.root.contains(selection.anchorNode) && this.root.contains(selection.focusNode)
    }

    private focusCurrentTerminal (): boolean {
        const terminal = this.getCurrentTerminalTab()
        if (!terminal?.frontend?.focus) {
            return false
        }
        this.focusArea = 'terminal'
        terminal.frontend.focus()
        this.updateFocusPresentation()
        return true
    }

    private focusDrawerSearch (): void {
        this.focusArea = 'drawer'
        this.drawerFocusTarget = 'search'
        this.updateFocusPresentation()
        window.requestAnimationFrame(() => {
            if (!this.visible || this.drawerFocusTarget !== 'search') { return }
            const search = this.root?.querySelector<HTMLInputElement>('[data-role="search"]')
            search?.focus()
            if (search) {
                const cursor = search.value.length
                search.setSelectionRange(cursor, cursor)
            }
        })
    }

    private focusDrawerSurface (): void {
        this.focusArea = 'drawer'
        this.drawerFocusTarget = 'surface'
        this.updateFocusPresentation()
        this.root?.querySelector<HTMLElement>('[data-role="drawer-surface"]')?.focus({ preventScroll: true })
    }

    private movePrintableKeyToSearch (event: KeyboardEvent): boolean {
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
            return false
        }
        const search = this.root?.querySelector<HTMLInputElement>('[data-role="search"]')
        if (!search) {
            return false
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        this.focusArea = 'drawer'
        this.drawerFocusTarget = 'search'
        this.updateFocusPresentation()
        search.focus()
        const start = search.selectionStart ?? search.value.length
        const end = search.selectionEnd ?? start
        search.setRangeText(event.key, start, end, 'end')
        this.updateSearch(search)
        return true
    }

    private toggleFocusArea (): void {
        if (this.focusArea === 'drawer') {
            if (!this.focusCurrentTerminal()) {
                this.focusDrawerSearch()
                this.showMessage('当前没有活动终端，焦点保留在命令搜索。')
            }
            return
        }
        this.focusDrawerSearch()
    }

    private shouldRestoreDrawerFocusAfterRender (): boolean {
        const active = document.activeElement
        return Boolean(
            this.visible &&
            this.focusArea === 'drawer' &&
            active &&
            this.root?.contains(active)
        )
    }

    private restoreDrawerFocusAfterRender (shouldRestore: boolean): void {
        if (!shouldRestore || !this.visible || this.focusArea !== 'drawer') {
            return
        }
        window.requestAnimationFrame(() => {
            if (!this.visible || this.focusArea !== 'drawer') { return }
            const active = document.activeElement
            if (active instanceof Node && this.root?.contains(active)) { return }
            if (this.drawerFocusTarget === 'surface') {
                this.focusDrawerSurface()
            } else {
                this.root?.querySelector<HTMLInputElement>('[data-role="search"]')?.focus()
            }
        })
    }

    private updateFocusPresentation (): void {
        if (!this.root) { return }
        this.root.classList.toggle('tqc-focus-drawer', this.focusArea === 'drawer')
        this.root.classList.toggle('tqc-focus-terminal', this.focusArea === 'terminal')
        const rail = this.root.querySelector<HTMLElement>('.tqc-shortcut-rail')
        if (!rail) { return }
        const drawerFocused = this.focusArea === 'drawer'
        rail.classList.toggle('tqc-shortcut-rail-drawer', drawerFocused)
        rail.classList.toggle('tqc-shortcut-rail-terminal', !drawerFocused)
        rail.setAttribute('aria-label', this.i18n.text(`快捷键，当前${drawerFocused ? '抽屉焦点' : '终端焦点'}`))
        const focusLabel = rail.querySelector<HTMLElement>('[data-role="shortcut-rail-focus-label"]')
        if (focusLabel) {
            focusLabel.textContent = this.i18n.text(drawerFocused ? '终端' : '搜索')
        }
    }

    private getActionShortcuts (action: PluginHotkeyAction): string[] {
        return readPluginHotkeyBindings(this.config.store?.hotkeys, action)
            .filter((binding): binding is string => typeof binding === 'string')
            .map(binding => normalizeShortcut(binding))
            .filter(Boolean)
    }

    private handleMatchedPluginHotkey (hotkey: string): void {
        if (document.documentElement?.hasAttribute('data-windy-quick-commands-hotkey-recording')) {
            return
        }
        if (hotkey === pluginIdentity.toggleHotkeyId) {
            this.toggle()
            return
        }
        if (
            hotkey === pluginIdentity.hintsHotkeyId &&
            this.visible &&
            this.isForegroundDrawer()
        ) {
            this.toggleOperationHints()
            return
        }
        if (
            hotkey === pluginIdentity.focusHotkeyId &&
            this.visible &&
            this.isForegroundDrawer() &&
            !this.hasBlockingOverlay()
        ) {
            this.toggleFocusArea()
        }
    }

    private toggleOperationHints (): void {
        this.updateConfig({ showOperationHints: !this.state.showOperationHints })
    }

    private getPrimaryHotkeyLabel (action: PluginHotkeyAction): string {
        const binding = readPluginHotkeyBindings(this.config.store?.hotkeys, action)[0]
        return binding ? formatPluginHotkeyBinding(binding) : '未绑定'
    }

    private getCompactHotkeyLabel (binding: string): string {
        return binding
            .replace(/Control|Ctrl/gi, 'C')
            .replace(/Shift/gi, 'S')
            .replace(/Alt/gi, 'A')
            .replace(/Meta/gi, 'M')
            .replace(/Escape/gi, 'Esc')
            .replace(/\s*→\s*/g, '→')
    }

    private handleDocumentFocusIn (event: FocusEvent): void {
        if (!this.visible || !(event.target instanceof HTMLElement)) { return }
        if (this.root?.contains(event.target) && (this.isEditableElement(event.target) || this.isDrawerSurface(event.target))) {
            this.focusArea = 'drawer'
            if (this.isSearchInput(event.target)) {
                this.drawerFocusTarget = 'search'
            } else if (this.isDrawerSurface(event.target)) {
                this.drawerFocusTarget = 'surface'
            }
            this.updateFocusPresentation()
        } else if (this.isTerminalInput(event.target)) {
            this.focusArea = 'terminal'
            this.updateFocusPresentation()
        }
    }

    private isSearchInput (target: EventTarget | null): target is HTMLInputElement {
        return target instanceof HTMLInputElement && this.root?.contains(target) === true && target.dataset.role === 'search'
    }

    private isDrawerSurface (target: EventTarget | null): target is HTMLElement {
        return target instanceof HTMLElement && this.root?.contains(target) === true && target.dataset.role === 'drawer-surface'
    }

    private isDrawerInteractiveControl (target: EventTarget | null): boolean {
        return target instanceof Element && Boolean(target.closest(
            'button, input, textarea, select, label, a[href], [contenteditable="true"], [data-action]',
        ))
    }

    private getFocusedCommandId (target: EventTarget | null): string | null {
        if (!(target instanceof Element) || !this.root?.contains(target)) { return null }
        return target.closest<HTMLElement>('[data-command-id]')?.dataset.commandId || null
    }

    private hasBlockingOverlay (): boolean {
        return Boolean(
            this.importPreview || this.pendingRuleDeleteId || this.addingCommand || this.movingCommandId ||
            this.pendingDeleteId || this.editingCommandId || this.addingCategory || this.renamingCategory ||
            this.deletingCategory || this.pendingFailureMessage || this.pendingExecutionId,
        )
    }

    private dismissTopOverlay (): boolean {
        if (this.pendingFailureMessage) { return false }
        if (this.importPreview) { this.importPreview = null }
        else if (this.pendingRuleDeleteId) { this.pendingRuleDeleteId = null }
        else if (this.addingCommand) { this.addingCommand = false; this.resetNewCommandDraft() }
        else if (this.movingCommandId) { this.movingCommandId = null; this.moveTargetCategory = ''; this.moveCategoryMenuOpen = false }
        else if (this.pendingDeleteId) { this.pendingDeleteId = null }
        else if (this.editingCommandId) { this.editingCommandId = null; this.editCommandName = ''; this.editCommandDescription = '' }
        else if (this.addingCategory || this.renamingCategory) { this.addingCategory = false; this.renamingCategory = false; this.categoryInput = '' }
        else if (this.deletingCategory) { this.deletingCategory = false }
        else if (this.pendingExecutionId) { this.pendingExecutionId = null; this.confirmInput = '' }
        else { return false }
        this.render()
        return true
    }

    private handleDocumentClick (event: MouseEvent): void {
        if (!this.visible) {
            return
        }

        if (this.commandMenuOpen) {
            const menuShell = this.root?.querySelector<HTMLElement>('.tqc-command-menu-shell')
            if (!(event.target instanceof Node && menuShell?.contains(event.target))) {
                this.closeCommandMenu()
            }
        }

        if (this.categoryOverflowOpen) {
            const categories = this.root?.querySelector<HTMLElement>('.tqc-categories')
            if (!(event.target instanceof Node && categories?.contains(event.target))) {
                this.closeCategoryOverflowMenu()
            }
        }

        if (this.libraryMenuOpen) {
            const menuShell = this.root?.querySelector<HTMLElement>('.tqc-header-menu-shell')
            if (!(event.target instanceof Node && menuShell?.contains(event.target))) {
                this.closeLibraryMenu()
            }
        }

        if (this.categoryActionsOpen) {
            const menuShell = this.root?.querySelector<HTMLElement>('.tqc-category-action-menu-shell')
            if (!(event.target instanceof Node && menuShell?.contains(event.target))) {
                this.closeCategoryActionsMenu()
            }
        }

        if (this.automationRuleMenuKey) {
            const menuShell = Array.from(this.root?.querySelectorAll<HTMLElement>('[data-rule-menu-key]') || [])
                .find(element => element.dataset.ruleMenuKey === this.automationRuleMenuKey)
            if (!(event.target instanceof Node && menuShell?.contains(event.target))) {
                this.closeAutomationRuleMenu()
            }
        }
    }

    private closeCommandMenu (): void {
        this.commandMenuOpen = false
        const menuShell = this.root?.querySelector<HTMLElement>('.tqc-command-menu-shell')
        menuShell?.querySelector<HTMLElement>('.tqc-command-menu')?.remove()
        const toggle = menuShell?.querySelector<HTMLElement>('[data-action="toggle-command-menu"]')
        toggle?.classList.remove('tqc-active')
        toggle?.setAttribute('aria-expanded', 'false')
    }

    private closeCategoryOverflowMenu (): void {
        this.categoryOverflowOpen = false
        const categories = this.root?.querySelector<HTMLElement>('.tqc-categories')
        categories?.querySelector<HTMLElement>('.tqc-category-overflow-menu')?.remove()
        const toggle = categories?.querySelector<HTMLElement>('[data-action="toggle-category-overflow"]')
        toggle?.classList.remove('tqc-active')
        toggle?.setAttribute('aria-expanded', 'false')
    }

    private closeLibraryMenu (): void {
        this.libraryMenuOpen = false
        const menuShell = this.root?.querySelector<HTMLElement>('.tqc-header-menu-shell')
        menuShell?.querySelector<HTMLElement>('.tqc-action-menu')?.remove()
        const toggle = menuShell?.querySelector<HTMLElement>('[data-action="toggle-library-menu"]')
        toggle?.classList.remove('tqc-active')
        toggle?.setAttribute('aria-expanded', 'false')
    }

    private closeCategoryActionsMenu (): void {
        this.categoryActionsOpen = false
        const menuShell = this.root?.querySelector<HTMLElement>('.tqc-category-action-menu-shell')
        menuShell?.querySelector<HTMLElement>('.tqc-action-menu')?.remove()
        const toggle = menuShell?.querySelector<HTMLElement>('[data-action="toggle-category-actions"]')
        toggle?.classList.remove('tqc-active')
        toggle?.setAttribute('aria-expanded', 'false')
    }

    private closeAutomationRuleMenu (): void {
        const menuKey = this.automationRuleMenuKey
        this.automationRuleMenuKey = null
        if (!menuKey) {
            return
        }
        const menuShell = Array.from(this.root?.querySelectorAll<HTMLElement>('[data-rule-menu-key]') || [])
            .find(element => element.dataset.ruleMenuKey === menuKey)
        menuShell?.querySelector<HTMLElement>('.tqc-rule-menu')?.remove()
        const toggle = menuShell?.querySelector<HTMLElement>('[data-action="rule-menu-toggle"]')
        toggle?.setAttribute('aria-expanded', 'false')
    }

    private getTargetTabs (): TerminalTabLike[] {
        if (this.state.targetMode === 'all') {
            return this.getTerminalTabs()
        }

        const current = this.getCurrentTerminalTab()
        return current ? [current] : []
    }

    private getCurrentTerminalTab (): TerminalTabLike | null {
        let tab: any = this.app.activeTab
        if (tab && typeof tab.getFocusedTab === 'function') {
            tab = tab.getFocusedTab()
        }
        if (this.isTerminalTab(tab)) {
            return tab
        }
        return null
    }

    private getTerminalTabs (): TerminalTabLike[] {
        const result: TerminalTabLike[] = []
        const seen = new Set<TerminalTabLike>()
        const collect = (tab: any): void => {
            if (!tab) {
                return
            }
            if (typeof tab.getAllTabs === 'function') {
                tab.getAllTabs().forEach((child: any) => collect(child))
                return
            }
            if (this.isTerminalTab(tab) && !seen.has(tab)) {
                seen.add(tab)
                result.push(tab)
            }
        }

        this.app.tabs.forEach(tab => collect(tab))
        return result
    }

    private isTerminalTab (tab: any): tab is TerminalTabLike {
        return !!tab && typeof tab.sendInput === 'function'
    }

    private getTabTitle (tab: TerminalTabLike): string {
        return tab.title || tab.profile?.name || '未命名会话'
    }

    private getTargetKey (tab: TerminalTabLike): string {
        const existing = this.targetKeys.get(tab)
        if (existing) {
            return existing
        }
        const key = `target-${++this.nextTargetKey}`
        this.targetKeys.set(tab, key)
        return key
    }

    private isEditableElement (target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false
        }
        const tagName = target.tagName.toLowerCase()
        return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select'
    }

    private isTerminalInput (target: EventTarget | null): boolean {
        return target instanceof HTMLElement && (
            target.classList.contains('xterm-helper-textarea') ||
            Boolean(target.closest('.xterm'))
        )
    }

    private getFilteredCommands (category = this.state.selectedCategory): QuickCommand[] {
        const tokens = this.filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const filtered = this.state.commands.filter(command => {
            const categoryMatches = category === '全部' ||
                (category === '收藏'
                    ? command.favorite
                    : category === '常用'
                        ? command.usageCount > 0
                        : command.category === category)
            if (!categoryMatches) {
                return false
            }
            if (!tokens.length) {
                return true
            }
            return tokens.every(token => this.commandMatchesToken(command, token))
        })
        if (category === '常用') {
            return filtered.sort((a, b) => (
                b.usageCount - a.usageCount ||
                this.getTimeValue(b.lastUsedAt) - this.getTimeValue(a.lastUsedAt)
            ))
        }
        return filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned))
    }

    private moveKeyboardCommand (delta: -1 | 1): void {
        const commands = this.getFilteredCommands()
        if (!commands.length) { return }
        const currentId = this.renderedCommandId || this.state.selectedCommandId
        const matchedIndex = commands.findIndex(command => command.id === currentId)
        const currentIndex = matchedIndex >= 0 ? matchedIndex : (delta > 0 ? -1 : commands.length)
        const nextIndex = Math.max(0, Math.min(commands.length - 1, currentIndex + delta))
        const next = commands[nextIndex]
        if (!next || next.id === currentId) { return }
        this.focusArea = 'drawer'
        this.updateConfig({ selectedCommandId: next.id })
        this.scrollSelectedCommandIntoView()
    }

    private moveKeyboardCategory (delta: -1 | 1): void {
        const categories = this.getCategories()
        const currentIndex = Math.max(0, categories.indexOf(this.state.selectedCategory))
        const nextIndex = Math.max(0, Math.min(categories.length - 1, currentIndex + delta))
        const category = categories[nextIndex]
        if (!category || category === this.state.selectedCategory) { return }
        const commands = this.getFilteredCommands(category)
        this.focusArea = 'drawer'
        this.updateConfig({
            selectedCategory: category,
            selectedCommandId: commands[0]?.id || this.state.selectedCommandId,
        })
        this.scrollSelectedCommandIntoView()
        window.requestAnimationFrame(() => {
            this.root?.querySelector<HTMLElement>(`.tqc-chip[data-category="${this.escapeCssValue(category)}"]`)
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        })
    }

    private scrollSelectedCommandIntoView (): void {
        window.requestAnimationFrame(() => {
            const selectedId = this.renderedCommandId || this.state.selectedCommandId
            Array.from(this.root?.querySelectorAll<HTMLElement>('[data-command-id]') || [])
                .find(element => element.dataset.commandId === selectedId)
                ?.scrollIntoView({ block: 'nearest' })
        })
    }

    private escapeCssValue (value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    private commandMatchesToken (command: QuickCommand, token: string): boolean {
        return [
            command.name,
            command.description,
            command.category,
            command.shortcut,
            command.command,
        ].some(value => value.toLowerCase().includes(token))
    }

    private getSelectedCommand (pool?: QuickCommand[]): QuickCommand | null {
        const commands = pool || this.state.commands
        const selectedCommandId = pool ? this.state.selectedCommandId : (this.renderedCommandId || this.state.selectedCommandId)
        return resolveSelectedCommand(commands, selectedCommandId)
    }

    private getCategories (): string[] {
        return this.getOrderedCategories()
    }

    private getOrderedRealCategories (): string[] {
        const all = Array.from(new Set([
            ...this.state.customCategories,
            ...this.state.commands.map(command => command.category).filter(Boolean),
        ].filter(category => category && !this.isSystemCategory(category))))
        const known = this.state.categoryOrder.filter(category => all.includes(category))
        const remaining = all.filter(category => !known.includes(category))
        return [...known, ...remaining]
    }

    private getOrderedCategories (): string[] {
        const all = ['全部', '常用', '收藏', ...this.getOrderedRealCategories()]
        const known = this.state.categoryOrder.filter(category => all.includes(category))
        const remaining = all.filter(category => !known.includes(category))
        return [...known, ...remaining]
    }

    private isSystemCategory (category: string): boolean {
        return category === '全部' || category === '常用' || category === '收藏'
    }

    private getCategoryLabel (category: string): string {
        return this.isSystemCategory(category) ? this.i18n.text(category) : category
    }

    private canDragCategory (category: string): boolean {
        return !!category
    }

    private getHint (command: QuickCommand | null, targetCount: number, danger: boolean): string {
        if (!command) {
            return '先选择或新建一条命令。'
        }
        if (danger) {
            return this.state.confirmHighRiskCommands !== false
                ? '命令包含删除、重启、清理或数据库高风险关键字，执行前会二次确认。'
                : '已检测到高风险命令；当前设置不会因此单独弹出确认。'
        }
        if (targetCount > 1) {
            return '多会话发送会在执行前二次确认。'
        }
        if (this.state.executionMode === 'line') {
            return '逐行模式支持为每一行设置延迟和执行后暂停。'
        }
        return '粘贴模式会把命令发送到目标会话，可选择是否自动回车。'
    }

    private getDanger (command: string) {
        return getDangerCheck(command)
    }

    private buildExecutionSummary (command: QuickCommand, targets: TerminalTabLike[]): ExecutionSummary {
        const danger = this.getDanger(command.command)
        const targetNames = targets.map(target => this.getTabTitle(target))
        const confirmHighRiskCommands = this.state.confirmHighRiskCommands !== false
        const requiresTypedConfirm = confirmHighRiskCommands && danger.requiresTypedConfirm
        const requiredText = command.name
        const allSessions = this.state.targetMode === 'all' || targets.length > 1
        return {
            modeLabel: this.getExecutionModeLabel(),
            targetCount: targets.length,
            targetNames,
            lineCount: this.state.executionMode === 'line'
                ? getExecutableLineCount(command)
                : command.command.split(/\r?\n/).filter(line => line.trim()).length || 1,
            autoEnter: command.autoEnter,
            danger: danger.dangerous,
            reasons: danger.reasons,
            requiresTypedConfirm,
            requiredText,
            requiresConfirm: this.state.requireConfirmBeforeExecute ||
                (confirmHighRiskCommands && danger.dangerous) ||
                (this.state.confirmBroadcast && allSessions),
        }
    }

    private getExecutionModeLabel (): string {
        switch (this.state.executionMode) {
            case 'line':
                return '逐行执行'
            default:
                return '原样发送'
        }
    }

    private findShortcutConflict (
        shortcut: string,
        currentCommandId: string,
    ): ReturnType<typeof findShortcutConflict> | { kind: 'plugin' | 'drawer', name: string } {
        const bindingId = pluginHotkeyBindingId(shortcut)
        const drawerConflict = reservedQuickCommandsShortcuts.find(item => (
            normalizeShortcut(item.shortcut) === bindingId
        ))
        if (drawerConflict) {
            return { kind: 'drawer', name: drawerConflict.name }
        }
        const pluginConflict = pluginHotkeyDefinitions.find(definition => (
            readPluginHotkeyBindings(this.config.store?.hotkeys, definition.action)
                .some(binding => pluginHotkeyBindingId(binding) === bindingId)
        ))
        if (pluginConflict) {
            return { kind: 'plugin', name: pluginConflict.title }
        }
        const pluginIds = new Set(pluginHotkeyDefinitions.map(definition => definition.id))
        const tabbyHotkeys = flattenHotkeysConfig(this.config.store?.hotkeys)
            .filter(item => !pluginIds.has(item.name))
            .map(item => ({ ...item, name: this.getTabbyHotkeyName(item.name) }))
        return findShortcutConflict(
            shortcut,
            this.state.commands.map(command => ({
                id: command.id,
                name: command.name,
                shortcut: command.shortcut,
            })),
            currentCommandId,
            tabbyHotkeys,
        )
    }

    private getTabbyHotkeyName (id: string): string {
        try {
            return this.hotkeys?.getHotkeyDescription(id)?.name || id
        } catch {
            return id
        }
    }

    private updateUsage (commandId: string): void {
        const commands = this.state.commands.map(command => (
            command.id === commandId
                ? { ...command, usageCount: command.usageCount + 1, lastUsedAt: new Date().toISOString() }
                : command
        ))
        this.runtimeStore.setStats(this.buildUsageStats(commands))
        this.updateConfig({ commands }, false)
    }

    private buildUsageStats (commands: QuickCommand[]): CommandUsageStats {
        return commands.reduce<CommandUsageStats>((stats, command) => {
            stats[command.id] = {
                usageCount: Math.max(0, Number(command.usageCount) || 0),
                lastUsedAt: command.lastUsedAt || null,
            }
            return stats
        }, {})
    }

    private addLog (
        level: AutomationLogEntry['level'],
        message: string,
        commandId?: string,
        line?: number,
        context: Pick<AutomationLogEntry, 'mode' | 'targetNames' | 'durationMs'> & {
            action?: string
            status?: ActivityLogStatus
        } = {},
    ): void {
        const command = commandId ? this.state.commands.find(item => item.id === commandId) : undefined
        const retention = normalizeActivityLogRetention(this.state as unknown as Record<string, unknown>)
        this.activityLog.record({
            level,
            message,
            category: 'execution',
            action: context.action || 'execution.event',
            status: context.status,
            subject: command ? { type: 'command', id: command.id, name: command.name } : undefined,
            commandId,
            commandName: command?.name,
            commandText: command?.command,
            line,
            ...context,
        }, retention)
        this.state.automationLogs = this.activityLog.getEntries()
        this.notifyActivityLogSizeWarning(retention)
    }

    private recordActivity (draft: ActivityLogDraft): void {
        const retention = normalizeActivityLogRetention(this.state as unknown as Record<string, unknown>)
        this.activityLog.record(draft, retention)
        this.state.automationLogs = this.activityLog.getEntries()
        this.notifyActivityLogSizeWarning(retention)
    }

    private notifyActivityLogSizeWarning (retention: ReturnType<typeof normalizeActivityLogRetention>): void {
        const warning = retention.mode === 'unlimited' && this.activityLog.hasSizeWarning(retention)
        if (!warning) {
            this.activityLogSizeWarningShown = false
            return
        }
        if (this.activityLogSizeWarningShown) { return }
        this.activityLogSizeWarningShown = true
        const warningValue = activityLogSizeValue(retention.warningSizeMb, retention.warningSizeUnit)
        window.setTimeout(() => this.showMessage(`活动日志已超过 ${warningValue} ${retention.warningSizeUnit}，请前往设置清理或改用自动限制。`))
    }

    private readConfig (reload = false): QuickCommandsConfig {
        const defaults = createDefaultQuickCommandsConfig(this.i18n.language)
        const root = this.pluginConfigStore.load(defaults, reload) as any
        const storedCommands = Array.isArray(root.commands)
            ? root.commands.map((command: Partial<QuickCommand>) => this.normalizeStoredCommand(command))
            : defaults.commands.map(command => this.normalizeStoredCommand(command))
        const usageStats = this.runtimeStore.getStats()
        const commands = storedCommands.map(command => ({
            ...command,
            usageCount: usageStats[command.id]?.usageCount || 0,
            lastUsedAt: usageStats[command.id]?.lastUsedAt || null,
        }))
        return {
            commands,
            customCategories: Array.isArray(root.customCategories)
                ? root.customCategories.filter((category: string) => category !== '常用')
                : [],
            categoryOrder: Array.isArray(root.categoryOrder)
                ? root.categoryOrder
                : [],
            selectedCommandId: root.selectedCommandId || commands[0]?.id || null,
            selectedCategory: root.selectedCategory || '全部',
            executionMode: root.executionMode === 'line' ? 'line' : 'paste',
            targetMode: root.executionMode === 'broadcast' || root.targetMode === 'all' ? 'all' : 'current',
            failureStrategy: root.failureStrategy === 'continue' || root.failureStrategy === 'stop'
                ? root.failureStrategy
                : 'manual',
            drawerWidth: this.clampWidth(root.drawerWidth || 560),
            showToolbarButton: root.showToolbarButton !== false,
            drawerInitialFocus: root.drawerInitialFocus === 'terminal' ? 'terminal' : 'drawer',
            focusTerminalAfterSend: root.focusTerminalAfterSend ?? false,
            showOperationHints: root.showOperationHints ?? true,
            requireConfirmBeforeExecute: root.requireConfirmBeforeExecute ?? false,
            confirmHighRiskCommands: root.confirmHighRiskCommands ?? true,
            confirmBroadcast: root.confirmBroadcast ?? true,
            exportFileName: root.exportFileName || pluginIdentity.exportFileName,
            basicInfoCollapsed: root.basicInfoCollapsed ?? true,
            moreSettingsCollapsed: root.moreSettingsCollapsed ?? true,
            previewCollapsed: root.previewCollapsed ?? false,
            moveNavigateAfterMove: root.moveNavigateAfterMove ?? false,
            recentOutputLimit: Math.max(1000, Number(root.recentOutputLimit) || 8000),
            logLimit: Math.max(20, Math.min(20000, Number(root.logLimit) || 200)),
            logRetentionMode: root.logRetentionMode === 'days' || root.logRetentionMode === 'size' || root.logRetentionMode === 'unlimited'
                ? root.logRetentionMode
                : 'count',
            logRetentionDays: Math.max(1, Math.min(3650, Number(root.logRetentionDays) || 30)),
            logSizeLimitMb: Math.max(1, Math.min(102400, Number(root.logSizeLimitMb) || 10)),
            logWarningSizeMb: Math.max(1, Math.min(102400, Number(root.logWarningSizeMb) || 10)),
            logSizeUnit: root.logSizeUnit === 'GB' ? 'GB' : 'MB',
            logWarningSizeUnit: root.logWarningSizeUnit === 'GB' ? 'GB' : 'MB',
            updateCheckInterval: root.updateCheckInterval === 'startup' || root.updateCheckInterval === 'weekly' || root.updateCheckInterval === 'never'
                ? root.updateCheckInterval
                : 'daily',
            ignoredUpdateVersion: typeof root.ignoredUpdateVersion === 'string' ? root.ignoredUpdateVersion : '',
            automationLogs: this.activityLog.getEntries(),
        }
    }

    private stripCommandRuntime (command: QuickCommand): Omit<QuickCommand, 'usageCount' | 'lastUsedAt'> {
        const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
        return stored
    }

    private normalizeStoredCommand (command: Partial<QuickCommand>): QuickCommand {
        const normalized = normalizeCommandConfig(command, () => this.createId())
        if (normalized.category === '常用') {
            return {
                ...normalized,
                category: '默认',
            }
        }
        return normalized
    }

    private updateConfig (patch: Partial<QuickCommandsConfig>, save = true, shouldRender = true): void {
        const next: QuickCommandsConfig = {
            ...this.state,
            ...patch,
        }
        if (!next.commands.some(command => command.id === next.selectedCommandId)) {
            next.selectedCommandId = next.commands[0]?.id || null
        }
        if (patch.commands && this.commandIdsChanged(this.state.commands, next.commands)) {
            this.runtimeStore.setStats(this.buildUsageStats(next.commands))
        }
        const root = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language))
        root.commands = next.commands.map(command => this.stripCommandRuntime(command))
        root.customCategories = next.customCategories
        root.categoryOrder = next.categoryOrder
        root.selectedCommandId = next.selectedCommandId
        root.selectedCategory = next.selectedCategory
        root.executionMode = next.executionMode
        root.targetMode = next.targetMode
        root.failureStrategy = next.failureStrategy
        root.drawerWidth = next.drawerWidth
        root.showToolbarButton = next.showToolbarButton
        root.drawerInitialFocus = next.drawerInitialFocus
        root.focusTerminalAfterSend = next.focusTerminalAfterSend
        root.showOperationHints = next.showOperationHints
        root.requireConfirmBeforeExecute = next.requireConfirmBeforeExecute
        root.confirmHighRiskCommands = next.confirmHighRiskCommands
        root.confirmBroadcast = next.confirmBroadcast
        root.exportFileName = next.exportFileName
        root.basicInfoCollapsed = next.basicInfoCollapsed
        root.moreSettingsCollapsed = next.moreSettingsCollapsed
        root.previewCollapsed = next.previewCollapsed
        root.moveNavigateAfterMove = next.moveNavigateAfterMove
        delete root.safetyWhitelist
        delete root.safetyBlacklist
        delete root.productionNamePatterns
        delete root.highRiskConfirmText
        root.recentOutputLimit = next.recentOutputLimit
        root.logLimit = next.logLimit
        root.logRetentionMode = next.logRetentionMode
        root.logRetentionDays = next.logRetentionDays
        root.logSizeLimitMb = next.logSizeLimitMb
        root.logWarningSizeMb = next.logWarningSizeMb
        root.logSizeUnit = next.logSizeUnit
        root.logWarningSizeUnit = next.logWarningSizeUnit
        root.updateCheckInterval = next.updateCheckInterval
        root.ignoredUpdateVersion = next.ignoredUpdateVersion
        this.setPluginConfig(root, save)
        this.state = this.readConfig()
        if (shouldRender) {
            this.render()
        }
    }

    private persistPluginConfig (): void {
        if (!this.pluginConfigDirty) {
            return
        }
        this.pendingPluginConfigWrite = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language))
        this.flushPluginConfigWrite()
    }

    private setPluginConfig (config: Record<string, unknown>, persist = true): void {
        this.pluginConfigStore.set(config, false)
        this.pluginConfigDirty = true
        if (!persist) {
            if (this.pluginConfigWriteTimer) {
                this.pendingPluginConfigWrite = config
            }
            return
        }
        this.pendingPluginConfigWrite = config
        if (this.pluginConfigWriteTimer) {
            window.clearTimeout(this.pluginConfigWriteTimer)
        }
        this.pluginConfigWriteTimer = window.setTimeout(() => {
            this.pluginConfigWriteTimer = null
            this.flushPluginConfigWrite()
        }, this.pluginConfigWriteDelay)
    }

    private flushPluginConfigWrite (): void {
        if (this.pluginConfigWriteTimer) {
            window.clearTimeout(this.pluginConfigWriteTimer)
            this.pluginConfigWriteTimer = null
        }
        if (!this.pluginConfigDirty) {
            this.pendingPluginConfigWrite = null
            return
        }
        const config = this.pendingPluginConfigWrite || this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language))
        this.writingPluginConfig = true
        try {
            this.pluginConfigStore.set(config)
            this.pluginConfigDirty = false
            this.pendingPluginConfigWrite = null
        } finally {
            this.writingPluginConfig = false
        }
    }

    private cancelScheduledPluginConfigWrite (): void {
        if (this.pluginConfigWriteTimer) {
            window.clearTimeout(this.pluginConfigWriteTimer)
            this.pluginConfigWriteTimer = null
        }
        this.pendingPluginConfigWrite = null
    }

    private commandIdsChanged (previous: QuickCommand[], next: QuickCommand[]): boolean {
        if (previous.length !== next.length) {
            return true
        }
        const previousIds = new Set(previous.map(command => command.id))
        return next.some(command => !previousIds.has(command.id))
    }

    private showMessage (message: string): void {
        this.message = message
        this.render()
        window.setTimeout(() => {
            if (this.message === message) {
                this.message = ''
                this.render()
            }
        }, 2600)
    }

    private createId (): string {
        return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    private clampWidth (width: number): number {
        return Math.max(420, Math.min(760, Number(width) || 520))
    }

    private escape (value: string): string {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
    }

    private escapeAttr (value: string): string {
        return this.escape(value).replace(/"/g, '&quot;')
    }

    private getTimeValue (isoTime: string | null): number {
        if (!isoTime) {
            return 0
        }
        const time = new Date(isoTime).getTime()
        return Number.isNaN(time) ? 0 : time
    }
}
