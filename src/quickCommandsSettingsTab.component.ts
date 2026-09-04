import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, Optional } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService, HotkeysService, PlatformService } from 'tabby-core'
import {
    applyImportPreview,
    buildImportPreview,
    normalizeCommandConfig,
    sanitizeAutomationReferences,
} from './commandLibrary'
import { CommandUsageStats, QuickCommandsRuntimeStore, runtimeChangedEvent } from './runtimeStorage'
import { defaultQuickCommandsConfig, createDefaultQuickCommandsConfig } from './configProvider'
import {
    buildDefaultSettingsConfig,
    PluginConfigImportFile,
    pluginConfigChangedEvent,
    QuickCommandsPluginConfigStore,
} from './pluginConfigStorage'
import { QuickCommand } from './types'
import { QuickCommandsI18n } from './i18n'
import { PluginUpdateHistoryState, PluginUpdateState, QuickCommandsPluginUpdateService } from './pluginUpdate.service'
import { UpdateCheckInterval } from './pluginUpdate'
import { pluginIdentity } from './pluginIdentity'
import { pluginDataResetEvent } from './pluginData'
import { QuickCommandsService } from './quickCommands.service'
import {
    flattenHotkeysConfig,
    isValidShortcut,
    normalizeShortcut,
    normalizeShortcutKey,
    reservedTabbyShortcuts,
    shortcutFromKeyboardEvent,
} from './shortcutManager'
import {
    applyPluginHotkeyExport,
    buildDefaultPluginHotkeyExport,
    buildPluginHotkeyExport,
    findPluginHotkeyConflict,
    formatPluginHotkeyBinding,
    parsePluginHotkeyExport,
    PluginHotkeyAction,
    PluginHotkeyBinding,
    PluginHotkeyDefinition,
    pluginHotkeyBindingId,
    pluginHotkeyDefinitions,
    PluginHotkeyExport,
    readPluginHotkeyBindings,
    reservedQuickCommandsShortcuts,
} from './pluginHotkeys'
import { ActivityLogService } from './activityLog/activityLog.service'
import { normalizeActivityLogRetention } from './activityLog/activityLog.retention'
import { ActivityLogDraft, ActivityLogEntry, ActivityLogRetentionSettings } from './activityLog/activityLog.types'

const historyDateFormatters = {
    'zh-CN': new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    en: new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
}

interface HotkeyConflictCache {
    pluginActions: Map<PluginHotkeyAction, string>
    pluginBindings: Map<string, string>
    commands: Map<string, string>
}

@Component({
    selector: 'quick-commands-settings-tab',
    template: `
      <div class="wqc-settings">
        <header class="wqc-header">
          <div>
            <h3>{{ pluginTitle }}</h3>
            <div class="wqc-muted">{{ commandCount }} 条命令，{{ logCount }} 条活动日志</div>
          </div>
          <label class="wqc-header-toggle" title="修改后重启 Tabby 生效；隐藏按钮后仍可使用快捷键">
            <input class="wqc-command-check" type="checkbox" [checked]="root.showToolbarButton !== false" (change)="setToolbarButtonVisibility($event)">
            <span>显示右上角按钮</span>
            <small>重启后生效</small>
          </label>
        </header>

        <div class="wqc-plugin-intro">
          <div class="wqc-plugin-title-row">
            <strong class="wqc-plugin-title">Tabby Windy Quick Commands</strong>
            <span class="wqc-plugin-version">v{{ updateState.currentVersion }}</span>
          </div>
          <p>在 Tabby 中集中管理和执行常用终端命令，支持分类搜索、快捷键、多会话发送、逐行执行、输出触发器以及命令库导入导出。</p>
          <div class="wqc-plugin-note">可能存在大量的bug还有一些没考虑的，见谅🫨可以提issue，慢慢改~</div>

          <div class="wqc-plugin-footer">
            <nav class="wqc-plugin-links" aria-label="项目链接">
              <a [href]="projectUrl" (click)="openExternal($event, projectUrl)">GitHub 仓库</a>
              <a [href]="issuesUrl" (click)="openExternal($event, issuesUrl)">问题反馈</a>
            </nav>
            <div class="wqc-update-card-check">
              <span class="wqc-status-tooltip" *ngIf="updateStatusLabel">
                <button class="wqc-update-feedback wqc-update-feedback-link" type="button" [class.wqc-update-error]="updateState.status === 'error'" aria-describedby="wqc-update-status-tooltip" (click)="scrollToUpdateSettings()">{{ updateStatusLabel }}</button>
                <span class="wqc-help-tooltip wqc-status-tooltip-content" id="wqc-update-status-tooltip" role="tooltip">点击跳转到底部更新设置</span>
              </span>
              <button class="btn btn-secondary wqc-check-update" type="button" [disabled]="updateState.status === 'checking' || updateState.status === 'installing'" (click)="checkForUpdates()">检查更新</button>
            </div>
          </div>
        </div>

        <section class="wqc-section wqc-config-section">
          <div class="wqc-section-head">
            <div>
              <h4>插件配置</h4>
              <div class="wqc-muted">导出或恢复命令、分类、触发器和所有插件设置；活动日志与使用统计不包含在内。</div>
            </div>
          </div>
          <div class="wqc-config-actions">
            <div class="wqc-config-transfer">
              <button class="btn btn-secondary" type="button" aria-haspopup="dialog" [attr.aria-expanded]="exportConfigDialogOpen" (click)="openExportPluginConfig()">导出</button>
              <button class="btn btn-secondary" type="button" (click)="pluginConfigFile.click()">导入</button>
            </div>
            <div class="wqc-config-feedback">
              <div class="wqc-config-message" *ngIf="configMessage" role="status">
                <span class="wqc-config-message-text" [class.wqc-config-message-has-detail]="configMessageDetail" [attr.tabindex]="configMessageDetail ? 0 : null" [attr.aria-describedby]="configMessageDetail ? 'wqc-config-message-detail' : null">
                  {{ configMessage }}
                  <span class="wqc-help-tooltip wqc-config-message-tooltip" *ngIf="configMessageDetail" id="wqc-config-message-detail" role="tooltip">
                    <span class="wqc-config-message-tooltip-body">{{ configMessageDetail }}</span>
                  </span>
                </span>
                <button class="wqc-config-message-close" type="button" aria-label="关闭提示" (click)="dismissConfigMessage()">×</button>
              </div>
              <button class="btn wqc-danger-button wqc-reset-config" type="button" (click)="openResetDefaultsConfirm()">恢复默认配置</button>
            </div>
            <input #pluginConfigFile class="wqc-hidden-file" type="file" accept="application/json,.json" (change)="importPluginConfig($event)">
          </div>
        </section>

        <section class="wqc-section wqc-hotkey-section">
          <div class="wqc-hotkey-summary-row">
            <div class="wqc-hotkey-summary-copy">
              <h4>快捷键</h4>
              <div class="wqc-hotkey-summary-meta">
                <span>{{ configuredPluginHotkeyActionCount }} / {{ pluginHotkeyDefinitions.length }} 插件操作</span>
                <span aria-hidden="true">·</span>
                <span>{{ configuredCommandHotkeyCount }} / {{ commandCount }} 命令已绑定</span>
                <span aria-hidden="true">·</span>
                <span *ngIf="!hotkeyConflictCount">无冲突</span>
                <span class="wqc-hotkey-summary-warning" *ngIf="hotkeyConflictCount">{{ hotkeyConflictCount }} 项冲突</span>
              </div>
            </div>
            <button class="wqc-hotkey-manage" type="button" aria-label="管理快捷键" aria-haspopup="dialog" [attr.aria-expanded]="pluginHotkeyDialogOpen" (click)="openPluginHotkeyDialog()">
              <span class="wqc-hotkey-manage-label">
                <svg class="wqc-hotkey-manage-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2.25" y="3.5" width="11.5" height="9" rx="1.5"></rect>
                  <path d="M4.5 6h.01M7 6h.01M9.5 6h.01M12 6h.01M4.5 8.5h.01M7 8.5h.01M9.5 8.5H12"></path>
                </svg>
                <span>管理</span>
              </span>
              <svg class="wqc-hotkey-manage-chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 3.75 4.25 4.25L6 12.25"></path>
              </svg>
            </button>
          </div>
        </section>

        <div class="wqc-config-dialog-backdrop wqc-hotkey-dialog-backdrop" *ngIf="pluginHotkeyDialogOpen" (click)="closePluginHotkeyDialog()">
          <section class="wqc-config-dialog wqc-hotkey-dialog" role="dialog" aria-modal="true" aria-labelledby="wqc-hotkey-dialog-title" (click)="$event.stopPropagation()">
            <header class="wqc-hotkey-dialog-header">
              <h4 id="wqc-hotkey-dialog-title">快捷键设置</h4>
              <div class="wqc-hotkey-dialog-header-actions">
                <span class="wqc-help wqc-hotkey-rules" tabindex="0" aria-label="查看快捷键规则" aria-describedby="wqc-hotkey-rules-tooltip">
                  <span class="wqc-help-icon" aria-hidden="true">?</span>
                  <span class="wqc-help-tooltip wqc-hotkey-rules-tooltip" id="wqc-hotkey-rules-tooltip" role="tooltip">
                    <strong>快捷键规则</strong>
                    <span>F1–F24 可以单独绑定，也可以与 Shift、Ctrl、Alt 或 Meta 组合。</span>
                    <span>字母、数字、方向键等必须包含 Ctrl、Alt 或 Meta；不支持仅用 Shift 与普通键组合。</span>
                    <span>切换焦点还可以单独使用 Escape。</span>
                  </span>
                </span>
                <button class="wqc-hotkey-dialog-close" type="button" aria-label="关闭快捷键设置" [disabled]="pluginHotkeySaving" (click)="closePluginHotkeyDialog()">×</button>
              </div>
            </header>

            <div class="wqc-hotkey-search" role="search">
              <div class="wqc-hotkey-search-field">
                <svg class="wqc-hotkey-search-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.25"></circle>
                  <path d="m10.25 10.25 3 3"></path>
                </svg>
                <input class="form-control wqc-hotkey-search-input" type="search" placeholder="搜索功能、范围或快捷键" aria-label="搜索快捷键设置" [value]="pluginHotkeySearchQuery" (input)="setPluginHotkeySearch($event)">
                <button class="wqc-hotkey-search-clear" type="button" aria-label="清空快捷键搜索" *ngIf="pluginHotkeySearchQuery" (click)="clearPluginHotkeySearch()">×</button>
              </div>
              <button class="btn btn-secondary wqc-hotkey-restore-all" type="button" [disabled]="pluginHotkeySaving || pluginHotkeyDraftIsDefault" (click)="resetAllPluginHotkeys()">恢复默认</button>
            </div>

            <div class="wqc-hotkey-table-wrap" (scroll)="hideHotkeyCommandTooltip()">
              <table class="wqc-hotkey-table">
                <thead>
                  <tr>
                    <th scope="col">功能</th>
                    <th scope="col">生效范围</th>
                    <th scope="col">当前快捷键</th>
                    <th scope="col">状态</th>
                    <th scope="col" class="wqc-hotkey-action-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr class="wqc-hotkey-group-row" *ngIf="filteredPluginHotkeyDefinitions.length || !pluginHotkeySearchQuery">
                    <th colspan="5" scope="rowgroup">
                      <span>插件操作</span>
                      <small>{{ filteredPluginHotkeyDefinitions.length }}</small>
                    </th>
                  </tr>
                  <tr *ngFor="let item of filteredPluginHotkeyDefinitions" [class.wqc-hotkey-row-recording]="recordingHotkeyAction === item.action">
                    <td class="wqc-hotkey-function-cell">
                      <div class="wqc-hotkey-function-content">
                        <strong>{{ item.title }}</strong>
                        <small>{{ item.description }}</small>
                      </div>
                    </td>
                    <td><span class="wqc-hotkey-scope">{{ item.scope }}</span></td>
                    <td>
                      <div class="wqc-hotkey-capture-preview" role="status" aria-live="polite" *ngIf="recordingHotkeyAction === item.action">
                        <span class="wqc-hotkey-capture-waiting" *ngIf="!recordingPressedKeys.length">等待按键…</span>
                        <ng-container *ngFor="let key of recordingPressedKeys; index as keyIndex">
                          <span class="wqc-hotkey-capture-plus" aria-hidden="true" *ngIf="keyIndex">+</span>
                          <kbd class="wqc-hotkey-capture-key">{{ key }}</kbd>
                        </ng-container>
                      </div>
                      <ng-container *ngIf="recordingHotkeyAction !== item.action">
                        <div class="wqc-hotkey-bindings" *ngIf="getPluginHotkeys(item.action).length; else noPluginHotkey">
                          <span class="wqc-hotkey-binding" *ngFor="let binding of getPluginHotkeys(item.action); index as bindingIndex" [class.wqc-hotkey-binding-conflict]="getPluginHotkeyConflict(item.action, binding)" [class.wqc-hotkey-binding-captured]="isRecentlyCapturedPluginHotkey(item.action, binding)">
                            <kbd>{{ formatPluginHotkey(binding) }}</kbd>
                            <button type="button" aria-label="删除快捷键" [disabled]="pluginHotkeySaving" (click)="removePluginHotkey(item.action, bindingIndex)">×</button>
                          </span>
                        </div>
                        <ng-template #noPluginHotkey><span class="wqc-hotkey-empty">未绑定</span></ng-template>
                      </ng-container>
                    </td>
                    <td class="wqc-hotkey-status-cell">
                      <span class="wqc-hotkey-conflict-state" *ngIf="getPluginHotkeyStatus(item.action) as conflict">
                        <span class="wqc-hotkey-conflict">冲突</span>
                        <button class="wqc-hotkey-conflict-detail" type="button" [attr.aria-label]="'冲突详情：' + conflict">
                          详情
                          <span class="wqc-help-tooltip wqc-hotkey-conflict-tooltip" role="tooltip">{{ conflict }}</span>
                        </button>
                      </span>
                      <span class="wqc-hotkey-status-ok" *ngIf="!getPluginHotkeyStatus(item.action) && getPluginHotkeys(item.action).length">正常</span>
                      <span class="wqc-hotkey-empty" *ngIf="!getPluginHotkeys(item.action).length">未绑定</span>
                    </td>
                    <td class="wqc-hotkey-action-cell">
                      <div class="wqc-hotkey-row-actions">
                        <button class="btn btn-secondary" type="button" [disabled]="pluginHotkeySaving" [class.wqc-hotkey-recording]="recordingHotkeyAction === item.action" (click)="startPluginHotkeyCapture(item.action, $event)">
                          {{ recordingHotkeyAction === item.action ? '录制中…' : '添加' }}
                        </button>
                        <button class="wqc-hotkey-clear" type="button" [disabled]="pluginHotkeySaving || !getPluginHotkeys(item.action).length" (click)="clearPluginHotkey(item.action)">清除</button>
                      </div>
                    </td>
                  </tr>
                  <tr class="wqc-hotkey-group-row wqc-command-hotkey-group" *ngIf="filteredCommandHotkeyCommands.length || !pluginHotkeySearchQuery">
                    <th colspan="5" scope="rowgroup">
                      <button class="wqc-hotkey-group-toggle" type="button" [attr.aria-expanded]="commandHotkeyRowsVisible" (click)="toggleCommandHotkeySection()">
                        <span class="wqc-hotkey-group-label">
                          <span>命令快捷键</span>
                          <small>{{ filteredCommandHotkeyCommands.length }}</small>
                        </span>
                        <span class="wqc-hotkey-group-toggle-action">
                          <span>{{ commandHotkeySectionExpanded ? '收起' : '展开' }}</span>
                          <svg class="wqc-hotkey-group-chevron" [class.wqc-expanded]="commandHotkeySectionExpanded" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="m4 6 4 4 4-4"></path>
                          </svg>
                        </span>
                      </button>
                    </th>
                  </tr>
                  <ng-container *ngIf="commandHotkeyRowsVisible">
                    <tr *ngFor="let command of filteredCommandHotkeyCommands" [class.wqc-hotkey-row-recording]="recordingCommandHotkeyId === command.id">
                      <td class="wqc-hotkey-function-cell">
                        <div class="wqc-hotkey-function-content">
                          <strong data-i18n-skip>{{ command.name }}</strong>
                          <small data-i18n-skip>{{ command.description || command.command }}</small>
                        </div>
                      </td>
                      <td><span class="wqc-hotkey-scope">Tabby全局</span></td>
                      <td>
                        <div class="wqc-hotkey-capture-preview" role="status" aria-live="polite" *ngIf="recordingCommandHotkeyId === command.id">
                          <span class="wqc-hotkey-capture-waiting" *ngIf="!recordingPressedKeys.length">等待按键…</span>
                          <ng-container *ngFor="let key of recordingPressedKeys; index as keyIndex">
                            <span class="wqc-hotkey-capture-plus" aria-hidden="true" *ngIf="keyIndex">+</span>
                            <kbd class="wqc-hotkey-capture-key">{{ key }}</kbd>
                          </ng-container>
                        </div>
                        <ng-container *ngIf="recordingCommandHotkeyId !== command.id">
                          <span class="wqc-hotkey-binding wqc-command-hotkey-binding" *ngIf="getCommandHotkey(command.id) as shortcut; else noCommandHotkey" [class.wqc-hotkey-binding-captured]="isRecentlyCapturedCommandHotkey(command.id, shortcut)">
                            <kbd>{{ shortcut }}</kbd>
                          </span>
                          <ng-template #noCommandHotkey><span class="wqc-hotkey-empty">未绑定</span></ng-template>
                        </ng-container>
                      </td>
                      <td class="wqc-hotkey-status-cell">
                        <span class="wqc-hotkey-conflict-state" *ngIf="getCommandHotkeyConflict(command.id) as conflict">
                          <span class="wqc-hotkey-conflict">冲突</span>
                          <button class="wqc-hotkey-conflict-detail" type="button" [attr.aria-label]="'冲突详情：' + conflict">
                            详情
                            <span class="wqc-help-tooltip wqc-hotkey-conflict-tooltip" role="tooltip">{{ conflict }}</span>
                          </button>
                        </span>
                        <span class="wqc-hotkey-status-ok" *ngIf="!getCommandHotkeyConflict(command.id) && getCommandHotkey(command.id)">正常</span>
                        <span class="wqc-hotkey-empty" *ngIf="!getCommandHotkey(command.id)">未绑定</span>
                      </td>
                      <td class="wqc-hotkey-action-cell">
                        <div class="wqc-hotkey-row-actions">
                          <button class="btn btn-secondary" type="button" [disabled]="pluginHotkeySaving" [class.wqc-hotkey-recording]="recordingCommandHotkeyId === command.id" (click)="startCommandHotkeyCapture(command.id, $event)">
                            {{ recordingCommandHotkeyId === command.id ? '录制中…' : (getCommandHotkey(command.id) ? '修改' : '添加') }}
                          </button>
                          <button class="wqc-hotkey-clear" type="button" [disabled]="pluginHotkeySaving || !getCommandHotkey(command.id)" (click)="clearCommandHotkey(command.id)">清除</button>
                          <button class="wqc-hotkey-command-open" type="button" [disabled]="pluginHotkeySaving" [attr.aria-label]="'打开命令：' + command.name" aria-describedby="wqc-hotkey-command-floating-tooltip" (mouseenter)="showHotkeyCommandTooltip($event)" (mouseleave)="hideHotkeyCommandTooltip()" (focus)="showHotkeyCommandTooltip($event)" (blur)="hideHotkeyCommandTooltip()" (click)="openCommandFromHotkeyDialog(command.id)">
                            <span aria-hidden="true">↗</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  </ng-container>
                  <tr *ngIf="!filteredPluginHotkeyDefinitions.length && !filteredCommandHotkeyCommands.length">
                    <td class="wqc-hotkey-no-results" colspan="5">没有匹配的快捷键</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="wqc-hotkey-dialog-message" role="alert" *ngIf="pluginHotkeyDialogError">{{ pluginHotkeyDialogError }}</div>
            <div class="wqc-hotkey-note">冲突检测覆盖本插件、命令快捷键和 Tabby 已配置操作，不包含操作系统或其他应用的全局快捷键。</div>
          </section>
          <div class="wqc-hotkey-command-floating-tooltip" id="wqc-hotkey-command-floating-tooltip" role="tooltip" *ngIf="hotkeyCommandTooltip" [style.left.px]="hotkeyCommandTooltip.left" [style.top.px]="hotkeyCommandTooltip.top">
            {{ hotkeyCommandTooltip.text }}
          </div>
        </div>

        <section class="wqc-section">
          <h4>操作与输入</h4>
          <div class="wqc-settings-list">
            <div class="wqc-setting-row">
              <span class="wqc-setting-label">打开抽屉后输入位置</span>
              <div class="wqc-segmented" role="radiogroup" aria-label="打开抽屉后键盘输入位置">
                <button type="button" role="radio" [attr.aria-checked]="root.drawerInitialFocus !== 'terminal'" [class.wqc-selected]="root.drawerInitialFocus !== 'terminal'" (click)="setInitialFocusValue('drawer')">命令搜索</button>
                <button type="button" role="radio" [attr.aria-checked]="root.drawerInitialFocus === 'terminal'" [class.wqc-selected]="root.drawerInitialFocus === 'terminal'" (click)="setInitialFocusValue('terminal')">当前终端</button>
              </div>
            </div>
            <div class="wqc-setting-row">
              <span class="wqc-setting-label">发送命令后输入位置</span>
              <div class="wqc-segmented" role="radiogroup" aria-label="发送命令后键盘输入位置">
                <button type="button" role="radio" [attr.aria-checked]="root.focusTerminalAfterSend !== true" [class.wqc-selected]="root.focusTerminalAfterSend !== true" (click)="setBooleanValue('focusTerminalAfterSend', false)">保持原位</button>
                <button type="button" role="radio" [attr.aria-checked]="root.focusTerminalAfterSend === true" [class.wqc-selected]="root.focusTerminalAfterSend === true" (click)="setBooleanValue('focusTerminalAfterSend', true)">返回终端</button>
              </div>
            </div>
            <div class="wqc-setting-row">
              <span class="wqc-setting-label">快捷键提示</span>
              <div class="wqc-segmented" role="radiogroup" aria-label="键盘操作与输入位置提示">
                <button type="button" role="radio" [attr.aria-checked]="root.showOperationHints === false" [class.wqc-selected]="root.showOperationHints === false" (click)="setBooleanValue('showOperationHints', false)">隐藏</button>
                <button type="button" role="radio" [attr.aria-checked]="root.showOperationHints !== false" [class.wqc-selected]="root.showOperationHints !== false" (click)="setBooleanValue('showOperationHints', true)">显示</button>
              </div>
            </div>
          </div>
          <h5 class="wqc-settings-group-title">抽屉显示</h5>
          <div class="wqc-settings-list">
            <div class="wqc-setting-row">
              <span class="wqc-setting-label">面板宽度</span>
              <input class="form-control wqc-setting-control wqc-setting-number wqc-number-input" type="number" min="420" max="760" step="20" title="" [value]="root.drawerWidth || 560" (wheel)="releaseNumberWheel($event)" (change)="setNumber('drawerWidth', $event, 420, 760)">
            </div>
          </div>
        </section>

        <section class="wqc-section">
          <h4>执行</h4>
          <h5 class="wqc-settings-group-title wqc-settings-group-title-first">确认与安全</h5>
          <div class="wqc-settings-list">
            <div class="wqc-setting-row">
              <span class="wqc-field-label wqc-setting-label">
                执行前确认
                <span class="wqc-help wqc-setting-help" tabindex="0" aria-label="查看按需确认说明">
                  <span class="wqc-help-icon" aria-hidden="true">?</span>
                  <span class="wqc-help-tooltip" role="tooltip">选择“按需”时，依旧会触发“高风险命令保护”和“发送到所有会话”规则。</span>
                </span>
              </span>
              <div class="wqc-segmented" role="radiogroup" aria-label="执行前确认">
                <button type="button" role="radio" [attr.aria-checked]="!root.requireConfirmBeforeExecute" [class.wqc-selected]="!root.requireConfirmBeforeExecute" (click)="setBooleanValue('requireConfirmBeforeExecute', false)">按需</button>
                <button type="button" role="radio" [attr.aria-checked]="root.requireConfirmBeforeExecute" [class.wqc-selected]="root.requireConfirmBeforeExecute" (click)="setBooleanValue('requireConfirmBeforeExecute', true)">每次</button>
              </div>
            </div>
            <div class="wqc-setting-row">
              <span class="wqc-field-label wqc-setting-label">
                高风险命令保护
                <span class="wqc-help wqc-setting-help" tabindex="0" aria-label="查看高风险命令二次弹窗确认说明">
                  <span class="wqc-help-icon" aria-hidden="true">?</span>
                  <span class="wqc-help-tooltip" role="tooltip">开启时，检测到删除、磁盘写入、强制清理等高风险命令，会弹出确认框；其中严重风险还需输入命令名称。关闭后，高风险命令不再单独触发确认，但“执行前确认：每次”和“发送到所有会话：始终确认”仍各自生效。关闭会降低误操作保护；自动化中的高风险命令仍会被跳过。</span>
                </span>
              </span>
              <div class="wqc-segmented" role="radiogroup" aria-label="高风险命令保护">
                <button type="button" role="radio" [attr.aria-checked]="root.confirmHighRiskCommands === false" [class.wqc-selected]="root.confirmHighRiskCommands === false" (click)="setBooleanValue('confirmHighRiskCommands', false)">关闭</button>
                <button type="button" role="radio" [attr.aria-checked]="root.confirmHighRiskCommands !== false" [class.wqc-selected]="root.confirmHighRiskCommands !== false" (click)="setBooleanValue('confirmHighRiskCommands', true)">二次确认</button>
              </div>
            </div>
            <div class="wqc-setting-row">
              <span class="wqc-setting-label">发送到所有会话</span>
              <div class="wqc-segmented" role="radiogroup" aria-label="发送到所有会话确认规则">
                <button type="button" role="radio" [attr.aria-checked]="root.confirmBroadcast === false" [class.wqc-selected]="root.confirmBroadcast === false" (click)="setBooleanValue('confirmBroadcast', false)">不额外确认</button>
                <button type="button" role="radio" [attr.aria-checked]="root.confirmBroadcast !== false" [class.wqc-selected]="root.confirmBroadcast !== false" (click)="setBooleanValue('confirmBroadcast', true)">始终确认</button>
              </div>
            </div>
          </div>
          <div class="wqc-settings-subgrid">
            <div class="wqc-settings-subgroup">
              <h5 class="wqc-settings-group-title">逐行执行</h5>
              <div class="wqc-settings-list">
                <div class="wqc-setting-row">
                  <span class="wqc-setting-label">发送失败后</span>
                  <div class="wqc-select-shell wqc-setting-control" [class.wqc-open]="failureMenuOpen" (click)="$event.stopPropagation()">
                    <button class="form-control wqc-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="failureMenuOpen" (click)="toggleFailureMenu()">
                      <span>{{ failureStrategyLabel }}</span>
                    </button>
                    <div class="wqc-select-menu" role="listbox" *ngIf="failureMenuOpen">
                      <button type="button" role="option" [attr.aria-selected]="root.failureStrategy === 'continue'" [class.wqc-selected]="root.failureStrategy === 'continue'" (click)="setFailureStrategy('continue')">继续执行</button>
                      <button type="button" role="option" [attr.aria-selected]="root.failureStrategy === 'stop'" [class.wqc-selected]="root.failureStrategy === 'stop'" (click)="setFailureStrategy('stop')">停止执行</button>
                      <button type="button" role="option" [attr.aria-selected]="!root.failureStrategy || root.failureStrategy === 'manual'" [class.wqc-selected]="!root.failureStrategy || root.failureStrategy === 'manual'" (click)="setFailureStrategy('manual')">手动确认</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="wqc-settings-subgroup">
              <h5 class="wqc-settings-group-title">高级</h5>
              <div class="wqc-settings-list">
                <div class="wqc-setting-row">
                  <span class="wqc-field-label wqc-setting-label">
                    输出匹配缓冲区
                    <span class="wqc-help wqc-setting-help" tabindex="0" aria-label="查看输出匹配缓冲区说明">
                      <span class="wqc-help-icon" aria-hidden="true">?</span>
                      <span class="wqc-help-tooltip" role="tooltip">用于输出触发器。插件会保留终端最近输出的这些字符，并在其中查找成功或错误关键词。这里按字符数计算，不是行数。数值太小可能让较早的输出被覆盖，导致匹配不到；数值越大则会多占用少量内存。一般保持默认 8000，只有大量连续输出把目标文字冲掉时才需要调大。</span>
                    </span>
                  </span>
                  <input class="form-control wqc-setting-control wqc-setting-number wqc-number-input" type="number" min="1000" step="1000" [value]="root.recentOutputLimit || 8000" (wheel)="releaseNumberWheel($event)" (change)="setNumber('recentOutputLimit', $event, 1000, 50000)">
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="wqc-section">
          <div class="wqc-section-head">
            <div>
              <h4>命令管理与统计</h4>
              <div class="wqc-muted">按关键词、分类和使用状态筛选，并按最近使用时间排序，每页 6 条。</div>
            </div>
            <span class="wqc-count">{{ commandCount }} 条命令</span>
          </div>
          <div class="wqc-command-filters">
            <input class="form-control" placeholder="搜索名称、说明或命令内容" [value]="commandQuery" (input)="setCommandQuery($event)">
            <div class="wqc-command-filter-options">
              <div class="wqc-select-shell wqc-filter-select" [class.wqc-open]="commandCategoryMenuOpen" (click)="$event.stopPropagation()">
                <button class="form-control wqc-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="commandCategoryMenuOpen" (click)="toggleCommandCategoryMenu()">
                  <span [attr.data-i18n-skip]="commandCategory !== 'all' ? '' : null">{{ commandCategoryLabel }}</span>
                </button>
                <div class="wqc-select-menu" role="listbox" *ngIf="commandCategoryMenuOpen">
                  <button type="button" role="option" [attr.aria-selected]="commandCategory === 'all'" [class.wqc-selected]="commandCategory === 'all'" (click)="setCommandCategory('all')">全部分类</button>
                  <button type="button" role="option" data-i18n-skip *ngFor="let category of commandCategories" [attr.aria-selected]="commandCategory === category" [class.wqc-selected]="commandCategory === category" (click)="setCommandCategory(category)">{{ category }}</button>
                </div>
              </div>
              <div class="wqc-select-shell wqc-filter-select" [class.wqc-open]="commandUsageMenuOpen" (click)="$event.stopPropagation()">
                <button class="form-control wqc-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="commandUsageMenuOpen" (click)="toggleCommandUsageMenu()">
                  <span>{{ commandUsageLabel }}</span>
                </button>
                <div class="wqc-select-menu" role="listbox" *ngIf="commandUsageMenuOpen">
                  <button type="button" role="option" [attr.aria-selected]="commandUsage === 'all'" [class.wqc-selected]="commandUsage === 'all'" (click)="setCommandUsage('all')">全部使用状态</button>
                  <button type="button" role="option" [attr.aria-selected]="commandUsage === 'used'" [class.wqc-selected]="commandUsage === 'used'" (click)="setCommandUsage('used')">使用过</button>
                  <button type="button" role="option" [attr.aria-selected]="commandUsage === 'unused'" [class.wqc-selected]="commandUsage === 'unused'" (click)="setCommandUsage('unused')">从未使用</button>
                </div>
              </div>
              <button class="btn btn-secondary" type="button" [disabled]="!commandFiltersActive" (click)="clearCommandFilters()">清除筛选</button>
            </div>
          </div>
          <div class="wqc-command-toolbar">
            <button class="btn btn-secondary" type="button" [disabled]="allCommandsSelected || !commandStats.length" (click)="selectAllCommands()">全选</button>
            <button class="btn btn-secondary" type="button" [disabled]="!selectedCommandCount" (click)="clearCommandSelection()">取消选择</button>
            <span class="wqc-selection-count">已选择 {{ selectedCommandCount }} 条</span>
            <button class="btn btn-secondary" type="button" [disabled]="!selectedCommandCount" (click)="$event.stopPropagation(); openBatchMove()">批量移动</button>
            <button class="btn wqc-danger-button" type="button" [disabled]="!selectedCommandCount" (click)="openBatchDeleteConfirm()">批量删除</button>
          </div>
          <div class="wqc-batch-move" *ngIf="batchMoveOpen">
            <span>将选中的 {{ selectedCommandCount }} 条命令移动到</span>
            <div class="wqc-select-shell wqc-batch-move-select" [class.wqc-open]="batchMoveCategoryMenuOpen" (click)="$event.stopPropagation()">
              <button class="form-control wqc-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="batchMoveCategoryMenuOpen" (click)="toggleBatchMoveCategoryMenu()">
                <span [attr.data-i18n-skip]="batchMoveCategory ? '' : null">{{ batchMoveCategory || '请选择目标分类' }}</span>
              </button>
              <div class="wqc-select-menu" role="listbox" *ngIf="batchMoveCategoryMenuOpen">
                <button type="button" role="option" data-i18n-skip *ngFor="let category of moveCategories" [attr.aria-selected]="batchMoveCategory === category" [class.wqc-selected]="batchMoveCategory === category" (click)="selectBatchMoveCategory(category)">{{ category }}</button>
              </div>
            </div>
            <div class="wqc-batch-confirm-actions">
              <button class="btn btn-secondary" type="button" (click)="closeBatchMove()">取消</button>
              <button class="btn btn-primary" type="button" [disabled]="!batchMoveCategory" (click)="moveSelectedCommands()">确认移动</button>
            </div>
          </div>
          <div class="wqc-batch-confirm" *ngIf="batchDeleteConfirmOpen">
            <span>确认永久删除选中的 {{ selectedCommandCount }} 条命令？活动日志将保留。</span>
            <div class="wqc-batch-confirm-actions">
              <button class="btn btn-secondary" type="button" (click)="closeBatchDeleteConfirm()">取消</button>
              <button class="btn wqc-danger-button" type="button" (click)="deleteSelectedCommands()">确认删除</button>
            </div>
          </div>
          <div class="wqc-stat-list">
            <div class="wqc-stat-row wqc-stat-header">
              <button class="wqc-command-check" type="button" role="checkbox" aria-label="选择当前页命令" [attr.aria-checked]="currentPagePartiallySelected ? 'mixed' : currentPageSelected" [class.wqc-checked]="currentPageSelected" [class.wqc-indeterminate]="currentPagePartiallySelected" [disabled]="!pagedCommandStats.length" (click)="toggleCurrentPageSelection()"></button>
              <span>命令</span>
              <span>执行次数</span>
              <span>最近使用</span>
            </div>
            <div class="wqc-stat-row" *ngFor="let command of pagedCommandStats" [class.wqc-stat-row-selected]="isCommandSelected(command.id)">
              <button class="wqc-command-check" type="button" role="checkbox" [attr.aria-label]="'选择命令：' + command.name" [attr.aria-checked]="isCommandSelected(command.id)" [class.wqc-checked]="isCommandSelected(command.id)" (click)="toggleCommandSelection(command.id)"></button>
              <div class="wqc-stat-command">
                <strong data-i18n-skip>{{ command.name }}</strong>
                <span class="wqc-pill" data-i18n-skip>{{ command.category }}</span>
              </div>
              <strong class="wqc-stat-count">{{ command.usageCount || 0 }}</strong>
              <span class="wqc-muted wqc-stat-time">{{ formatLastUsed(command.lastUsedAt) }}</span>
            </div>
            <div class="wqc-empty" *ngIf="!commandStats.length">{{ commandCount ? '没有匹配的命令' : '暂无命令' }}</div>
          </div>
          <div class="wqc-pager" *ngIf="commandPageCount > 1">
            <button class="btn btn-secondary" type="button" [disabled]="commandPageNumber <= 1" (click)="previousCommandPage()">上一页</button>
            <span>第 {{ commandPageNumber }} / {{ commandPageCount }} 页</span>
            <button class="btn btn-secondary" type="button" [disabled]="commandPageNumber >= commandPageCount" (click)="nextCommandPage()">下一页</button>
          </div>
        </section>

        <quick-commands-activity-log
          [entries]="runtimeLogs"
          [settings]="activityLogRetention"
          [sizeBytes]="activityLogSizeBytes"
          (settingsChange)="updateActivityLogRetention($event)"
          (clearRequested)="clearLogs()"
          (openLocationRequested)="openLogLocation()">
        </quick-commands-activity-log>

        <section class="wqc-section wqc-update-section" id="wqc-plugin-update">
          <div class="wqc-section-head">
            <div>
              <div class="wqc-update-title-line">
                <h4>版本更新</h4>
                <span class="wqc-update-current-version">当前版本 v{{ updateState.currentVersion }}</span>
              </div>
              <div class="wqc-muted">管理自动检查、查看历史更新和安装新版本。</div>
            </div>
            <div class="wqc-update-head-actions">
              <button class="wqc-back-to-top" type="button" (click)="scrollToSettingsTop()">返回顶部 <span aria-hidden="true">↑</span></button>
              <button class="btn btn-secondary" type="button" (click)="openUpdateHistory()">更新历史</button>
            </div>
          </div>

          <div class="wqc-update-preferences">
            <div class="wqc-update-interval">
              <span class="wqc-update-interval-label">自动检查</span>
              <div class="wqc-select-shell wqc-update-interval-shell" [class.wqc-open]="updateIntervalMenuOpen" (click)="$event.stopPropagation()">
                <button class="wqc-select wqc-update-interval-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="updateIntervalMenuOpen" (click)="toggleUpdateIntervalMenu()">
                  <span>{{ updateCheckIntervalLabel }}</span>
                </button>
                <div class="wqc-select-menu wqc-update-interval-menu" role="listbox" *ngIf="updateIntervalMenuOpen">
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'startup'" [class.wqc-selected]="updateCheckInterval === 'startup'" (click)="selectUpdateCheckInterval('startup')">客户端启动时</button>
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'daily'" [class.wqc-selected]="updateCheckInterval === 'daily'" (click)="selectUpdateCheckInterval('daily')">每天</button>
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'weekly'" [class.wqc-selected]="updateCheckInterval === 'weekly'" (click)="selectUpdateCheckInterval('weekly')">每周</button>
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'never'" [class.wqc-selected]="updateCheckInterval === 'never'" (click)="selectUpdateCheckInterval('never')">从不</button>
                </div>
              </div>
            </div>
            <div class="wqc-update-check-control">
              <div class="wqc-update-check-status" *ngIf="showUpdateCheckStatus && updateStatusLabel" role="status" [class.wqc-update-error]="updateState.status === 'error'">
                <span>{{ updateStatusLabel }}</span>
                <button type="button" aria-label="关闭提示" (click)="dismissUpdateCheckStatus()">×</button>
              </div>
              <button class="btn btn-secondary wqc-check-update" type="button" [disabled]="updateState.status === 'checking' || updateState.status === 'installing'" (click)="checkForUpdatesWithStatus()">检查更新</button>
            </div>
          </div>

          <p class="wqc-muted" *ngIf="!canInstallUpdate">
            <span>Dev 读取正式版的版本信息和更新历史，不会安装正式包。</span><br>
            <span>更新本地代码后，请在源码目录运行：</span> <code data-i18n-skip>npm run install:tabby:dev</code> <span>然后重启 Tabby。</span>
          </p>
          <div class="wqc-update-panel" *ngIf="updateState.available">
            <div class="wqc-update-summary">
              <button class="wqc-update-summary-trigger" type="button" [attr.aria-expanded]="updateDetailsExpanded" (click)="toggleUpdateDetails()">
                <span class="wqc-update-summary-title">
                  <span class="wqc-update-dot" aria-hidden="true"></span>
                  发现新版本 v{{ updateState.latestVersion }}
                  <small *ngIf="updateState.ignored">已停止提醒</small>
                </span>
              </button>
              <div class="wqc-update-summary-actions">
                <span class="wqc-update-button-hint" *ngIf="!updateDetailsExpanded" [class.wqc-disabled]="updateInstallDisabledHint" [attr.tabindex]="updateInstallDisabledHint ? 0 : null" [attr.aria-describedby]="updateInstallDisabledHint ? 'wqc-update-inline-disabled-hint' : null">
                  <button class="btn wqc-update-now" type="button" [disabled]="!canInstallUpdate || updateState.status === 'installing' || updateState.status === 'restart'" (click)="installUpdate()">
                    {{ updateState.status === 'installing' ? '正在更新…' : updateState.status === 'restart' ? '等待重启' : '立即更新' }}
                  </button>
                  <span class="wqc-help-tooltip wqc-update-disabled-tooltip" *ngIf="updateInstallDisabledHint" id="wqc-update-inline-disabled-hint" role="tooltip">{{ updateInstallDisabledHint }}</span>
                </span>
                <button class="wqc-update-expand" type="button" [attr.aria-expanded]="updateDetailsExpanded" (click)="toggleUpdateDetails()">{{ updateDetailsExpanded ? '收起' : '展开' }}</button>
              </div>
            </div>
            <div class="wqc-update-details" *ngIf="updateDetailsExpanded">
              <pre class="wqc-update-notes" data-i18n-skip *ngIf="updateState.releaseNotes">{{ updateState.releaseNotes }}</pre>
              <div class="wqc-update-empty" *ngIf="!updateState.releaseNotes">本次更新未提供更新说明。</div>
              <div class="wqc-update-actions">
                <span class="wqc-update-button-hint" [class.wqc-disabled]="updateInstallDisabledHint" [attr.tabindex]="updateInstallDisabledHint ? 0 : null" [attr.aria-describedby]="updateInstallDisabledHint ? 'wqc-update-expanded-disabled-hint' : null">
                  <button class="btn btn-primary wqc-update-now-expanded" type="button" [disabled]="!canInstallUpdate || updateState.status === 'installing' || updateState.status === 'restart'" (click)="installUpdate()">
                    {{ updateState.status === 'installing' ? '正在更新…' : updateState.status === 'restart' ? '等待重启' : '立即更新' }}
                  </button>
                  <span class="wqc-help-tooltip wqc-update-disabled-tooltip" *ngIf="updateInstallDisabledHint" id="wqc-update-expanded-disabled-hint" role="tooltip">{{ updateInstallDisabledHint }}</span>
                </span>
                <button class="btn btn-secondary" type="button" [disabled]="updateState.ignored" (click)="ignoreCurrentUpdate()">{{ updateState.ignored ? '已停止提醒' : '本版本不再提醒' }}</button>
              </div>
            </div>
          </div>
        </section>

        <div class="wqc-config-dialog-backdrop" *ngIf="exportConfigDialogOpen" (click)="closeExportPluginConfig()">
          <section class="wqc-config-dialog wqc-export-dialog" role="dialog" aria-modal="true" aria-labelledby="wqc-config-export-title" (click)="$event.stopPropagation()">
            <h4 id="wqc-config-export-title">导出配置</h4>
            <p><span>设置导出文件名，日期占位符</span> <code data-i18n-skip>{{ '{date}' }}</code> <span>会在导出时替换为当前日期。</span></p>
            <label class="wqc-export-field">
              <span>导出文件名</span>
              <input class="form-control wqc-export-file-name" type="text" autocomplete="off" [value]="exportFileNameDraft" (input)="setExportFileNameDraft($event)" (keydown.enter)="confirmExportPluginConfig($event)">
            </label>
            <div class="wqc-config-dialog-actions">
              <button class="btn btn-secondary" type="button" (click)="closeExportPluginConfig()">取消</button>
              <button class="btn btn-primary" type="button" [disabled]="!exportFileNameDraft.trim()" (click)="confirmExportPluginConfig()">导出</button>
            </div>
          </section>
        </div>

        <div class="wqc-config-dialog-backdrop" *ngIf="pendingConfigImport" (click)="cancelPendingConfigImport()">
          <section class="wqc-config-dialog" role="dialog" aria-modal="true" aria-labelledby="wqc-config-import-title" (click)="$event.stopPropagation()">
            <h4 id="wqc-config-import-title">{{ pendingConfigImport.kind === 'commands' ? '导入命令' : '选择导入内容' }}</h4>
            <p *ngIf="pendingConfigImport.kind === 'commands'">
              <span class="wqc-config-dialog-line">该文件只包含命令。</span>
              <span class="wqc-config-dialog-line">是否将命令合并到当前命令库？</span>
            </p>
            <p *ngIf="pendingConfigImport.kind === 'config'">
              <span class="wqc-config-dialog-line">该文件包含命令和插件配置，请选择要导入的内容。</span>
              <span class="wqc-config-dialog-line">导入完整配置会替换当前命令和设置。</span>
            </p>
            <p class="wqc-muted" *ngIf="pendingConfigImport.kind === 'config' && pendingConfigImport.config?.pluginHotkeys">
              完整配置包含插件操作快捷键；导入后会同步更新 Tabby 快捷键设置。
            </p>
            <div class="wqc-config-dialog-actions">
              <button class="btn btn-secondary" type="button" (click)="cancelPendingConfigImport()">取消</button>
              <button class="btn btn-secondary" type="button" [disabled]="!pendingConfigImport.commands.length" (click)="importPendingCommands()">导入命令</button>
              <button class="btn btn-primary" type="button" *ngIf="pendingConfigImport.kind === 'config'" (click)="importPendingFullConfig()">导入完整配置</button>
            </div>
          </section>
        </div>

        <div class="wqc-config-dialog-backdrop" *ngIf="resetDefaultsConfirmOpen" (click)="closeResetDefaultsConfirm()">
          <section class="wqc-config-dialog" role="dialog" aria-modal="true" aria-labelledby="wqc-reset-defaults-title" (click)="$event.stopPropagation()">
            <h4 id="wqc-reset-defaults-title">{{ resetInitialConfirmOpen ? '重置插件数据' : '恢复默认配置' }}</h4>
            <ng-container *ngIf="!resetInitialConfirmOpen">
              <p>确定恢复所有插件设置的默认值？现有命令、分类和输出触发器将保留，活动日志和使用统计也不会清除。</p>
              <div class="wqc-config-dialog-actions wqc-reset-actions">
                <button class="wqc-reset-initial-entry wqc-reset-text-action" type="button" (click)="openResetInitialConfirm()">重置插件数据</button>
                <button class="btn btn-secondary" type="button" (click)="closeResetDefaultsConfirm()">取消</button>
                <button class="btn wqc-danger-button" type="button" (click)="restoreDefaultSettings()">确认恢复</button>
              </div>
            </ng-container>
            <ng-container *ngIf="resetInitialConfirmOpen">
              <div class="wqc-reset-warning" role="note">
                <strong>此操作不可撤销</strong>
                <p>将删除现有插件数据，并按当前界面语言重新创建默认分类和示例命令。</p>
                <ul>
                  <li>命令、分类、命令快捷键和输出触发器</li>
                  <li>插件设置、配置备份、活动日志和使用统计</li>
                  <li>插件本地缓存</li>
                </ul>
              </div>
              <p>请先导出需要保留的命令和配置；导出文件不包含活动日志和使用统计。</p>
              <p>不会卸载插件，也不会删除保存在其他位置的导出文件。</p>
              <p>当前 Tabby 窗口不会重启。请在操作后重启，以免继续使用旧数据。</p>
              <p>仅清空下方显示的当前插件数据目录，不影响 Tabby 配置和其他插件。</p>
              <div class="wqc-reset-path"><span>清理目录</span><code data-i18n-skip>{{ pluginDataDirectory }}</code></div>
              <label class="wqc-reset-acknowledge">
                <input type="checkbox" [checked]="resetInitialAcknowledged" [disabled]="resetInProgress" (change)="setResetInitialAcknowledged($event)">
                <span>我已了解数据将永久删除，并已保存需要保留的内容。</span>
              </label>
              <p class="wqc-reset-error" role="alert" data-i18n-skip *ngIf="resetInitialError">{{ resetInitialError }}</p>
              <div class="wqc-config-dialog-actions wqc-reset-actions">
                <button class="btn btn-secondary wqc-reset-initial-entry" type="button" [disabled]="resetInProgress" (click)="backToResetDefaults()">返回</button>
                <button class="btn btn-secondary" type="button" [disabled]="resetInProgress" (click)="closeResetDefaultsConfirm()">取消</button>
                <button class="btn wqc-danger-button" type="button" [disabled]="!resetInitialAcknowledged || resetInProgress" (click)="restoreInitialState()">{{ resetInProgress ? '正在重置…' : '确认重置' }}</button>
              </div>
            </ng-container>
          </section>
        </div>

        <div class="wqc-update-history-backdrop" *ngIf="updateHistoryOpen" (click)="closeUpdateHistory()">
          <section class="wqc-update-history-dialog" role="dialog" aria-modal="true" aria-labelledby="wqc-update-history-title" (click)="$event.stopPropagation()">
            <header class="wqc-update-history-header">
              <div>
                <h4 id="wqc-update-history-title">更新历史</h4>
                <p>记录来自 npm 已发布版本</p>
              </div>
              <button class="wqc-update-history-close" type="button" aria-label="关闭" (click)="closeUpdateHistory()">×</button>
            </header>

            <div class="wqc-update-history-body">
              <div class="wqc-update-history-message" *ngIf="updateHistoryState.status === 'loading'">
                <span class="wqc-update-history-spinner" aria-hidden="true"></span>
                正在加载版本记录…
              </div>
              <div class="wqc-update-history-message" *ngIf="updateHistoryState.status === 'refreshing'">
                <span class="wqc-update-history-spinner" aria-hidden="true"></span>
                正在刷新版本记录，已显示本地缓存…
              </div>
              <div class="wqc-update-history-message wqc-update-history-error" *ngIf="updateHistoryState.status === 'error'">
                加载失败：{{ updateHistoryState.error || '请稍后重试' }}
              </div>
              <div class="wqc-update-history-message" *ngIf="updateHistoryState.status === 'ready' && !updateHistoryState.entries.length">
                npm 暂无已发布版本记录。
              </div>

              <div class="wqc-update-history-list" *ngIf="updateHistoryState.entries.length">
                <article class="wqc-update-history-item" *ngFor="let entry of updateHistoryState.entries">
                  <button class="wqc-update-history-summary" type="button" [attr.aria-expanded]="isHistoryVersionExpanded(entry.version)" (click)="toggleHistoryVersion(entry.version)">
                    <span class="wqc-update-history-version">v{{ entry.version }}</span>
                    <span class="wqc-update-history-current" *ngIf="entry.version === updateState.currentVersion">当前版本</span>
                    <time *ngIf="entry.publishedAt">{{ formatHistoryDate(entry.publishedAt) }}</time>
                    <span class="wqc-update-history-expand">{{ isHistoryVersionExpanded(entry.version) ? '收起' : '展开' }}</span>
                  </button>
                  <div class="wqc-update-history-content" *ngIf="isHistoryVersionExpanded(entry.version)">
                    <pre data-i18n-skip *ngIf="entry.hasReleaseNotes">{{ entry.releaseNotes }}</pre>
                    <div class="wqc-update-history-missing" *ngIf="!entry.hasReleaseNotes">此版本未提供更新说明。</div>
                  </div>
                </article>
              </div>
            </div>

            <footer class="wqc-update-history-footer">
              <button class="btn btn-secondary" type="button" [disabled]="updateHistoryState.status === 'loading' || updateHistoryState.status === 'refreshing'" (click)="reloadUpdateHistory()">重新加载</button>
              <button class="btn btn-primary wqc-update-history-confirm-close" type="button" (click)="closeUpdateHistory()">关闭</button>
            </footer>
          </section>
        </div>
      </div>
    `,
    styles: [`
      .wqc-settings {
        --bs-secondary-color: color-mix(in srgb, var(--bs-body-color) 72%, transparent);
        --wqc-text: var(--bs-body-color);
        --wqc-muted: var(--bs-secondary-color);
        --wqc-accent: color-mix(in srgb, var(--bs-primary) 72%, var(--wqc-text) 28%);
        --wqc-surface-border: color-mix(in srgb, var(--bs-body-bg) 72%, var(--bs-body-color) 28%);
        --wqc-control-border: color-mix(in srgb, var(--bs-body-bg) 62%, var(--bs-body-color) 38%);
        max-width: 980px;
        padding: 18px 24px 28px;
        color: var(--wqc-text);
      }

      :host-context(body.dark) .wqc-settings,
      :host-context(.theme-dark) .wqc-settings,
      :host-context(.platform-theme-dark) .wqc-settings,
      :host-context([data-bs-theme="dark"]) .wqc-settings {
        --wqc-text: color-mix(in srgb, var(--bs-body-color, #e5e7eb) 72%, #ffffff 28%);
        --wqc-muted: color-mix(in srgb, var(--wqc-text) 72%, transparent);
        --wqc-accent: color-mix(in srgb, var(--bs-primary, #3b82f6) 72%, #ffffff 28%);
        --wqc-surface-border: color-mix(in srgb, var(--bs-body-bg, #111827) 70%, var(--wqc-text) 30%);
        --wqc-control-border: color-mix(in srgb, var(--bs-body-bg, #111827) 58%, var(--wqc-text) 42%);
      }

      @media (prefers-color-scheme: dark) {
        .wqc-settings {
          --wqc-text: color-mix(in srgb, var(--bs-body-color, #e5e7eb) 72%, #ffffff 28%);
          --wqc-muted: color-mix(in srgb, var(--wqc-text) 72%, transparent);
          --wqc-accent: color-mix(in srgb, var(--bs-primary, #3b82f6) 72%, #ffffff 28%);
          --wqc-surface-border: color-mix(in srgb, var(--bs-body-bg, #111827) 70%, var(--wqc-text) 30%);
          --wqc-control-border: color-mix(in srgb, var(--bs-body-bg, #111827) 58%, var(--wqc-text) 42%);
        }
      }

      .wqc-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
      }

      .wqc-header-toggle {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 32px;
        margin: 0;
        padding: 6px 9px;
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 4%, transparent);
        border: 1px solid var(--bs-border-color);
        border-radius: 7px;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
      }

      .wqc-header-toggle:hover {
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 7%, var(--bs-body-bg));
        border-color: color-mix(in srgb, var(--bs-primary) 32%, var(--bs-border-color));
      }

      .wqc-header-toggle input {
        width: 15px;
        height: 15px;
        margin: 0;
      }

      .wqc-header-toggle small {
        color: var(--bs-secondary-color);
        font-size: 10px;
        font-weight: 400;
      }

      .wqc-header h3,
      .wqc-section h4 {
        margin: 0;
      }

      .wqc-muted {
        margin-top: 5px;
        color: var(--wqc-muted);
        font-size: 13px;
      }

      .wqc-plugin-intro {
        margin-bottom: 18px;
        padding: 14px 16px;
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-primary) 6%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 22%, var(--wqc-surface-border));
        border-radius: 9px;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.05);
      }

      .wqc-plugin-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 6px;
      }

      .wqc-plugin-intro .wqc-plugin-title {
        display: block;
        margin: 0;
        color: var(--wqc-accent);
        font-size: 14px;
      }

      .wqc-plugin-version,
      .wqc-update-current-version {
        flex: none;
        padding: 2px 7px;
        color: var(--wqc-muted);
        background: color-mix(in srgb, var(--bs-body-color) 5%, transparent);
        border: 1px solid color-mix(in srgb, var(--wqc-surface-border) 76%, transparent);
        border-radius: 999px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .wqc-plugin-intro p {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
      }

      .wqc-plugin-note {
        margin-top: 7px;
        color: var(--wqc-muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .wqc-plugin-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-top: 9px;
      }

      .wqc-plugin-links {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin: 0;
        font-size: 12px;
      }

      .wqc-plugin-links a {
        color: var(--bs-link-color, var(--wqc-accent));
        text-decoration: none;
      }

      .wqc-plugin-links a:hover,
      .wqc-plugin-links a:focus-visible {
        text-decoration: underline;
      }

      .wqc-update-actions,
      .wqc-update-card-check,
      .wqc-update-head-actions,
      .wqc-update-check-control,
      .wqc-update-preferences {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wqc-update-head-actions {
        flex: none;
      }

      .wqc-update-card-check {
        justify-content: flex-end;
        min-width: 0;
      }

      .wqc-update-preferences {
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        min-height: 36px;
        flex-wrap: wrap;
      }

      .wqc-update-check-control {
        justify-content: flex-end;
        min-width: 0;
        margin-left: auto;
      }

      .wqc-status-tooltip {
        position: relative;
        display: inline-flex;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
      }

      .wqc-status-tooltip:hover .wqc-status-tooltip-content,
      .wqc-status-tooltip:focus-within .wqc-status-tooltip-content {
        visibility: visible;
        opacity: 1;
        transform: translateY(0);
      }

      .wqc-update-feedback {
        color: var(--wqc-muted);
        font-size: 11px;
        white-space: nowrap;
      }

      .wqc-update-feedback-link {
        min-height: 28px;
        padding: 4px 7px;
        overflow: hidden;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 7px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        text-overflow: ellipsis;
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
      }

      .wqc-update-feedback-link:hover,
      .wqc-update-feedback-link:focus-visible {
        outline: 0;
        color: var(--wqc-accent);
        background: color-mix(in srgb, var(--wqc-accent) 8%, transparent);
        border-color: color-mix(in srgb, var(--wqc-accent) 24%, transparent);
      }

      .wqc-update-feedback.wqc-update-error {
        max-width: 280px;
        overflow: hidden;
        color: var(--bs-danger, #c2410c);
        text-overflow: ellipsis;
      }

      .wqc-update-check-status {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        max-width: 360px;
        padding: 4px 6px 4px 8px;
        color: var(--wqc-muted);
        background: color-mix(in srgb, var(--bs-body-color) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--wqc-control-border) 72%, transparent);
        border-radius: 7px;
        font-size: 11px;
      }

      .wqc-update-check-status > span {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .wqc-update-check-status > button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex: none;
        padding: 0;
        color: currentColor;
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 17px;
        line-height: 1;
      }

      .wqc-update-check-status > button:hover,
      .wqc-update-check-status > button:focus-visible {
        outline: 0;
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-color) 8%, transparent);
      }

      .wqc-update-check-status.wqc-update-error {
        color: var(--bs-danger, #c2410c);
      }

      .wqc-update-interval {
        display: flex;
        align-items: stretch;
        gap: 0;
        min-height: 32px;
        overflow: visible;
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-color) 3%, var(--bs-body-bg));
        border: 1px solid var(--wqc-control-border);
        border-radius: 9px;
        font-size: 11px;
        white-space: nowrap;
        transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
      }

      .wqc-update-interval:hover {
        background: color-mix(in srgb, var(--wqc-accent) 4%, var(--bs-body-bg));
        border-color: color-mix(in srgb, var(--wqc-accent) 36%, var(--wqc-control-border));
      }

      .wqc-update-interval:focus-within {
        border-color: var(--wqc-accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--wqc-accent) 22%, transparent);
      }

      .wqc-update-interval-label {
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        flex: 0 0 auto;
        padding: 0 10px;
        color: var(--wqc-text);
        background: transparent;
        border-right: 1px solid color-mix(in srgb, var(--wqc-control-border) 72%, transparent);
        font-weight: 600;
      }

      .wqc-update-interval-shell {
        box-sizing: border-box;
        width: fit-content;
        flex: 0 0 auto;
      }

      .wqc-update-interval-shell .wqc-update-interval-select {
        width: auto;
        min-height: 30px;
        padding: 4px 28px 4px 10px;
        color: var(--wqc-text);
        background: transparent;
        border: 0;
        border-radius: 0 8px 8px 0;
        box-shadow: none;
        font: inherit;
        font-size: 11px;
      }

      .wqc-update-interval-shell .wqc-update-interval-select:hover,
      .wqc-update-interval-shell .wqc-update-interval-select:focus {
        outline: 0;
        background: color-mix(in srgb, var(--wqc-accent) 6%, transparent);
        box-shadow: none;
        transform: none;
      }

      .wqc-update-interval-shell .wqc-update-interval-menu {
        top: calc(100% + 5px);
        right: auto;
        width: max-content;
        min-width: 100%;
        gap: 2px;
        padding: 4px;
        border-color: color-mix(in srgb, var(--wqc-accent) 28%, var(--wqc-control-border));
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
      }

      .wqc-update-interval-shell .wqc-update-interval-menu button {
        min-height: 29px;
        padding: 5px 8px;
        font-size: 11px;
      }

      .wqc-check-update {
        min-height: 30px;
        padding: 4px 10px;
        font-size: 11px;
        white-space: nowrap;
      }

      .wqc-update-title-line {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .wqc-update-head-actions > .btn {
        min-height: 32px;
        font-size: 11px;
      }

      .wqc-back-to-top {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 1px;
        color: var(--wqc-muted);
        background: transparent;
        border: 0;
        border-radius: 0;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        text-decoration: none;
        text-underline-offset: 3px;
        white-space: nowrap;
      }

      .wqc-back-to-top:hover,
      .wqc-back-to-top:focus-visible {
        outline: 0;
        color: var(--wqc-accent);
        text-decoration: underline;
      }

      .wqc-back-to-top span {
        display: inline-flex;
        align-items: center;
        line-height: 1;
        transform: translateY(-1px);
      }

      .wqc-update-panel {
        margin-top: 11px;
        overflow: visible;
        background: color-mix(in srgb, var(--bs-primary) 5%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 24%, var(--wqc-surface-border));
        border-radius: 8px;
      }

      .wqc-update-summary-trigger,
      .wqc-update-history-summary {
        display: flex;
        align-items: center;
        width: 100%;
        color: var(--wqc-text);
        text-align: left;
        background: transparent;
        border: 0;
        cursor: pointer;
        font: inherit;
      }

      .wqc-update-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 38px;
        padding: 8px 11px;
        border-radius: 7px;
        font-size: 12px;
      }

      .wqc-update-summary:hover,
      .wqc-update-history-summary:hover,
      .wqc-update-history-summary:focus-visible {
        background: color-mix(in srgb, var(--bs-primary) 7%, transparent);
      }

      .wqc-update-summary-trigger {
        min-width: 0;
        flex: 1 1 auto;
        align-self: stretch;
        padding: 0;
      }

      .wqc-update-summary-trigger:focus-visible {
        outline: 1px solid var(--wqc-accent);
        outline-offset: 3px;
        border-radius: 4px;
      }

      .wqc-update-summary-actions {
        display: flex;
        align-items: center;
        flex: none;
        gap: 7px;
      }

      .wqc-update-button-hint {
        position: relative;
        display: inline-flex;
        min-width: 0;
      }

      .wqc-update-button-hint.wqc-disabled {
        cursor: not-allowed;
      }

      .wqc-update-button-hint.wqc-disabled:focus-visible {
        outline: 2px solid var(--wqc-accent);
        outline-offset: 2px;
        border-radius: 7px;
      }

      .wqc-help-tooltip.wqc-update-disabled-tooltip {
        right: 0;
        width: max-content;
        max-width: min(300px, calc(100vw - 48px));
        padding: 8px 10px;
        line-height: 1.5;
        white-space: normal;
      }

      .wqc-update-actions .wqc-update-disabled-tooltip {
        left: 0;
        right: auto;
      }

      .wqc-update-actions .wqc-update-disabled-tooltip::after {
        left: 11px;
        right: auto;
      }

      .wqc-update-button-hint:hover .wqc-update-disabled-tooltip,
      .wqc-update-button-hint:focus-visible .wqc-update-disabled-tooltip,
      .wqc-update-button-hint:focus-within .wqc-update-disabled-tooltip {
        visibility: visible;
        opacity: 1;
        transform: translateY(0);
      }

      .wqc-update-now {
        min-height: 28px;
        padding: 4px 9px;
        color: var(--wqc-accent);
        background: color-mix(in srgb, var(--bs-primary) 10%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 34%, var(--wqc-control-border));
        border-radius: 6px;
        font-size: 11px;
        white-space: nowrap;
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 100ms ease;
      }

      .wqc-update-now:hover:not(:disabled),
      .wqc-update-now:focus-visible:not(:disabled) {
        color: color-mix(in srgb, var(--bs-primary) 82%, var(--wqc-text) 18%);
        background: color-mix(in srgb, var(--bs-primary) 16%, var(--bs-body-bg));
        border-color: color-mix(in srgb, var(--bs-primary) 54%, var(--wqc-control-border));
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-primary) 12%, transparent);
        transform: translateY(-1px);
      }

      .wqc-update-now:active:not(:disabled) {
        color: color-mix(in srgb, var(--bs-primary) 88%, var(--wqc-text) 12%);
        background: color-mix(in srgb, var(--bs-primary) 22%, var(--bs-body-bg));
        border-color: color-mix(in srgb, var(--bs-primary) 66%, var(--wqc-control-border));
        box-shadow: inset 0 1px 3px color-mix(in srgb, var(--bs-primary) 24%, transparent);
        transform: translateY(0) scale(0.97);
      }

      .wqc-update-now-expanded {
        transition: filter 140ms ease, box-shadow 140ms ease, transform 100ms ease;
      }

      .wqc-update-now-expanded:hover:not(:disabled),
      .wqc-update-now-expanded:focus-visible:not(:disabled) {
        filter: brightness(1.08);
        box-shadow: 0 5px 12px color-mix(in srgb, var(--bs-primary) 24%, transparent);
        transform: translateY(-1px);
      }

      .wqc-update-now-expanded:active:not(:disabled) {
        filter: brightness(0.92);
        box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.18);
        transform: translateY(0) scale(0.97);
      }

      .wqc-update-summary-title {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        font-weight: 650;
      }

      .wqc-update-summary-title small {
        color: var(--wqc-muted);
        font-size: 10px;
        font-weight: 400;
      }

      .wqc-update-dot {
        width: 7px;
        height: 7px;
        flex: none;
        background: var(--bs-primary);
        border-radius: 50%;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--bs-primary) 14%, transparent);
      }

      .wqc-update-expand {
        flex: none;
        min-height: 28px;
        padding: 4px 2px;
        color: var(--wqc-accent);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
      }

      .wqc-update-expand:hover,
      .wqc-update-expand:focus-visible {
        outline: 0;
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      .wqc-update-details {
        padding: 11px;
        border-top: 1px solid color-mix(in srgb, var(--bs-primary) 18%, var(--wqc-surface-border));
      }

      .wqc-update-notes {
        max-height: 240px;
        margin: 0 0 11px;
        padding: 0 2px;
        overflow: auto;
        color: var(--wqc-text);
        white-space: pre-wrap;
        font: inherit;
        font-size: 12px;
        line-height: 1.6;
      }

      .wqc-update-empty {
        margin-bottom: 11px;
        color: var(--wqc-muted);
        font-size: 12px;
      }

      .wqc-update-actions {
        flex-wrap: wrap;
      }

      .wqc-update-actions .btn {
        min-height: 32px;
        font-size: 11px;
      }

      .wqc-update-history-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1090;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.48);
        backdrop-filter: blur(5px);
      }

      .wqc-update-history-dialog {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        width: min(680px, 100%);
        max-height: min(760px, calc(100vh - 48px));
        overflow: hidden;
        color: var(--wqc-text);
        background: var(--bs-body-bg);
        border: 1px solid var(--wqc-surface-border);
        border-radius: 12px;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.3);
      }

      .wqc-update-history-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--wqc-surface-border);
      }

      .wqc-update-history-header h4 {
        margin: 0;
        font-size: 16px;
      }

      .wqc-update-history-header p {
        margin: 4px 0 0;
        color: var(--wqc-muted);
        font-size: 11px;
      }

      .wqc-update-history-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex: none;
        padding: 0;
        color: var(--wqc-muted);
        background: transparent;
        border: 0;
        border-radius: 7px;
        cursor: pointer;
        font-size: 22px;
        line-height: 1;
      }

      .wqc-update-history-close:hover,
      .wqc-update-history-close:focus-visible {
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-color) 7%, transparent);
      }

      .wqc-update-history-body {
        min-height: 180px;
        padding: 14px 18px;
        overflow: auto;
      }

      .wqc-update-history-message {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        min-height: 150px;
        color: var(--wqc-muted);
        text-align: center;
        font-size: 12px;
      }

      .wqc-update-history-error {
        color: var(--bs-danger, #c2410c);
      }

      .wqc-update-history-spinner {
        width: 15px;
        height: 15px;
        border: 2px solid color-mix(in srgb, var(--bs-primary) 25%, transparent);
        border-top-color: var(--bs-primary);
        border-radius: 50%;
        animation: wqc-update-history-spin 750ms linear infinite;
      }

      @keyframes wqc-update-history-spin {
        to { transform: rotate(360deg); }
      }

      .wqc-update-history-list {
        display: grid;
        gap: 8px;
      }

      .wqc-update-history-item {
        overflow: hidden;
        background: color-mix(in srgb, var(--bs-body-color) 3%, var(--bs-body-bg));
        border: 1px solid var(--wqc-surface-border);
        border-radius: 8px;
      }

      .wqc-update-history-summary {
        gap: 8px;
        min-height: 42px;
        padding: 8px 11px;
      }

      .wqc-update-history-version {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .wqc-update-history-current {
        padding: 2px 6px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 11%, transparent);
        border-radius: 999px;
        font-size: 9px;
      }

      .wqc-update-history-summary time {
        margin-left: auto;
        color: var(--wqc-muted);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }

      .wqc-update-history-expand {
        min-width: 24px;
        color: var(--wqc-accent);
        text-align: right;
        font-size: 10px;
      }

      .wqc-update-history-content {
        padding: 11px 12px;
        border-top: 1px solid var(--wqc-surface-border);
      }

      .wqc-update-history-content pre {
        margin: 0;
        color: var(--wqc-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: inherit;
        font-size: 12px;
        line-height: 1.65;
      }

      .wqc-update-history-missing {
        color: var(--wqc-muted);
        font-size: 12px;
      }

      .wqc-update-history-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--wqc-surface-border);
      }

      .wqc-update-history-footer .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 82px;
        text-align: center;
      }

      .wqc-update-history-confirm-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }

      .wqc-section {
        border-top: 1px solid var(--wqc-surface-border);
        padding: 18px 0;
      }

      .wqc-config-section {
        container: wqc-config / inline-size;
        padding-top: 0;
        border-top: 0;
      }

      .wqc-config-actions {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 8px;
        width: 100%;
      }

      .wqc-hotkey-summary-row,
      .wqc-hotkey-summary-copy,
      .wqc-hotkey-summary-meta,
      .wqc-hotkey-dialog-header,
      .wqc-hotkey-bindings,
      .wqc-hotkey-row-actions {
        display: flex;
        align-items: center;
      }

      .wqc-hotkey-summary-row {
        justify-content: space-between;
        gap: 16px;
        min-height: 42px;
      }

      .wqc-hotkey-summary-copy {
        gap: 14px;
        min-width: 0;
      }

      .wqc-hotkey-section .wqc-hotkey-summary-copy h4 {
        flex: none;
        margin: 0;
        line-height: 1.35;
      }

      .wqc-hotkey-summary-meta {
        gap: 7px;
        color: var(--wqc-muted);
        font-size: 12px;
        line-height: 1.35;
      }

      .wqc-hotkey-summary-warning {
        color: color-mix(in srgb, var(--bs-warning) 78%, var(--bs-body-color));
      }

      .wqc-hotkey-manage {
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 80px;
        min-height: 34px;
        padding: 6px 7px;
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 2.5%, transparent);
        border: 1px solid color-mix(in srgb, var(--wqc-surface-border) 88%, transparent);
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
      }

      .wqc-hotkey-manage-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .wqc-hotkey-manage-icon,
      .wqc-hotkey-manage-chevron {
        flex: none;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .wqc-hotkey-manage-icon {
        width: 15px;
        height: 15px;
        color: var(--wqc-muted);
        stroke-width: 1.35;
      }

      .wqc-hotkey-manage-chevron {
        width: 11px;
        height: 11px;
        color: var(--wqc-muted);
        stroke-width: 1.5;
      }

      .wqc-hotkey-manage:hover {
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 6%, transparent);
        border-color: color-mix(in srgb, var(--bs-primary) 28%, var(--wqc-surface-border));
      }

      .wqc-hotkey-manage:hover .wqc-hotkey-manage-icon,
      .wqc-hotkey-manage:hover .wqc-hotkey-manage-chevron {
        color: var(--bs-primary);
      }

      .wqc-hotkey-manage:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--bs-primary) 62%, transparent);
        outline-offset: 2px;
      }

      .wqc-config-dialog-backdrop.wqc-hotkey-dialog-backdrop {
        z-index: 1080;
      }

      .wqc-config-dialog.wqc-hotkey-dialog {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto auto auto;
        width: min(820px, 100%);
        max-height: min(680px, calc(100vh - 40px));
        overflow: hidden;
        padding: 0;
      }

      .wqc-hotkey-dialog-header {
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 14px;
        border-bottom: 1px solid var(--wqc-surface-border);
      }

      .wqc-config-dialog .wqc-hotkey-dialog-header h4 {
        margin: 0;
        padding: 0;
        border: 0;
      }

      .wqc-hotkey-dialog-header-actions {
        display: inline-flex;
        flex: none;
        align-items: center;
        gap: 6px;
      }

      .wqc-hotkey-rules .wqc-help-icon {
        width: 14px;
        height: 14px;
        font-size: 10px;
      }

      .wqc-help-tooltip.wqc-hotkey-rules-tooltip {
        top: calc(100% + 8px);
        bottom: auto;
        right: -2px;
        width: min(390px, calc(100vw - 48px));
        text-align: left;
      }

      .wqc-hotkey-rules-tooltip > strong,
      .wqc-hotkey-rules-tooltip > span {
        display: block;
      }

      .wqc-hotkey-rules-tooltip > strong {
        margin-bottom: 5px;
        font-size: 12px;
      }

      .wqc-hotkey-rules-tooltip > span + span {
        margin-top: 3px;
      }

      .wqc-help-tooltip.wqc-hotkey-rules-tooltip::after {
        top: auto;
        bottom: 100%;
        right: 10px;
        transform: translateY(4px) rotate(225deg);
      }

      .wqc-hotkey-dialog-close {
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        color: var(--wqc-muted);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 7px;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }

      .wqc-hotkey-dialog-close:hover:not(:disabled) {
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 6%, transparent);
        border-color: var(--wqc-surface-border);
      }

      .wqc-hotkey-search {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        border-bottom: 1px solid color-mix(in srgb, var(--wqc-surface-border) 72%, transparent);
      }

      .wqc-hotkey-search-field {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
      }

      .wqc-hotkey-search-icon {
        position: absolute;
        left: 11px;
        top: 10px;
        width: 14px;
        height: 14px;
        color: var(--wqc-muted);
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.35;
        pointer-events: none;
      }

      .wqc-hotkey-search-input {
        width: 100%;
        height: 34px;
        padding: 6px 34px 6px 32px;
        font-size: 12px;
      }

      .wqc-hotkey-search-clear {
        position: absolute;
        top: 5px;
        right: 7px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        color: var(--wqc-muted);
        background: transparent;
        border: 0;
        border-radius: 5px;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
      }

      .wqc-hotkey-search-clear:hover,
      .wqc-hotkey-search-clear:focus-visible {
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 6%, transparent);
      }

      .wqc-hotkey-restore-all {
        flex: 0 0 auto;
        height: 34px;
        white-space: nowrap;
      }

      .wqc-hotkey-table-wrap {
        min-height: 0;
        overflow: auto;
      }

      .wqc-hotkey-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
        table-layout: fixed;
      }

      .wqc-hotkey-table th,
      .wqc-hotkey-table td {
        padding: 11px 10px;
        vertical-align: middle;
        border-bottom: 1px solid color-mix(in srgb, var(--wqc-surface-border) 76%, transparent);
        text-align: center;
      }

      .wqc-hotkey-table thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        color: var(--wqc-muted);
        background: var(--bs-body-bg);
        font-size: 11px;
        font-weight: 600;
      }

      .wqc-hotkey-table thead th:nth-child(1) { width: 30%; }
      .wqc-hotkey-table thead th:nth-child(2) { width: 14%; }
      .wqc-hotkey-table thead th:nth-child(3) { width: 20%; }
      .wqc-hotkey-table thead th:nth-child(4) { width: 12%; }
      .wqc-hotkey-table thead th:nth-child(5) { width: 24%; }

      .wqc-hotkey-table th:nth-child(2),
      .wqc-hotkey-table td:nth-child(2),
      .wqc-hotkey-table th:nth-child(4),
      .wqc-hotkey-table td:nth-child(4),
      .wqc-hotkey-table th:nth-child(5),
      .wqc-hotkey-table td:nth-child(5) {
        white-space: nowrap;
      }

      .wqc-hotkey-table th.wqc-hotkey-action-column {
        text-align: center;
      }

      .wqc-hotkey-group-row th {
        padding: 8px 10px;
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 3.5%, var(--bs-body-bg));
        border-bottom-color: var(--wqc-surface-border);
        text-align: left;
        font-size: 11px;
        font-weight: 600;
      }

      .wqc-hotkey-group-row th > span,
      .wqc-hotkey-group-row th > small {
        vertical-align: middle;
      }

      .wqc-hotkey-group-row th > small {
        margin-left: 7px;
        color: var(--wqc-muted);
        font-size: 10px;
        font-weight: 400;
      }

      .wqc-command-hotkey-group th {
        padding: 0;
        border-top: 1px solid var(--wqc-surface-border);
      }

      .wqc-hotkey-group-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 8px 10px;
        color: inherit;
        background: transparent;
        border: 0;
        border-radius: 0;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }

      .wqc-hotkey-group-toggle:hover,
      .wqc-hotkey-group-toggle:focus-visible {
        background: color-mix(in srgb, var(--bs-primary) 6%, transparent);
      }

      .wqc-hotkey-group-toggle:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--bs-primary) 42%, transparent);
        outline-offset: -2px;
      }

      .wqc-hotkey-group-label {
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }

      .wqc-hotkey-group-label > small {
        color: var(--wqc-muted);
        font-size: 10px;
        font-weight: 400;
      }

      .wqc-hotkey-group-toggle-action {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        color: var(--wqc-muted);
        font-size: 10px;
        font-weight: 400;
      }

      .wqc-hotkey-group-chevron {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.5;
        transition: transform 0.16s ease;
      }

      .wqc-hotkey-group-chevron.wqc-expanded {
        transform: rotate(180deg);
      }

      .wqc-hotkey-action-cell {
        text-align: center;
      }

      .wqc-hotkey-status-cell {
        white-space: nowrap;
      }

      .wqc-hotkey-table tbody tr:last-child td {
        border-bottom: 0;
      }

      .wqc-hotkey-no-results {
        padding: 30px 16px !important;
        color: var(--wqc-muted);
        text-align: center !important;
      }

      .wqc-hotkey-row-recording td {
        background: color-mix(in srgb, var(--bs-primary) 5%, transparent);
      }

      .wqc-hotkey-function-cell strong,
      .wqc-hotkey-function-cell small {
        display: block;
      }

      .wqc-hotkey-function-content {
        width: calc(100% - 16px);
        margin: 0 auto;
        text-align: left;
      }

      .wqc-hotkey-function-cell strong {
        font-size: 12px;
      }

      .wqc-hotkey-function-cell small {
        margin-top: 3px;
        color: var(--wqc-muted);
        font-size: 10px;
        line-height: 1.35;
      }

      .wqc-hotkey-scope {
        display: inline-block;
        padding: 2px 7px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 9%, transparent);
        border: 1px solid color-mix(in srgb, var(--bs-primary) 25%, var(--bs-border-color));
        border-radius: 999px;
        font-size: 9px;
        line-height: 1.35;
      }

      .wqc-hotkey-bindings {
        justify-content: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .wqc-hotkey-capture-preview {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 3px 7px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 7%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 38%, var(--bs-border-color));
        border-radius: 7px;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bs-primary) 5%, transparent);
      }

      .wqc-hotkey-capture-waiting {
        color: var(--wqc-muted);
        font-size: 10px;
      }

      .wqc-hotkey-capture-key {
        min-width: 24px;
        padding: 3px 6px;
        color: var(--bs-body-color);
        background: var(--bs-body-bg);
        border: 1px solid color-mix(in srgb, var(--bs-primary) 28%, var(--bs-border-color));
        border-radius: 5px;
        box-shadow: 0 1px 0 color-mix(in srgb, var(--bs-body-color) 15%, transparent);
        font: 600 10px "Cascadia Code", Consolas, monospace;
        text-align: center;
      }

      .wqc-hotkey-capture-plus {
        margin: 0 3px;
        color: var(--wqc-muted);
        font-size: 9px;
      }

      .wqc-hotkey-binding {
        display: inline-flex;
        align-items: center;
        overflow: hidden;
        background: var(--bs-body-bg);
        border: 1px solid var(--bs-border-color);
        border-radius: 6px;
      }

      .wqc-hotkey-binding kbd {
        padding: 4px 7px;
        color: var(--bs-body-color);
        background: transparent;
        font: 600 11px "Cascadia Code", Consolas, monospace;
      }

      .wqc-hotkey-binding button {
        align-self: stretch;
        width: 26px;
        padding: 0;
        color: var(--wqc-muted);
        background: transparent;
        border: 0;
        border-left: 1px solid var(--bs-border-color);
        cursor: pointer;
      }

      .wqc-hotkey-binding button:hover {
        color: var(--bs-danger);
        background: color-mix(in srgb, var(--bs-danger) 9%, transparent);
      }

      .wqc-hotkey-binding button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .wqc-command-hotkey-binding kbd {
        padding-right: 7px;
      }

      .wqc-hotkey-binding-conflict {
        border-color: color-mix(in srgb, var(--bs-warning) 64%, var(--bs-border-color));
      }

      .wqc-hotkey-binding-captured {
        animation: wqc-hotkey-captured 900ms ease-out;
      }

      @keyframes wqc-hotkey-captured {
        0% {
          border-color: var(--bs-primary);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--bs-primary) 22%, transparent);
        }
        100% {
          border-color: var(--bs-border-color);
          box-shadow: 0 0 0 0 transparent;
        }
      }

      .wqc-hotkey-empty,
      .wqc-hotkey-note {
        color: var(--wqc-muted);
        font-size: 11px;
      }

      .wqc-hotkey-conflict {
        color: color-mix(in srgb, var(--bs-warning) 78%, var(--bs-body-color));
        font-size: 10px;
        line-height: 1.35;
      }

      .wqc-hotkey-conflict-state {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }

      .wqc-hotkey-conflict-detail {
        position: relative;
        padding: 1px 3px;
        color: var(--bs-primary);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: help;
        font: inherit;
        font-size: 9px;
        line-height: 1.35;
        text-decoration: underline dotted;
        text-underline-offset: 2px;
      }

      .wqc-hotkey-conflict-detail:hover,
      .wqc-hotkey-conflict-detail:focus-visible {
        outline: 0;
        background: color-mix(in srgb, var(--bs-primary) 8%, transparent);
      }

      .wqc-help-tooltip.wqc-hotkey-conflict-tooltip {
        top: 50%;
        right: calc(100% + 7px);
        bottom: auto;
        width: max-content;
        max-width: 270px;
        padding: 7px 9px;
        text-align: left;
        white-space: normal;
        transform: translate(4px, -50%);
      }

      .wqc-hotkey-conflict-tooltip::after {
        display: none;
      }

      .wqc-hotkey-conflict-detail:hover .wqc-hotkey-conflict-tooltip,
      .wqc-hotkey-conflict-detail:focus-visible .wqc-hotkey-conflict-tooltip {
        visibility: visible;
        opacity: 1;
        transform: translate(0, -50%);
      }

      .wqc-hotkey-status-ok {
        color: var(--wqc-muted);
        font-size: 10px;
      }

      .wqc-hotkey-row-actions {
        justify-content: center;
        gap: 6px;
      }

      .wqc-hotkey-row-actions .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 58px;
        min-height: 28px;
        padding: 4px 7px;
        font-size: 10px;
        text-align: center;
        white-space: nowrap;
      }

      .wqc-hotkey-row-actions .wqc-hotkey-recording {
        color: var(--bs-primary);
        border-color: var(--bs-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-primary) 13%, transparent);
      }

      .wqc-hotkey-clear {
        padding: 3px 2px;
        color: var(--wqc-muted);
        background: transparent;
        border: 0;
        cursor: pointer;
        font-size: 10px;
      }

      .wqc-hotkey-clear:hover:not(:disabled) {
        color: var(--bs-danger);
      }

      .wqc-hotkey-clear:disabled {
        cursor: default;
        opacity: 0.42;
      }

      .wqc-hotkey-command-open {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 28px;
        flex: none;
        padding: 0;
        color: var(--wqc-muted);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 1;
      }

      .wqc-hotkey-command-open:hover:not(:disabled),
      .wqc-hotkey-command-open:focus-visible:not(:disabled) {
        z-index: 50;
        outline: 0;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 7%, transparent);
        border-color: color-mix(in srgb, var(--bs-primary) 24%, transparent);
      }

      .wqc-hotkey-command-open:disabled {
        cursor: default;
        opacity: 0.42;
      }

      .wqc-hotkey-command-floating-tooltip {
        position: fixed;
        z-index: 1100;
        width: max-content;
        max-width: 210px;
        padding: 7px 9px;
        color: var(--bs-body-color);
        background: var(--bs-body-bg);
        border: 1px solid var(--bs-border-color);
        border-radius: 7px;
        box-shadow: 0 9px 24px rgba(0, 0, 0, 0.18);
        font-size: 11px;
        font-weight: 400;
        line-height: 1.45;
        pointer-events: none;
        text-align: left;
        white-space: normal;
        transform: translate(-100%, -100%);
      }

      .wqc-hotkey-note {
        padding: 9px 18px 14px;
        border-top: 1px solid color-mix(in srgb, var(--wqc-surface-border) 65%, transparent);
      }

      .wqc-hotkey-dialog-message {
        margin: 9px 18px 0;
        padding: 8px 10px;
        color: color-mix(in srgb, var(--bs-warning) 82%, var(--bs-body-color));
        background: color-mix(in srgb, var(--bs-warning) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--bs-warning) 34%, var(--wqc-surface-border));
        border-radius: 7px;
        font-size: 11px;
      }

      .wqc-config-transfer {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
      }

      .wqc-config-feedback {
        position: relative;
        display: flex;
        flex: 1 1 0;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .wqc-config-actions .btn {
        flex: 0 0 auto;
        width: auto;
        min-width: 0;
        white-space: nowrap;
      }

      .wqc-reset-config {
        margin-left: auto;
      }

      .wqc-hidden-file {
        display: none;
      }

      .wqc-config-message {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 6px 8px 6px 10px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 8%, transparent);
        border-radius: 7px;
        font-size: 12px;
        line-height: 1.5;
      }

      .wqc-config-message-text {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .wqc-config-message-has-detail {
        cursor: help;
        text-decoration: underline dotted;
        text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
        text-underline-offset: 3px;
      }

      .wqc-config-message-has-detail:focus-visible {
        outline: 2px solid var(--wqc-accent);
        outline-offset: 3px;
        border-radius: 2px;
      }

      .wqc-config-message-close {
        display: inline-flex;
        flex: 0 0 22px;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        color: inherit;
        background: transparent;
        border: 0;
        border-radius: 4px;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.75;
      }

      .wqc-config-message-close:hover,
      .wqc-config-message-close:focus-visible {
        background: color-mix(in srgb, var(--bs-primary) 14%, transparent);
        opacity: 1;
      }

      .wqc-config-message-close:focus-visible {
        outline: 2px solid var(--wqc-accent);
        outline-offset: 2px;
      }

      .wqc-section h4 {
        font-size: 15px;
        margin-bottom: 12px;
      }

      .wqc-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 14px;
      }

      .wqc-grid:last-child {
        margin-bottom: 0;
      }

      .wqc-settings-group-title {
        margin: 14px 0 5px;
        color: var(--wqc-muted);
        font-size: 11px;
        font-weight: 650;
        letter-spacing: 0.04em;
      }

      .wqc-settings-group-title-first {
        margin-top: 0;
      }

      .wqc-settings-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow: visible;
      }

      .wqc-settings-subgrid {
        display: block;
      }

      .wqc-settings-subgroup {
        min-width: 0;
      }

      .wqc-settings-subgroup + .wqc-settings-subgroup {
        margin-top: 14px;
      }

      .wqc-setting-row {
        position: relative;
        display: grid;
        grid-template-columns: minmax(190px, 240px) minmax(280px, 420px);
        align-items: center;
        column-gap: 18px;
        min-width: 0;
        min-height: 44px;
        margin: 0 -8px;
        padding: 6px 8px;
        border-radius: 6px;
        transition: background-color 120ms ease;
      }

      .wqc-setting-row:hover {
        background: color-mix(in srgb, var(--bs-body-color) 4%, transparent);
      }

      .wqc-setting-row:focus-within {
        background: color-mix(in srgb, var(--wqc-accent) 7%, transparent);
      }

      .wqc-setting-label {
        display: flex;
        align-items: center;
        min-width: 0;
        min-height: 20px;
        color: var(--wqc-text);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.4;
      }

      .wqc-setting-control {
        width: 100%;
      }

      .wqc-setting-number {
        width: 100%;
        font-variant-numeric: tabular-nums;
      }

      .wqc-number-input {
        appearance: textfield;
        -moz-appearance: textfield;
      }

      .wqc-number-input::-webkit-inner-spin-button,
      .wqc-number-input::-webkit-outer-spin-button {
        margin: 0;
        appearance: none;
      }

      .wqc-segmented {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(0, 1fr);
        width: 100%;
        padding: 3px;
        background: color-mix(in srgb, var(--bs-body-color) 5%, var(--bs-body-bg));
        border: 1px solid var(--wqc-control-border);
        border-radius: 8px;
      }

      .wqc-segmented button {
        min-height: 28px;
        padding: 4px 8px;
        color: var(--wqc-muted);
        text-align: center;
        white-space: nowrap;
        background: transparent;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
      }

      .wqc-segmented button:hover:not(.wqc-selected) {
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-color) 5%, transparent);
      }

      .wqc-segmented button.wqc-selected {
        color: var(--wqc-accent);
        background: var(--bs-body-bg);
        box-shadow: 0 1px 3px color-mix(in srgb, var(--bs-body-color) 15%, transparent);
        font-weight: 650;
      }

      .wqc-segmented button:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--wqc-accent) 55%, transparent);
        outline-offset: 1px;
      }

      label,
      .wqc-field {
        display: grid;
        gap: 7px;
        font-size: 13px;
      }

      .wqc-field-label {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .wqc-help {
        position: relative;
        display: inline-flex;
        outline: 0;
      }

      .wqc-help-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 17px;
        height: 17px;
        color: var(--bs-secondary-color);
        background: color-mix(in srgb, var(--bs-body-color) 5%, transparent);
        border: 1px solid color-mix(in srgb, var(--bs-secondary-color) 55%, var(--bs-border-color));
        border-radius: 50%;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        cursor: help;
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
      }

      .wqc-help:hover .wqc-help-icon,
      .wqc-help:focus-visible .wqc-help-icon {
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 10%, var(--bs-body-bg));
        border-color: color-mix(in srgb, var(--bs-primary) 55%, var(--bs-border-color));
      }

      .wqc-help-tooltip {
        position: absolute;
        bottom: calc(100% + 9px);
        right: -8px;
        z-index: 40;
        width: min(340px, calc(100vw - 48px));
        padding: 10px 12px;
        visibility: hidden;
        color: var(--bs-body-color);
        background: var(--bs-body-bg);
        border: 1px solid var(--bs-border-color);
        border-radius: 8px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
        font-size: 12px;
        font-weight: 400;
        line-height: 1.65;
        opacity: 0;
        pointer-events: none;
        transform: translateY(4px);
        transition: opacity 140ms ease, transform 140ms ease, visibility 140ms ease;
      }

      .wqc-help-tooltip::after {
        position: absolute;
        top: 100%;
        right: 11px;
        width: 8px;
        height: 8px;
        content: '';
        background: var(--bs-body-bg);
        border-right: 1px solid var(--bs-border-color);
        border-bottom: 1px solid var(--bs-border-color);
        transform: translateY(-4px) rotate(45deg);
      }

      .wqc-setting-help {
        position: static;
      }

      .wqc-setting-help .wqc-help-tooltip {
        left: 8px;
        right: auto;
        width: min(420px, calc(100vw - 64px));
        overflow-wrap: anywhere;
      }

      .wqc-setting-help .wqc-help-tooltip::after {
        display: none;
      }

      .wqc-help-tooltip.wqc-status-tooltip-content {
        right: 0;
        width: max-content;
        max-width: min(240px, calc(100vw - 48px));
        padding: 8px 10px;
        line-height: 1.5;
      }

      .wqc-help:hover .wqc-help-tooltip,
      .wqc-help:focus-visible .wqc-help-tooltip {
        visibility: visible;
        opacity: 1;
        transform: translateY(0);
      }

      .wqc-help-tooltip.wqc-config-message-tooltip {
        left: 0;
        right: auto;
        width: max-content;
        max-width: min(340px, 100%);
        text-decoration: none;
        cursor: auto;
      }

      .wqc-config-message-tooltip::after {
        left: 12px;
        right: auto;
      }

      .wqc-config-message-tooltip::before {
        position: absolute;
        top: 100%;
        left: 0;
        width: 100%;
        height: 9px;
        content: '';
      }

      .wqc-config-message-tooltip-body {
        display: block;
        max-height: min(240px, 45vh);
        overflow-y: auto;
        overflow-wrap: anywhere;
        white-space: normal;
      }

      .wqc-config-message-has-detail:hover .wqc-config-message-tooltip,
      .wqc-config-message-has-detail:focus-visible .wqc-config-message-tooltip,
      .wqc-config-message-has-detail:focus-within .wqc-config-message-tooltip {
        visibility: visible;
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }

      @container wqc-config (max-width: 420px) {
        .wqc-config-actions,
        .wqc-config-transfer,
        .wqc-config-feedback {
          gap: 6px;
        }

        .wqc-config-actions .btn {
          padding-right: 4px;
          padding-left: 4px;
          font-size: 12px;
        }

        .wqc-config-actions .wqc-reset-config {
          max-width: 76px;
          white-space: normal;
        }

        .wqc-config-message {
          gap: 4px;
          padding-right: 6px;
          padding-left: 6px;
        }

        .wqc-config-message-close {
          flex-basis: 20px;
          width: 20px;
          height: 20px;
        }
      }

      .wqc-check {
        grid-template-columns: 16px minmax(0, 1fr);
        align-items: center;
        min-height: 36px;
        cursor: pointer;
        transition: color 150ms ease;
      }

      .wqc-check-with-help {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
      }

      .wqc-check-with-help .wqc-check {
        flex: 1;
        min-height: 0;
      }

      .wqc-check:hover {
        color: color-mix(in srgb, var(--bs-primary) 72%, var(--bs-body-color));
      }

      .wqc-check input {
        width: 16px;
        height: 16px;
      }

      textarea.form-control {
        resize: vertical;
      }

      .wqc-settings .form-control {
        color: var(--wqc-text);
        background-color: var(--bs-body-bg);
        border-color: var(--wqc-control-border);
        transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
      }

      .wqc-settings .btn-secondary {
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-bg) 92%, var(--wqc-text) 8%);
        border-color: var(--wqc-control-border);
      }

      .wqc-settings .btn-secondary:hover,
      .wqc-settings .btn-secondary:focus-visible {
        color: var(--wqc-accent);
        background: color-mix(in srgb, var(--bs-body-bg) 86%, var(--wqc-accent) 14%);
        border-color: var(--wqc-accent);
      }

      .wqc-settings .form-control::placeholder {
        color: var(--wqc-muted);
        opacity: 1;
      }

      .wqc-header-toggle small,
      .wqc-help-icon,
      .wqc-field-hint,
      .wqc-count,
      .wqc-pill,
      .wqc-selection-count,
      .wqc-stat-header {
        color: var(--wqc-muted);
      }

      .wqc-config-message,
      .wqc-stat-count {
        color: var(--wqc-accent);
      }

      .wqc-settings input.form-control:hover,
      .wqc-settings textarea.form-control:hover {
        border-color: color-mix(in srgb, var(--bs-primary) 30%, var(--wqc-control-border));
        background-color: color-mix(in srgb, var(--bs-primary) 3%, var(--bs-body-bg));
      }

      .wqc-settings input.form-control:focus,
      .wqc-settings textarea.form-control:focus {
        outline: 0;
        border-color: var(--wqc-accent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wqc-accent) 28%, transparent);
      }

      .wqc-select-shell {
        position: relative;
        display: block;
      }

      .wqc-select-shell::after {
        --wqc-select-chevron-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        position: absolute;
        top: 50%;
        right: 13px;
        width: 10px;
        height: 6px;
        background: var(--bs-secondary-color);
        content: '';
        -webkit-mask: var(--wqc-select-chevron-mask) center / contain no-repeat;
        mask: var(--wqc-select-chevron-mask) center / contain no-repeat;
        pointer-events: none;
        transform: translateY(-50%);
        transform-origin: center;
        transition: transform 120ms ease;
        z-index: 2;
      }

      .wqc-select-shell.wqc-open::after {
        transform: translateY(-50%) rotate(180deg);
      }

      .wqc-select {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: 36px;
        padding-right: 36px;
        text-align: left;
        cursor: pointer;
        transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
      }

      .wqc-select:hover {
        border-color: color-mix(in srgb, var(--bs-primary) 38%, var(--wqc-control-border));
        background: color-mix(in srgb, var(--bs-primary) 6%, var(--bs-body-bg));
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      }

      .wqc-select:focus {
        border-color: var(--bs-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-primary) 18%, transparent);
      }

      .wqc-select-menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        z-index: 20;
        display: grid;
        gap: 3px;
        padding: 5px;
        overflow: hidden;
        color: var(--wqc-text);
        background: var(--bs-body-bg);
        border: 1px solid var(--wqc-control-border);
        border-radius: 9px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
      }

      .wqc-select-menu button {
        min-height: 34px;
        padding: 7px 10px;
        color: inherit;
        text-align: left;
        background: transparent;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
      }

      .wqc-select-menu button:hover,
      .wqc-select-menu button:focus-visible {
        outline: 0;
        background: color-mix(in srgb, var(--bs-primary) 11%, transparent);
        transform: translateX(2px);
      }

      .wqc-select-menu button.wqc-selected {
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 15%, transparent);
        font-weight: 600;
      }

      .wqc-actions {
        display: flex;
        align-items: end;
        gap: 10px;
        flex-wrap: wrap;
      }

      .wqc-actions .btn {
        transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
      }

      .wqc-actions .btn:hover {
        border-color: color-mix(in srgb, var(--bs-primary) 35%, var(--bs-border-color));
        box-shadow: 0 5px 14px rgba(0, 0, 0, 0.1);
        transform: translateY(-1px);
      }

      .wqc-section-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
      }

      .wqc-section-head h4 {
        margin-bottom: 0;
      }

      .wqc-count,
      .wqc-pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 8px;
        color: var(--bs-secondary-color);
        background: color-mix(in srgb, var(--bs-body-color) 5%, var(--bs-body-bg));
        border: 1px solid var(--bs-border-color);
        border-radius: 999px;
        font-size: 11px;
        white-space: nowrap;
      }

      .wqc-stat-list {
        overflow: hidden;
        border: 1px solid var(--wqc-surface-border);
        border-radius: 9px;
      }

      .wqc-command-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }

      .wqc-command-filters {
        display: grid;
        gap: 10px;
        margin-bottom: 12px;
      }

      .wqc-command-filter-options {
        display: grid;
        grid-template-columns: minmax(180px, 240px) minmax(180px, 240px) auto;
        gap: 10px;
        align-items: center;
      }

      .wqc-command-filters > .form-control,
      .wqc-command-filter-options .form-control,
      .wqc-command-filter-options .btn {
        min-height: 36px;
        font-size: 12px;
      }

      .wqc-filter-select {
        min-width: 0;
      }

      .wqc-filter-select .wqc-select > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wqc-filter-select .wqc-select-menu {
        max-height: 260px;
        overflow-x: hidden;
        overflow-y: auto;
      }

      .wqc-command-filter-options > .btn {
        justify-self: start;
        min-width: 88px;
      }

      .wqc-config-dialog-backdrop {
        position: fixed;
        z-index: 1070;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.46);
        backdrop-filter: blur(2px);
      }

      .wqc-config-dialog {
        width: min(520px, 100%);
        max-height: calc(100vh - 40px);
        overflow-y: auto;
        padding: 18px 18px 12px;
        color: var(--wqc-text);
        background: var(--bs-body-bg);
        border: 1px solid var(--wqc-surface-border);
        border-radius: 10px;
        box-shadow: 0 22px 60px rgba(15, 23, 42, 0.24);
      }

      .wqc-config-dialog h4 {
        margin: 0;
        padding-bottom: 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--wqc-surface-border) 70%, transparent);
      }

      .wqc-config-dialog p {
        margin: 10px 0 0;
        color: var(--wqc-muted);
        font-size: 13px;
        line-height: 1.65;
      }

      .wqc-config-dialog-line {
        display: block;
      }

      .wqc-config-dialog.wqc-export-dialog {
        width: min(460px, 100%);
      }

      .wqc-export-field {
        display: grid;
        gap: 7px;
        margin-top: 16px;
        color: var(--wqc-text);
        font-size: 13px;
        font-weight: 500;
      }

      .wqc-config-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
        padding-top: 8px;
        border-top: 1px solid color-mix(in srgb, var(--wqc-surface-border) 70%, transparent);
      }

      .wqc-reset-initial-entry {
        margin-right: auto;
      }

      .wqc-reset-text-action {
        appearance: none;
        padding: 7px 0;
        border: 0;
        background: none;
        box-shadow: none;
        color: var(--wqc-muted);
        font: inherit;
        cursor: pointer;
        text-decoration: none;
        text-underline-offset: 3px;
      }

      .wqc-reset-text-action:hover,
      .wqc-reset-text-action:focus-visible {
        color: var(--wqc-text);
        text-decoration: underline;
      }

      .wqc-reset-text-action:focus-visible {
        outline: 2px solid var(--wqc-accent);
        outline-offset: 3px;
      }

      .wqc-reset-warning {
        margin-top: 16px;
        padding: 13px 15px;
        background: color-mix(in srgb, var(--bs-danger) 8%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-danger) 38%, var(--bs-border-color));
        border-radius: 8px;
      }

      .wqc-reset-warning strong,
      .wqc-config-dialog .wqc-reset-error {
        color: var(--bs-danger);
      }

      .wqc-reset-warning ul {
        padding-left: 20px;
        margin: 8px 0 0;
        font-size: 13px;
        line-height: 1.75;
      }

      .wqc-reset-path {
        display: grid;
        gap: 5px;
        margin-top: 14px;
        font-size: 12px;
        color: var(--wqc-muted);
      }

      .wqc-reset-path code {
        padding: 8px 10px;
        overflow-wrap: anywhere;
        white-space: normal;
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-body-color) 5%, var(--bs-body-bg));
        border-radius: 5px;
      }

      .wqc-reset-acknowledge {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-top: 16px;
        font-size: 13px;
        line-height: 1.6;
        cursor: pointer;
      }

      .wqc-reset-acknowledge input {
        flex: none;
        margin-top: 4px;
      }

      .wqc-selection-count {
        margin-right: auto;
        color: var(--bs-secondary-color);
        font-size: 12px;
      }

      .wqc-command-toolbar .btn,
      .wqc-batch-confirm .btn {
        min-height: 32px;
        font-size: 12px;
      }

      .wqc-danger-button {
        color: var(--bs-danger);
        background: color-mix(in srgb, var(--bs-danger) 7%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-danger) 42%, var(--bs-border-color));
      }

      .wqc-danger-button:not(:disabled):hover {
        color: #fff;
        background: var(--bs-danger);
        border-color: var(--bs-danger);
      }

      .wqc-danger-button:disabled {
        opacity: 0.45;
      }

      .wqc-batch-confirm {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        padding: 10px 12px;
        color: var(--bs-danger);
        background: color-mix(in srgb, var(--bs-danger) 7%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-danger) 34%, var(--bs-border-color));
        border-radius: 8px;
        font-size: 12px;
      }

      .wqc-batch-move {
        display: grid;
        grid-template-columns: auto minmax(190px, 1fr) auto;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
        padding: 10px 12px;
        color: var(--wqc-text);
        background: color-mix(in srgb, var(--bs-primary) 7%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 30%, var(--wqc-surface-border));
        border-radius: 8px;
        font-size: 12px;
      }

      .wqc-batch-move-select {
        min-width: 0;
      }

      .wqc-batch-move-select .wqc-select > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wqc-batch-move-select .wqc-select-menu {
        max-height: 230px;
        overflow-x: hidden;
        overflow-y: auto;
      }

      .wqc-batch-confirm-actions {
        display: flex;
        gap: 8px;
        flex: none;
      }

      .wqc-stat-row {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr) 92px 180px;
        gap: 14px;
        align-items: center;
        min-height: 48px;
        padding: 9px 12px;
        border-top: 1px solid var(--bs-border-color);
        font-size: 12px;
      }

      .wqc-stat-row:first-child {
        border-top: 0;
      }

      .wqc-command-check {
        display: grid;
        place-content: center;
        appearance: none;
        width: 16px;
        min-width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        background: var(--bs-body-bg);
        border: 1px solid color-mix(in srgb, var(--bs-secondary-color) 58%, var(--bs-border-color));
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }

      .wqc-command-check::before {
        width: 8px;
        height: 5px;
        border-bottom: 2px solid #fff;
        border-left: 2px solid #fff;
        content: '';
        transform: translateY(-1px) rotate(-45deg) scale(0);
        transition: transform 100ms ease;
      }

      .wqc-command-check:hover {
        border-color: var(--bs-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-primary) 12%, transparent);
      }

      .wqc-command-check:checked,
      .wqc-command-check:indeterminate,
      .wqc-command-check.wqc-checked,
      .wqc-command-check.wqc-indeterminate {
        background: var(--bs-primary);
        border-color: var(--bs-primary);
      }

      .wqc-command-check:checked::before,
      .wqc-command-check.wqc-checked::before {
        transform: translateY(-1px) rotate(-45deg) scale(1);
      }

      .wqc-command-check:indeterminate::before,
      .wqc-command-check.wqc-indeterminate::before {
        width: 8px;
        height: 2px;
        background: #fff;
        border: 0;
        transform: scale(1);
      }

      .wqc-command-check:disabled {
        cursor: not-allowed;
        opacity: 0.42;
      }

      .wqc-stat-row:not(.wqc-stat-header) {
        transition: background-color 120ms ease, box-shadow 120ms ease;
      }

      .wqc-stat-row-selected {
        background: color-mix(in srgb, var(--bs-primary) 9%, var(--bs-body-bg));
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--bs-primary) 75%, transparent);
      }

      .wqc-stat-header {
        min-height: 36px;
        color: var(--bs-secondary-color);
        background: color-mix(in srgb, var(--bs-body-color) 4%, var(--bs-body-bg));
        font-size: 11px;
        font-weight: 600;
      }

      .wqc-stat-command {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .wqc-stat-command strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wqc-stat-count {
        color: var(--bs-primary);
        font-size: 14px;
      }

      .wqc-stat-time.wqc-muted {
        margin-top: 0;
      }

      .wqc-empty {
        padding: 22px 12px;
        color: var(--bs-secondary-color);
        text-align: center;
        font-size: 12px;
      }

      .wqc-pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 12px;
        color: var(--bs-secondary-color);
        font-size: 12px;
      }

      .wqc-pager .btn {
        min-width: 72px;
      }

      @media (prefers-reduced-motion: reduce) {
        .wqc-settings .form-control,
        .wqc-select-menu button,
        .wqc-actions .btn {
          transition: none;
        }

        .wqc-update-history-spinner {
          animation: none;
        }

        .wqc-select:hover,
        .wqc-select-menu button:hover,
        .wqc-actions .btn:hover {
          transform: none;
        }
      }

      @media (max-width: 760px) {
        .wqc-settings {
          padding: 14px 16px 22px;
        }

        .wqc-grid {
          grid-template-columns: 1fr;
        }

        .wqc-setting-row {
          grid-template-columns: minmax(150px, 200px) minmax(0, 1fr);
        }

        .wqc-plugin-footer {
          align-items: flex-start;
        }

        .wqc-stat-row {
          grid-template-columns: 20px minmax(0, 1fr) 72px;
        }

        .wqc-stat-header span:last-child,
        .wqc-stat-time {
          display: none;
        }

        .wqc-batch-confirm {
          align-items: stretch;
          flex-direction: column;
        }

        .wqc-batch-confirm-actions {
          justify-content: flex-end;
        }

        .wqc-batch-move {
          grid-template-columns: 1fr;
          align-items: stretch;
        }

        .wqc-command-filter-options {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        }

      }

      @media (max-width: 520px) {
        .wqc-setting-row {
          grid-template-columns: minmax(0, 1fr);
          row-gap: 6px;
        }

        .wqc-hotkey-summary-row {
          align-items: stretch;
          flex-direction: column;
        }

        .wqc-hotkey-summary-copy {
          align-items: flex-start;
          flex-direction: column;
          gap: 5px;
        }

        .wqc-hotkey-manage {
          width: 100%;
        }

        .wqc-hotkey-dialog-backdrop {
          padding: 10px;
        }

        .wqc-config-dialog.wqc-hotkey-dialog {
          max-height: calc(100vh - 20px);
        }

        .wqc-hotkey-search {
          flex-wrap: wrap;
        }

        .wqc-hotkey-search-field {
          flex-basis: 240px;
        }

        .wqc-update-history-backdrop {
          padding: 10px;
        }

        .wqc-update-history-dialog {
          max-height: calc(100vh - 20px);
        }

        .wqc-update-history-header,
        .wqc-update-history-body,
        .wqc-update-history-footer {
          padding-right: 12px;
          padding-left: 12px;
        }

        .wqc-update-history-summary {
          flex-wrap: wrap;
        }

        .wqc-update-history-summary time {
          order: 3;
          width: 100%;
          margin-left: 0;
        }

        .wqc-update-history-expand {
          margin-left: auto;
        }

        .wqc-update-section .wqc-section-head {
          align-items: stretch;
          flex-direction: column;
        }

        .wqc-update-head-actions {
          justify-content: flex-end;
          align-self: stretch;
        }

        .wqc-plugin-footer {
          flex-direction: column;
        }

        .wqc-update-card-check {
          justify-content: space-between;
          width: 100%;
        }

        .wqc-update-card-check .wqc-update-feedback {
          max-width: 100%;
        }

        .wqc-update-check-control {
          justify-content: space-between;
          width: 100%;
          margin-left: 0;
        }

        .wqc-update-check-status {
          max-width: calc(100% - 88px);
        }

        .wqc-update-summary {
          align-items: flex-start;
          flex-direction: column;
        }

        .wqc-update-summary-actions {
          justify-content: flex-end;
          width: 100%;
        }

        .wqc-update-actions {
          align-items: stretch;
          flex-direction: column;
        }

        .wqc-update-actions .wqc-update-button-hint,
        .wqc-update-actions .wqc-update-button-hint > .btn {
          width: 100%;
        }

        .wqc-config-dialog-actions {
          align-items: stretch;
          flex-direction: column-reverse;
        }

        .wqc-reset-actions {
          flex-direction: row;
          flex-wrap: wrap;
        }

        .wqc-command-filter-options {
          grid-template-columns: 1fr;
        }

        .wqc-command-filter-options > .btn {
          justify-self: stretch;
        }
      }
    `],
})
export class QuickCommandsSettingsTabComponent implements AfterViewInit, OnDestroy {
    readonly pluginTitle = pluginIdentity.title
    readonly defaultExportFileName = pluginIdentity.exportFileName
    readonly pluginHotkeyDefinitions = pluginHotkeyDefinitions
    recordingHotkeyAction: PluginHotkeyAction | null = null
    recordingCommandHotkeyId: string | null = null
    recordingPressedKeys: string[] = []
    pluginHotkeyDialogOpen = false
    pluginHotkeySaving = false
    pluginHotkeyDialogError = ''
    pluginHotkeySearchQuery = ''
    commandHotkeySectionExpanded = false
    hotkeyCommandTooltip: { text: string, left: number, top: number } | null = null
    failureMenuOpen = false
    updateIntervalMenuOpen = false
    commandCategoryMenuOpen = false
    commandUsageMenuOpen = false
    commandQuery = ''
    commandCategory = 'all'
    commandUsage: 'all' | 'used' | 'unused' = 'all'
    commandPage = 1
    batchDeleteConfirmOpen = false
    batchMoveOpen = false
    batchMoveCategoryMenuOpen = false
    batchMoveCategory = ''
    exportConfigDialogOpen = false
    exportFileNameDraft = ''
    pendingConfigImport: PluginConfigImportFile | null = null
    resetDefaultsConfirmOpen = false
    resetInitialConfirmOpen = false
    resetInitialAcknowledged = false
    resetInitialError = ''
    resetInProgress = false
    selectedCommandIds = new Set<string>()
    runtimeLogs: ActivityLogEntry[] = []
    activityLogSizeBytes = 0
    runtimeStats: CommandUsageStats = {}
    configMessage = ''
    configMessageDetail = ''
    readonly projectUrl = 'https://github.com/windyy0/tabby-windy-quick-commands'
    readonly issuesUrl = 'https://github.com/windyy0/tabby-windy-quick-commands/issues'
    updateState: PluginUpdateState
    updateCheckInterval: UpdateCheckInterval
    showUpdateCheckStatus = false
    updateDetailsExpanded = false
    updateHistoryOpen = false
    updateHistoryState: PluginUpdateHistoryState = { status: 'idle', entries: [], error: '' }
    expandedHistoryVersions = new Set<string>()
    private historyExpansionInitialized = false
    private configMessageTimer: ReturnType<typeof setTimeout> | null = null
    private updateCheckStatusTimer: ReturnType<typeof setTimeout> | null = null
    private capturedHotkeyTimer: ReturnType<typeof setTimeout> | null = null
    private recordingPressedKeyMap = new Map<string, string>()
    private recordingShortcutCandidate = ''
    private recordingShortcutAttempted = false
    private recordingPrimaryKeyId = ''
    private recentlyCapturedHotkey: { kind: 'plugin' | 'command', targetId: string, shortcut: string } | null = null
    private runtimeStore: QuickCommandsRuntimeStore
    private activityLog: ActivityLogService
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private pluginConfig: Record<string, any>
    private savedConfigSnapshot: string
    private pluginHotkeyDraft: PluginHotkeyExport | null = null
    private commandHotkeyDraft: Record<string, string> | null = null
    private hotkeyConflictCache: HotkeyConflictCache | null = null
    private tabbyHotkeysDisabledForCapture = false
    private stopLocalizing: (() => void) | null = null
    private readonly subscriptions = new Subscription()

    constructor (
        private platform: PlatformService,
        private changeDetector: ChangeDetectorRef,
        private element: ElementRef<HTMLElement>,
        private i18n: QuickCommandsI18n,
        private zone: NgZone,
        private pluginUpdate: QuickCommandsPluginUpdateService,
        private quickCommands: QuickCommandsService,
        private tabbyConfig: ConfigService,
        @Optional() private hotkeys?: HotkeysService,
    ) {
        this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
        this.activityLog = new ActivityLogService(this.platform.getConfigPath())
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
        this.pluginConfig = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language))
        this.savedConfigSnapshot = JSON.stringify(this.pluginConfig)
        this.updateState = this.pluginUpdate.snapshot
        this.updateCheckInterval = this.pluginUpdate.checkInterval
        this.subscriptions.add(this.pluginUpdate.state$.subscribe(state => {
            this.updateState = state
            this.changeDetector.markForCheck()
        }))
        this.updateHistoryState = this.pluginUpdate.historyState$.value
        this.subscriptions.add(this.pluginUpdate.historyState$.subscribe(state => {
            this.updateHistoryState = state
            if (state.status === 'ready' && state.entries.length && !this.historyExpansionInitialized) {
                this.expandedHistoryVersions.add(state.entries[0].version)
                this.historyExpansionInitialized = true
            }
            this.changeDetector.markForCheck()
        }))
        this.subscriptions.add(this.tabbyConfig.changed$.subscribe(() => {
            this.invalidateHotkeyConflictCache()
            if (this.pluginHotkeyDialogOpen && !this.pluginHotkeySaving && this.pluginHotkeyDraftDirty) {
                this.stopHotkeyCapture()
                this.reloadPluginHotkeyDraft()
            }
            this.changeDetector.markForCheck()
        }))
        this.refreshRuntimeData()
    }

    ngAfterViewInit (): void {
        this.startLocalizing()
        this.subscriptions.add(this.i18n.localeChanged$.subscribe(() => {
            this.startLocalizing()
        }))
        if (this.pluginUpdate.consumeSettingsFocusRequest()) {
            window.setTimeout(() => this.scrollToUpdateSettings())
        }
    }

    ngOnDestroy (): void {
        this.dismissConfigMessage()
        this.dismissUpdateCheckStatus()
        this.clearCapturedHotkeyFeedback()
        this.stopHotkeyCapture()

        this.stopLocalizing?.()
        this.subscriptions.unsubscribe()
    }

    private startLocalizing (): void {
        this.stopLocalizing?.()
        this.zone.runOutsideAngular(() => {
            this.stopLocalizing = this.i18n.observe(this.element.nativeElement)
        })
    }

    get root (): any {
        return this.pluginConfig
    }

    get commandCount (): number {
        return Array.isArray(this.root.commands) ? this.root.commands.length : 0
    }

    get logCount (): number {
        return this.runtimeLogs.length
    }

    get activityLogRetention (): ActivityLogRetentionSettings {
        return normalizeActivityLogRetention(this.root)
    }

    get allCommandStats (): any[] {
        return Array.isArray(this.root.commands)
            ? this.root.commands.map((command: any) => ({
                ...command,
                usageCount: this.runtimeStats[command.id]?.usageCount || 0,
                lastUsedAt: this.runtimeStats[command.id]?.lastUsedAt || null,
            })).sort((a: any, b: any) => (
                this.timeValue(b.lastUsedAt) - this.timeValue(a.lastUsedAt) ||
                (Number(b.usageCount) || 0) - (Number(a.usageCount) || 0) ||
                String(a.name).localeCompare(String(b.name), 'zh-CN')
            ))
            : []
    }

    get commandStats (): any[] {
        const query = this.commandQuery.trim().toLowerCase()
        return this.allCommandStats.filter(command => {
            if (this.commandCategory !== 'all' && String(command.category || '未分类') !== this.commandCategory) {
                return false
            }
            const used = (Number(command.usageCount) || 0) > 0
            if ((this.commandUsage === 'used' && !used) || (this.commandUsage === 'unused' && used)) {
                return false
            }
            if (!query) {
                return true
            }
            return [command.name, command.description, command.command, command.category, command.shortcut]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(query)
        })
    }

    get commandCategories (): string[] {
        return Array.from(new Set(this.allCommandStats.map(command => String(command.category || '未分类'))))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    }

    get moveCategories (): string[] {
        const customCategories = Array.isArray(this.root.customCategories) ? this.root.customCategories : []
        return Array.from(new Set([
            ...customCategories,
            ...this.allCommandStats.map(command => String(command.category || '未分类')),
        ].filter(category => category && category !== '全部' && category !== '常用' && category !== '收藏')))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    }

    get commandFiltersActive (): boolean {
        return Boolean(this.commandQuery.trim() || this.commandCategory !== 'all' || this.commandUsage !== 'all')
    }

    get commandCategoryLabel (): string {
        return this.commandCategory === 'all' ? '全部分类' : this.commandCategory
    }

    get commandUsageLabel (): string {
        if (this.commandUsage === 'used') {
            return '使用过'
        }
        if (this.commandUsage === 'unused') {
            return '从未使用'
        }
        return '全部使用状态'
    }

    get commandPageCount (): number {
        return Math.max(1, Math.ceil(this.commandStats.length / 6))
    }

    get commandPageNumber (): number {
        return Math.min(this.commandPage, this.commandPageCount)
    }

    get pagedCommandStats (): any[] {
        const start = (this.commandPageNumber - 1) * 6
        return this.commandStats.slice(start, start + 6)
    }

    get selectedCommandCount (): number {
        return this.allCommandStats.filter(command => this.selectedCommandIds.has(command.id)).length
    }

    get allCommandsSelected (): boolean {
        return this.commandStats.length > 0 && this.commandStats.every(command => this.selectedCommandIds.has(command.id))
    }

    get currentPageSelected (): boolean {
        return this.pagedCommandStats.length > 0 && this.pagedCommandStats.every(command => this.selectedCommandIds.has(command.id))
    }

    get currentPagePartiallySelected (): boolean {
        const selected = this.pagedCommandStats.filter(command => this.selectedCommandIds.has(command.id)).length
        return selected > 0 && selected < this.pagedCommandStats.length
    }

    get failureStrategyLabel (): string {
        if (this.root.failureStrategy === 'continue') {
            return '继续执行'
        }
        if (this.root.failureStrategy === 'stop') {
            return '停止执行'
        }
        return '手动确认'
    }

    @HostListener('document:click')
    closeFailureMenu (): void {
        this.failureMenuOpen = false
        this.updateIntervalMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
        this.batchMoveCategoryMenuOpen = false
    }

    @HostListener('document:keydown.escape', ['$event'])
    closeFailureMenuOnEscape (event?: KeyboardEvent): void {
        if (this.recordingHotkeyAction || this.recordingCommandHotkeyId || (this.pluginHotkeyDialogOpen && event?.defaultPrevented)) { return }
        if (this.pluginHotkeyDialogOpen) {
            this.closePluginHotkeyDialog()
            return
        }
        if (this.exportConfigDialogOpen) {
            this.closeExportPluginConfig()
            return
        }
        this.failureMenuOpen = false
        this.updateIntervalMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
        this.batchDeleteConfirmOpen = false
        this.batchMoveOpen = false
        this.batchMoveCategoryMenuOpen = false
        this.pendingConfigImport = null
        this.closeResetDefaultsConfirm()
        this.updateHistoryOpen = false
    }

    @HostListener(`window:${runtimeChangedEvent}`)
    refreshRuntimeData (): void {
        this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
        this.activityLog = new ActivityLogService(this.platform.getConfigPath())
        this.runtimeLogs = this.activityLog.getEntries()
        this.activityLogSizeBytes = this.activityLog.storage.getSizeBytes()
        this.runtimeStats = this.runtimeStore.getStats()
    }

    @HostListener(`window:${pluginConfigChangedEvent}`)
    refreshPluginConfig (): void {
        this.pluginConfig = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        this.savedConfigSnapshot = JSON.stringify(this.pluginConfig)
        this.updateCheckInterval = this.pluginUpdate.checkInterval
        this.invalidateHotkeyConflictCache()
        if (this.pluginHotkeyDialogOpen && !this.pluginHotkeySaving && this.commandHotkeyDraftDirty) {
            this.stopHotkeyCapture()
            this.reloadCommandHotkeyDraft()
        }
    }

    @HostListener('document:keydown', ['$event'])
    capturePluginHotkey (event: KeyboardEvent): void {
        const action = this.recordingHotkeyAction
        const commandId = this.recordingCommandHotkeyId
        if ((!action && !commandId) || !this.pluginHotkeyDialogOpen || !this.pluginHotkeyDraft || event.isComposing) { return }
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.repeat) {
            return
        }
        const keyId = this.hotkeyEventId(event)
        if (this.recordingPressedKeyMap.has(keyId)) { return }
        const previewKey = this.hotkeyPreviewKey(event.key)
        if (!previewKey) { return }
        this.recordingPressedKeyMap.set(keyId, previewKey)
        this.syncRecordingPressedKeys()
        if (!this.isHotkeyModifier(event.key)) {
            if (this.recordingShortcutAttempted) {
                this.recordingShortcutCandidate = ''
            } else {
                this.recordingShortcutAttempted = true
                this.recordingPrimaryKeyId = keyId
                this.recordingShortcutCandidate = shortcutFromKeyboardEvent(event) || (
                    action === 'switchFocus' && event.key === 'Escape' ? 'Escape' : ''
                )
            }
        }
        this.changeDetector.markForCheck()
    }

    @HostListener('document:keyup', ['$event'])
    async finishPluginHotkeyKey (event: KeyboardEvent): Promise<void> {
        if (!this.isCapturingHotkey || event.isComposing) { return }
        event.preventDefault()
        event.stopImmediatePropagation()
        const primaryKeyReleased = this.recordingShortcutAttempted && this.hotkeyEventId(event) === this.recordingPrimaryKeyId
        this.releaseRecordedHotkeyKey(event)
        this.syncRecordingPressedKeys()
        if (primaryKeyReleased) {
            await this.finishHotkeyCaptureAttempt()
            return
        }
        if (this.recordingPressedKeyMap.size || this.recordingShortcutAttempted) {
            this.changeDetector.markForCheck()
            return
        }
        await this.finishHotkeyCaptureAttempt()
    }

    @HostListener('window:blur')
    resetPressedHotkeysOnBlur (): void {
        if (!this.isCapturingHotkey) { return }
        this.resetHotkeyPressState()
        this.changeDetector.markForCheck()
    }

    private async finishHotkeyCaptureAttempt (): Promise<void> {
        const action = this.recordingHotkeyAction
        const commandId = this.recordingCommandHotkeyId
        const shortcut = this.recordingShortcutCandidate
        const attempted = this.recordingShortcutAttempted
        this.resetHotkeyPressState()
        if (!attempted) {
            this.changeDetector.markForCheck()
            return
        }
        if (!shortcut || !isValidShortcut(shortcut, action === 'switchFocus')) {
            this.pluginHotkeyDialogError = this.i18n.text(action === 'switchFocus'
                ? '焦点切换可使用 Escape、功能键或包含 Ctrl、Alt、Meta 的组合键。'
                : '快捷键需包含 Ctrl、Alt、Meta，或直接使用功能键。')
            this.changeDetector.markForCheck()
            return
        }
        if (commandId) {
            const previousShortcut = this.getCommandHotkey(commandId)
            this.setCommandHotkeyDraft(commandId, shortcut)
            const conflict = this.getCommandHotkeyConflict(commandId)
            if (conflict) {
                this.setCommandHotkeyDraft(commandId, previousShortcut)
                this.stopHotkeyCapture()
                this.pluginHotkeyDialogError = this.i18n.text(conflict)
                this.changeDetector.markForCheck()
                return
            }
            this.pluginHotkeyDialogError = ''
            this.markCapturedHotkey('command', commandId, shortcut)
            this.stopHotkeyCapture()
            await this.persistHotkeyDialogChanges()
            this.changeDetector.markForCheck()
            return
        }
        const bindingId = pluginHotkeyBindingId(shortcut)
        const duplicate = pluginHotkeyDefinitions.find(definition => (
            this.getPluginHotkeys(definition.action)
                .some(binding => pluginHotkeyBindingId(binding) === bindingId)
        ))
        if (duplicate) {
            this.stopHotkeyCapture()
            this.pluginHotkeyDialogError = this.i18n.text(`该快捷键已绑定到“${duplicate.title}”。`)
            this.changeDetector.markForCheck()
            return
        }
        const previousBindings = this.getPluginHotkeys(action!).map(binding => (
            Array.isArray(binding) ? [...binding] : binding
        ))
        this.setPluginHotkeyDraftBindings(action!, [...previousBindings, normalizeShortcut(shortcut)])
        const conflict = this.getPluginHotkeyConflict(action!, shortcut)
        if (conflict) {
            this.setPluginHotkeyDraftBindings(action!, previousBindings)
            this.stopHotkeyCapture()
            this.pluginHotkeyDialogError = this.i18n.text(conflict)
            this.changeDetector.markForCheck()
            return
        }
        this.pluginHotkeyDialogError = ''
        this.markCapturedHotkey('plugin', action!, shortcut)
        this.stopHotkeyCapture()
        await this.persistHotkeyDialogChanges()
        this.changeDetector.markForCheck()
    }

    @HostListener(`window:${pluginDataResetEvent}`)
    refreshAfterDataReset (): void {
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
        this.refreshPluginConfig()
        this.refreshRuntimeData()
        this.selectedCommandIds.clear()
        this.commandQuery = ''; this.commandCategory = 'all'; this.commandUsage = 'all'; this.commandPage = 1
        this.pendingConfigImport = null
        this.batchDeleteConfirmOpen = false
        this.closeBatchMove()
        this.pluginHotkeyDialogOpen = false
        this.pluginHotkeyDraft = null
        this.commandHotkeyDraft = null
        this.pluginHotkeyDialogError = ''
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.expandedHistoryVersions.clear()
        this.historyExpansionInitialized = false
        this.updateHistoryOpen = false
    }

    get updateStatusLabel (): string {
        if (this.updateState.status === 'checking') {
            return '检查中…'
        }
        if (this.updateState.status === 'available') {
            return this.updateState.latestVersion ? `发现新版本 v${this.updateState.latestVersion}` : '发现新版本'
        }
        if (this.updateState.status === 'current') {
            return '已是最新版本'
        }
        if (this.updateState.status === 'installing') {
            return '正在更新…'
        }
        if (this.updateState.status === 'restart') {
            return '更新完成，请重启 Tabby'
        }
        if (this.updateState.status === 'error') {
            return `检查失败：${this.updateState.error || '请稍后重试'}`
        }
        return ''
    }

    toggleUpdateDetails (): void {
        this.updateDetailsExpanded = !this.updateDetailsExpanded
    }

    checkForUpdates (): void {
        void this.pluginUpdate.checkNow()
    }

    checkForUpdatesWithStatus (): void {
        this.showUpdateCheckStatus = true
        this.clearUpdateCheckStatusTimer()
        const scheduleStatusDismissal = (): void => {
            if (!this.showUpdateCheckStatus) { return }
            this.updateCheckStatusTimer = setTimeout(() => {
                this.dismissUpdateCheckStatus()
                this.changeDetector.detectChanges()
            }, 30_000)
        }
        void this.pluginUpdate.checkNow().then(scheduleStatusDismissal, scheduleStatusDismissal)
    }

    dismissUpdateCheckStatus (): void {
        this.clearUpdateCheckStatusTimer()
        this.showUpdateCheckStatus = false
    }

    private clearUpdateCheckStatusTimer (): void {
        if (this.updateCheckStatusTimer !== null) {
            clearTimeout(this.updateCheckStatusTimer)
        }
        this.updateCheckStatusTimer = null
    }

    scrollToUpdateSettings (): void {
        this.scrollTo('#wqc-plugin-update')
    }

    scrollToSettingsTop (): void {
        this.scrollTo('.wqc-settings')
    }

    get canInstallUpdate (): boolean {
        return this.pluginUpdate.canInstallUpdate
    }

    get updateInstallDisabledHint (): string {
        if (!this.canInstallUpdate) {
            return this.i18n.text('Dev 版本不能在线更新，请更新本地代码后重新安装 Dev。')
        }
        if (this.updateState.status === 'installing') {
            return this.i18n.text('正在安装更新，请稍候。')
        }
        if (this.updateState.status === 'restart') {
            return this.i18n.text('更新已安装，请重启 Tabby。')
        }
        return ''
    }

    installUpdate (): void {
        void this.pluginUpdate.installLatest()
    }

    ignoreCurrentUpdate (): void {
        this.pluginUpdate.ignoreLatest()
    }

    openUpdateHistory (): void {
        this.updateHistoryOpen = true
        void this.pluginUpdate.loadHistory()
    }

    closeUpdateHistory (): void {
        this.updateHistoryOpen = false
    }

    reloadUpdateHistory (): void {
        this.expandedHistoryVersions.clear()
        this.historyExpansionInitialized = false
        void this.pluginUpdate.loadHistory(true)
    }

    toggleHistoryVersion (version: string): void {
        if (this.expandedHistoryVersions.has(version)) {
            this.expandedHistoryVersions.delete(version)
        } else {
            this.expandedHistoryVersions.add(version)
        }
    }

    isHistoryVersionExpanded (version: string): boolean {
        return this.expandedHistoryVersions.has(version)
    }

    formatHistoryDate (value: string): string {
        const date = new Date(value)
        if (!Number.isFinite(date.getTime())) {
            return ''
        }
        return historyDateFormatters[this.i18n.language].format(date)
    }

    get updateCheckIntervalLabel (): string {
        if (this.updateCheckInterval === 'startup') {
            return '客户端启动时'
        }
        if (this.updateCheckInterval === 'weekly') {
            return '每周'
        }
        if (this.updateCheckInterval === 'never') {
            return '从不'
        }
        return '每天'
    }

    toggleUpdateIntervalMenu (): void {
        this.updateIntervalMenuOpen = !this.updateIntervalMenuOpen
        this.failureMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
        this.batchMoveCategoryMenuOpen = false
    }

    selectUpdateCheckInterval (interval: UpdateCheckInterval): void {
        this.updateIntervalMenuOpen = false
        this.root.updateCheckInterval = interval
        if (this.save()) { this.updateCheckInterval = interval }
    }

    private scrollTo (selector: string): void {
        this.element.nativeElement.querySelector<HTMLElement>(selector)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    toggleFailureMenu (): void {
        this.failureMenuOpen = !this.failureMenuOpen
        this.updateIntervalMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
    }

    setFailureStrategy (strategy: 'continue' | 'stop' | 'manual'): void {
        this.root.failureStrategy = strategy
        this.failureMenuOpen = false
        this.save()
    }

    setCommandQuery (event: Event): void {
        this.commandQuery = (event.target as HTMLInputElement).value
        this.resetCommandFilterPage()
    }

    toggleCommandCategoryMenu (): void {
        this.commandCategoryMenuOpen = !this.commandCategoryMenuOpen
        this.updateIntervalMenuOpen = false
        this.commandUsageMenuOpen = false
        this.failureMenuOpen = false
    }

    toggleCommandUsageMenu (): void {
        this.commandUsageMenuOpen = !this.commandUsageMenuOpen
        this.updateIntervalMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.failureMenuOpen = false
    }

    setCommandCategory (category: string): void {
        this.commandCategory = category
        this.commandCategoryMenuOpen = false
        this.resetCommandFilterPage()
    }

    setCommandUsage (usage: string): void {
        this.commandUsage = usage === 'used' || usage === 'unused' ? usage : 'all'
        this.commandUsageMenuOpen = false
        this.resetCommandFilterPage()
    }

    clearCommandFilters (): void {
        this.commandQuery = ''
        this.commandCategory = 'all'
        this.commandUsage = 'all'
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
        this.resetCommandFilterPage()
    }

    previousCommandPage (): void {
        this.commandPage = Math.max(1, this.commandPageNumber - 1)
    }

    nextCommandPage (): void {
        this.commandPage = Math.min(this.commandPageCount, this.commandPageNumber + 1)
    }

    isCommandSelected (commandId: string): boolean {
        return this.selectedCommandIds.has(commandId)
    }

    toggleCommandSelection (commandId: string): void {
        if (this.selectedCommandIds.has(commandId)) {
            this.selectedCommandIds.delete(commandId)
        } else {
            this.selectedCommandIds.add(commandId)
        }
        this.selectedCommandIds = new Set(this.selectedCommandIds)
        this.batchDeleteConfirmOpen = false
    }

    toggleCurrentPageSelection (): void {
        const selected = !this.currentPageSelected
        this.pagedCommandStats.forEach(command => {
            if (selected) {
                this.selectedCommandIds.add(command.id)
            } else {
                this.selectedCommandIds.delete(command.id)
            }
        })
        this.selectedCommandIds = new Set(this.selectedCommandIds)
        this.batchDeleteConfirmOpen = false
    }

    selectAllCommands (): void {
        const selected = new Set(this.selectedCommandIds)
        this.commandStats.forEach(command => selected.add(command.id))
        this.selectedCommandIds = selected
        this.batchDeleteConfirmOpen = false
    }

    clearCommandSelection (): void {
        this.selectedCommandIds = new Set<string>()
        this.batchDeleteConfirmOpen = false
        this.closeBatchMove()
    }

    openBatchMove (): void {
        if (!this.selectedCommandCount) {
            return
        }
        this.batchDeleteConfirmOpen = false
        this.batchMoveOpen = true
        this.batchMoveCategory = ''
        this.batchMoveCategoryMenuOpen = true
    }

    closeBatchMove (): void {
        this.batchMoveOpen = false
        this.batchMoveCategoryMenuOpen = false
        this.batchMoveCategory = ''
    }

    toggleBatchMoveCategoryMenu (): void {
        this.batchMoveCategoryMenuOpen = !this.batchMoveCategoryMenuOpen
        this.updateIntervalMenuOpen = false
    }

    selectBatchMoveCategory (category: string): void {
        this.batchMoveCategory = category
        this.batchMoveCategoryMenuOpen = false
    }

    moveSelectedCommands (): void {
        const category = this.batchMoveCategory
        const count = this.selectedCommandCount
        if (!category || !count) {
            return
        }
        const selectedIds = new Set(this.selectedCommandIds)
        this.root.commands = (Array.isArray(this.root.commands) ? this.root.commands : []).map((command: any) => (
            selectedIds.has(command.id) ? { ...command, category } : command
        ))
        this.root.selectedCategory = category
        this.commandCategory = category
        this.commandUsage = 'all'
        this.commandQuery = ''
        this.commandPage = 1
        this.clearCommandSelection()
        if (this.save()) {
            this.recordActivity({
                category: 'command', action: 'command.move', status: 'success', message: '已批量移动命令',
                subject: { type: 'category', name: category }, details: { commandCount: count, to: category },
            })
        }
    }

    openBatchDeleteConfirm (): void {
        this.closeBatchMove()
        this.batchDeleteConfirmOpen = this.selectedCommandCount > 0
    }

    closeBatchDeleteConfirm (): void {
        this.batchDeleteConfirmOpen = false
    }

    deleteSelectedCommands (): void {
        const selectedIds = new Set(
            this.allCommandStats
                .map(command => command.id)
                .filter(commandId => this.selectedCommandIds.has(commandId)),
        )
        if (!selectedIds.size) {
            this.clearCommandSelection()
            return
        }

        const commands = Array.isArray(this.root.commands) ? this.root.commands : []
        const remaining = commands
            .filter((command: any) => !selectedIds.has(command.id))
            .map((command: any) => ({
                ...command,
                automationRules: Array.isArray(command.automationRules)
                    ? command.automationRules.map((rule: any) => ({
                        ...rule,
                        onMatchCommandId: selectedIds.has(rule.onMatchCommandId) ? '' : rule.onMatchCommandId,
                        onErrorCommandId: selectedIds.has(rule.onErrorCommandId) ? '' : rule.onErrorCommandId,
                        onTimeoutCommandId: selectedIds.has(rule.onTimeoutCommandId) ? '' : rule.onTimeoutCommandId,
                    }))
                    : [],
            }))
        this.root.commands = remaining
        if (selectedIds.has(this.root.selectedCommandId)) {
            this.root.selectedCommandId = remaining[0]?.id || null
        }

        if (!this.save()) { return }
        const deletedCount = selectedIds.size
        const stats = this.runtimeStore.getStats()
        selectedIds.forEach(commandId => delete stats[commandId])
        this.runtimeStore.setStats(stats)
        this.runtimeStats = stats
        this.commandPage = Math.min(this.commandPage, Math.max(1, Math.ceil(remaining.length / 6)))
        this.clearCommandSelection()
        this.recordActivity({
            category: 'command', action: 'command.delete', status: 'success', message: '已批量删除命令',
            subject: { type: 'command', name: `${deletedCount} 条命令` }, details: { commandCount: deletedCount },
        })
    }

    openLogLocation (): void {
        const directory = this.activityLog.ensureDirectory()
        if (directory) {
            this.platform.openPath(directory)
        }
    }

    openExternal (event: Event, url: string): void {
        event.preventDefault()
        this.platform.openExternal(url)
    }

    openExportPluginConfig (): void {
        this.exportFileNameDraft = String(this.root.exportFileName || this.defaultExportFileName)
        this.exportConfigDialogOpen = true
        window.setTimeout(() => {
            this.element.nativeElement.querySelector<HTMLInputElement>('.wqc-export-file-name')?.focus()
        })
    }

    closeExportPluginConfig (): void {
        this.exportConfigDialogOpen = false
        this.exportFileNameDraft = ''
    }

    setExportFileNameDraft (event: Event): void {
        this.exportFileNameDraft = (event.target as HTMLInputElement).value
    }

    confirmExportPluginConfig (event?: Event): void {
        event?.preventDefault()
        const fileNamePattern = this.exportFileNameDraft.trim()
        if (!fileNamePattern) {
            return
        }
        if (fileNamePattern !== this.root.exportFileName) {
            this.root.exportFileName = fileNamePattern
            if (!this.save()) {
                this.exportFileNameDraft = String(this.root.exportFileName || this.defaultExportFileName)
                return
            }
        }
        const payload = this.pluginConfigStore.exportPayload({
            ...this.root,
            pluginHotkeys: buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys),
        })
        const text = JSON.stringify(payload, null, 2)
        const fileName = this.renderExportConfigFileName(fileNamePattern)
        this.closeExportPluginConfig()
        try {
            this.downloadJson(text, fileName)
            this.showConfigMessage('已触发插件配置文件下载，请检查下载目录。')
            this.recordActivity({
                category: 'library', action: 'library.export', status: 'success', message: '插件配置导出成功',
                subject: { type: 'library', name: fileName }, details: { commandCount: this.commandCount },
            })
        } catch {
            this.showConfigMessage('无法触发配置文件下载，请重试。')
            this.recordActivity({
                category: 'library', action: 'library.export', status: 'failure', message: '插件配置导出失败',
                subject: { type: 'library', name: fileName },
            })
        }
    }

    private renderExportConfigFileName (pattern: string): string {
        const date = new Date().toISOString().slice(0, 10)
        const rendered = pattern.replace(/\{date\}/g, date)
        const name = rendered.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || `${pluginIdentity.packageName}-config-${date}.json`
        return /\.json$/i.test(name) ? name : `${name}.json`
    }

    async importPluginConfig (event: Event): Promise<void> {
        const store = this.pluginConfigStore
        const input = event.target as HTMLInputElement
        const file = input.files?.[0]
        input.value = ''
        if (!file) {
            return
        }
        try {
            if (file.size > 5 * 1024 * 1024) {
                throw new Error('配置文件不能超过 5MB。')
            }
            const text = await file.text()
            if (store !== this.pluginConfigStore || !store.dataAccess.isCurrent()) { return }
            const parsed = store.parseImportFile(text)
            if (parsed.kind === 'commands' && !parsed.commands.length) {
                throw new Error('导入文件里没有命令。')
            }
            this.pendingConfigImport = parsed
        } catch (error) {
            if (store !== this.pluginConfigStore || !store.dataAccess.isCurrent()) { return }
            const reason = error instanceof Error ? error.message : '配置文件无效。'
            this.showConfigMessage('导入失败', reason)
            this.recordActivity({
                category: 'library', action: 'library.import', status: 'failure', message: '插件配置导入失败',
                subject: { type: 'library', name: file.name }, details: { reason },
            })
        }
    }

    cancelPendingConfigImport (): void {
        this.pendingConfigImport = null
    }

    importPendingCommands (): void {
        const pending = this.pendingConfigImport
        if (!pending) {
            return
        }
        const createId = this.createImportIdFactory()
        const existing = (Array.isArray(this.root.commands) ? this.root.commands : [])
            .map((command: Partial<QuickCommand>) => normalizeCommandConfig(command, createId))
        const imported = pending.commands.map(command => normalizeCommandConfig(command, createId))
        const preview = buildImportPreview(existing, imported, {
            customCategories: pending.customCategories,
            categoryOrder: pending.categoryOrder,
            version: pending.version,
        })
        const sanitized = sanitizeAutomationReferences(applyImportPreview(existing, preview, 'merge'))
        const commands = sanitized.commands.map(command => this.stripCommandRuntime(command))
        const categories = new Set([
            '全部', '常用', '收藏',
            ...(Array.isArray(this.root.customCategories) ? this.root.customCategories : []),
            ...pending.customCategories,
            ...commands.map(command => command.category),
        ])
        const selectedCategory = categories.has(this.root.selectedCategory) ? this.root.selectedCategory : '全部'
        const selectedCommandId = commands.some(command => command.id === this.root.selectedCommandId)
            ? this.root.selectedCommandId
            : commands[0]?.id || null
        const next = {
            ...this.root,
            commands,
            customCategories: Array.from(new Set([
                ...(Array.isArray(this.root.customCategories) ? this.root.customCategories : []),
                ...pending.customCategories,
            ])),
            categoryOrder: Array.from(new Set([
                ...(Array.isArray(this.root.categoryOrder) ? this.root.categoryOrder : []),
                ...pending.categoryOrder,
            ])),
            selectedCommandId,
            selectedCategory,
        }
        if (!this.applyImportedConfig(next, '导入失败')) { return }
        this.pendingConfigImport = null
        this.showConfigMessage('导入成功')
        this.recordActivity({
            category: 'library', action: 'library.import', status: 'success', message: '命令导入成功',
            subject: { type: 'library', name: '合并导入' }, details: { commandCount: imported.length, mode: 'merge' },
        })
    }

    async importPendingFullConfig (): Promise<void> {
        const imported = this.pendingConfigImport?.config
        if (!imported) {
            return
        }
        const previousHotkeys = buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys)
        if (imported.pluginHotkeys !== undefined) {
            let hotkeys: PluginHotkeyExport
            try {
                hotkeys = parsePluginHotkeyExport(imported.pluginHotkeys)
            } catch (error) {
                this.showConfigMessage('导入失败', error instanceof Error ? error.message : '插件快捷键配置无效。')
                return
            }
            if (!await this.persistPluginHotkeyExport(hotkeys, '导入失败')) { return }
        }
        if (!this.applyImportedConfig(imported, '导入失败')) {
            if (imported.pluginHotkeys !== undefined) {
                await this.persistPluginHotkeyExport(previousHotkeys, '快捷键回滚失败')
            }
            return
        }
        this.pendingConfigImport = null
        this.showConfigMessage('导入成功')
        this.recordActivity({
            category: 'library', action: 'library.import', status: 'success', message: '插件配置导入成功',
            subject: { type: 'library', name: '完整配置' }, details: { commandCount: this.commandCount, mode: 'replace' },
        })
    }

    openResetDefaultsConfirm (): void {
        this.resetInitialConfirmOpen = false
        this.resetInitialAcknowledged = false
        this.resetInitialError = ''
        this.resetDefaultsConfirmOpen = true
    }

    closeResetDefaultsConfirm (): void {
        if (this.resetInProgress) { return }
        this.resetDefaultsConfirmOpen = false
        this.resetInitialConfirmOpen = false
        this.resetInitialAcknowledged = false
        this.resetInitialError = ''
    }

    get pluginDataDirectory (): string {
        return this.quickCommands.dataDirectory || this.i18n.text('无法定位插件数据目录，未清理数据。')
    }

    openResetInitialConfirm (): void {
        if (!this.resetDefaultsConfirmOpen) { return }
        this.resetInitialConfirmOpen = true
        this.resetInitialAcknowledged = false
        this.resetInitialError = ''
    }

    backToResetDefaults (): void {
        if (this.resetInProgress) { return }
        this.resetInitialConfirmOpen = false
        this.resetInitialAcknowledged = false
        this.resetInitialError = ''
    }

    setResetInitialAcknowledged (event: Event): void {
        this.resetInitialAcknowledged = (event.target as HTMLInputElement).checked
    }

    restoreInitialState (): void {
        if (!this.resetDefaultsConfirmOpen || !this.resetInitialConfirmOpen || !this.resetInitialAcknowledged || this.resetInProgress) { return }
        this.resetInProgress = true
        this.resetInitialError = ''
        try {
            this.quickCommands.restoreInitialState()
            this.refreshAfterDataReset()
            this.resetDefaultsConfirmOpen = false
            this.resetInitialConfirmOpen = false
            this.showConfigMessage('已重置插件数据，并按当前语言创建默认分类和示例命令。按钮显示设置将在重启 Tabby 后生效。')
        } catch (error) {
            this.resetInitialError = this.i18n.text(error instanceof Error ? error.message : String(error))
        } finally {
            this.resetInProgress = false
            this.resetInitialAcknowledged = false
        }
    }

    async restoreDefaultSettings (): Promise<void> {
        if (!this.resetDefaultsConfirmOpen || this.resetInitialConfirmOpen) { return }
        const restored = buildDefaultSettingsConfig(this.root, defaultQuickCommandsConfig)
        const previousHotkeys = buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys)
        const hotkeysRestored = await this.persistPluginHotkeyExport(buildDefaultPluginHotkeyExport(), '恢复失败')
        const success = hotkeysRestored && this.applyImportedConfig(restored, '恢复失败')
        if (hotkeysRestored && !success) {
            await this.persistPluginHotkeyExport(previousHotkeys, '快捷键回滚失败')
        }
        this.closeResetDefaultsConfirm()
        if (success) {
            this.showConfigMessage('恢复成功', '已恢复默认配置，现有命令、分类和输出触发器已保留。按钮显示设置将在重启 Tabby 后生效。')
            this.recordActivity({
                category: 'settings', action: 'settings.reset', status: 'success', message: '已恢复默认设置',
                subject: { type: 'settings', name: this.pluginTitle },
            })
        }
    }

    setInitialFocusValue (value: 'drawer' | 'terminal'): void {
        this.root.drawerInitialFocus = value
        this.save()
    }

    getPluginHotkeys (action: PluginHotkeyAction): PluginHotkeyBinding[] {
        if (this.pluginHotkeyDraft) {
            return this.pluginHotkeyDraft.actions[action]
        }
        return readPluginHotkeyBindings(this.tabbyConfig.store?.hotkeys, action)
    }

    get configuredPluginHotkeyActionCount (): number {
        return pluginHotkeyDefinitions.filter(item => this.getPluginHotkeys(item.action).length > 0).length
    }

    get pluginHotkeyConflictCount (): number {
        return pluginHotkeyDefinitions.filter(item => Boolean(this.getPluginHotkeyStatus(item.action))).length
    }

    get configuredCommandHotkeyCount (): number {
        return this.commandHotkeyCommands.filter(command => Boolean(this.getCommandHotkey(command.id))).length
    }

    get commandHotkeyConflictCount (): number {
        return this.commandHotkeyCommands.filter(command => Boolean(this.getCommandHotkeyConflict(command.id))).length
    }

    get hotkeyConflictCount (): number {
        return this.pluginHotkeyConflictCount + this.commandHotkeyConflictCount
    }

    get filteredPluginHotkeyDefinitions (): PluginHotkeyDefinition[] {
        const query = this.pluginHotkeySearchQuery.trim().toLocaleLowerCase()
        if (!query) { return pluginHotkeyDefinitions }
        return pluginHotkeyDefinitions.filter(item => {
            const bindings = this.getPluginHotkeys(item.action)
            const status = this.getPluginHotkeyStatus(item.action) || (bindings.length ? '正常' : '未绑定')
            const searchable = [
                item.title,
                item.description,
                item.scope,
                status,
                ...bindings.map(binding => formatPluginHotkeyBinding(binding)),
            ]
            return searchable.some(value => (
                value.toLocaleLowerCase().includes(query) ||
                this.i18n.text(value).toLocaleLowerCase().includes(query)
            ))
        })
    }

    get commandHotkeyCommands (): QuickCommand[] {
        return Array.isArray(this.root.commands) ? this.root.commands : []
    }

    get filteredCommandHotkeyCommands (): QuickCommand[] {
        const query = this.pluginHotkeySearchQuery.trim().toLocaleLowerCase()
        if (!query) { return this.commandHotkeyCommands }
        return this.commandHotkeyCommands.filter(command => {
            const shortcut = this.getCommandHotkey(command.id)
            const status = this.getCommandHotkeyConflict(command.id) || (shortcut ? '正常' : '未绑定')
            return [
                command.name,
                command.description,
                command.command,
                command.category,
                shortcut,
                status,
                'Tabby全局',
            ].filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(query))
        })
    }

    get commandHotkeyRowsVisible (): boolean {
        return this.commandHotkeySectionExpanded || Boolean(this.pluginHotkeySearchQuery.trim())
    }

    get pluginHotkeyDraftDirty (): boolean {
        return Boolean(this.pluginHotkeyDraft) &&
            this.pluginHotkeyExportId(this.pluginHotkeyDraft!) !== this.pluginHotkeyExportId(
                buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys),
            )
    }

    get commandHotkeyDraftDirty (): boolean {
        if (!this.commandHotkeyDraft) { return false }
        return this.commandHotkeyCommands.some(command => (
            this.getCommandHotkey(command.id) !== normalizeShortcut(command.shortcut || '')
        ))
    }

    get hotkeyDialogDirty (): boolean {
        return this.pluginHotkeyDraftDirty || this.commandHotkeyDraftDirty
    }

    get pluginHotkeyDraftIsDefault (): boolean {
        return Boolean(this.pluginHotkeyDraft) &&
            this.pluginHotkeyExportId(this.pluginHotkeyDraft!) === this.pluginHotkeyExportId(buildDefaultPluginHotkeyExport())
    }

    formatPluginHotkey (binding: PluginHotkeyBinding): string {
        return formatPluginHotkeyBinding(binding)
    }

    getPluginHotkeyConflict (action: PluginHotkeyAction, binding: PluginHotkeyBinding): string {
        return this.getHotkeyConflictCache().pluginBindings.get(
            this.pluginBindingConflictKey(action, binding),
        ) || ''
    }

    getPluginHotkeyStatus (action: PluginHotkeyAction): string {
        return this.getHotkeyConflictCache().pluginActions.get(action) || ''
    }

    getCommandHotkey (commandId: string): string {
        if (this.commandHotkeyDraft && Object.prototype.hasOwnProperty.call(this.commandHotkeyDraft, commandId)) {
            return this.commandHotkeyDraft[commandId]
        }
        const command = this.commandHotkeyCommands.find(item => item.id === commandId)
        return normalizeShortcut(command?.shortcut || '')
    }

    getCommandHotkeyConflict (commandId: string): string {
        return this.getHotkeyConflictCache().commands.get(commandId) || ''
    }

    get isCapturingHotkey (): boolean {
        return Boolean(this.recordingHotkeyAction || this.recordingCommandHotkeyId)
    }

    isRecentlyCapturedPluginHotkey (action: PluginHotkeyAction, binding: PluginHotkeyBinding): boolean {
        return this.recentlyCapturedHotkey?.kind === 'plugin' &&
            this.recentlyCapturedHotkey.targetId === action &&
            pluginHotkeyBindingId(binding) === pluginHotkeyBindingId(this.recentlyCapturedHotkey.shortcut)
    }

    isRecentlyCapturedCommandHotkey (commandId: string, shortcut: string): boolean {
        return this.recentlyCapturedHotkey?.kind === 'command' &&
            this.recentlyCapturedHotkey.targetId === commandId &&
            normalizeShortcut(shortcut) === normalizeShortcut(this.recentlyCapturedHotkey.shortcut)
    }

    openPluginHotkeyDialog (): void {
        this.reloadPluginHotkeyDraft()
        this.reloadCommandHotkeyDraft()
        this.pluginHotkeyDialogError = ''
        this.pluginHotkeySearchQuery = ''
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.commandHotkeySectionExpanded = false
        this.hotkeyCommandTooltip = null
        this.invalidateHotkeyConflictCache()
        this.pluginHotkeyDialogOpen = true
        window.setTimeout(() => {
            this.element.nativeElement.querySelector<HTMLElement>('.wqc-hotkey-search-input')?.focus()
        })
    }

    closePluginHotkeyDialog (restoreFocus = true): void {
        if (this.pluginHotkeySaving) { return }
        this.pluginHotkeyDialogOpen = false
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.pluginHotkeyDialogError = ''
        this.pluginHotkeySearchQuery = ''
        this.commandHotkeySectionExpanded = false
        this.hotkeyCommandTooltip = null
        this.pluginHotkeyDraft = null
        this.commandHotkeyDraft = null
        this.invalidateHotkeyConflictCache()
        if (restoreFocus) {
            window.setTimeout(() => {
                this.element.nativeElement.querySelector<HTMLElement>('.wqc-hotkey-manage')?.focus()
            })
        }
    }

    setPluginHotkeySearch (event: Event): void {
        this.pluginHotkeySearchQuery = (event.target as HTMLInputElement).value
        if (
            this.recordingHotkeyAction &&
            !this.filteredPluginHotkeyDefinitions.some(item => item.action === this.recordingHotkeyAction)
        ) {
            this.stopHotkeyCapture()
        }
        if (
            this.recordingCommandHotkeyId &&
            !this.filteredCommandHotkeyCommands.some(command => command.id === this.recordingCommandHotkeyId)
        ) {
            this.stopHotkeyCapture()
        }
    }

    clearPluginHotkeySearch (): void {
        this.pluginHotkeySearchQuery = ''
        window.setTimeout(() => {
            this.element.nativeElement.querySelector<HTMLInputElement>('.wqc-hotkey-search-input')?.focus()
        })
    }

    toggleCommandHotkeySection (): void {
        this.commandHotkeySectionExpanded = !this.commandHotkeySectionExpanded
        if (!this.commandHotkeySectionExpanded) {
            this.stopHotkeyCapture()
        }
    }

    startPluginHotkeyCapture (action: PluginHotkeyAction, event: Event): void {
        event.stopPropagation()
        if (!this.pluginHotkeyDialogOpen || !this.pluginHotkeyDraft || this.pluginHotkeySaving) { return }
        const cancelCapture = this.recordingHotkeyAction === action
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.pluginHotkeyDialogError = ''
        if (!cancelCapture) {
            this.recordingHotkeyAction = action
            this.suspendTabbyHotkeysForCapture()
        }
    }

    startCommandHotkeyCapture (commandId: string, event: Event): void {
        event.stopPropagation()
        if (!this.pluginHotkeyDialogOpen || !this.commandHotkeyDraft || this.pluginHotkeySaving) { return }
        const cancelCapture = this.recordingCommandHotkeyId === commandId
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.pluginHotkeyDialogError = ''
        if (!cancelCapture) {
            this.recordingCommandHotkeyId = commandId
            this.suspendTabbyHotkeysForCapture()
        }
    }

    private hotkeyEventId (event: KeyboardEvent): string {
        return event.code || event.key
    }

    private hotkeyPreviewKey (key: string): string {
        const modifiers: Record<string, string> = {
            Control: 'Ctrl',
            Alt: 'Alt',
            Shift: 'Shift',
            Meta: 'Meta',
        }
        return modifiers[key] || normalizeShortcutKey(key)
    }

    private isHotkeyModifier (key: string): boolean {
        return ['Control', 'Alt', 'Shift', 'Meta'].includes(key)
    }

    private releaseRecordedHotkeyKey (event: KeyboardEvent): void {
        if (this.recordingPressedKeyMap.delete(this.hotkeyEventId(event))) { return }
        const previewKey = this.hotkeyPreviewKey(event.key)
        const fallback = Array.from(this.recordingPressedKeyMap.entries()).find(([, key]) => key === previewKey)
        if (fallback) {
            this.recordingPressedKeyMap.delete(fallback[0])
        }
    }

    private syncRecordingPressedKeys (): void {
        const order: Record<string, number> = { Ctrl: 0, Alt: 1, Shift: 2, Meta: 3 }
        this.recordingPressedKeys = Array.from(new Set(this.recordingPressedKeyMap.values()))
            .sort((left, right) => (order[left] ?? 4) - (order[right] ?? 4))
    }

    private resetHotkeyPressState (): void {
        this.recordingPressedKeyMap.clear()
        this.recordingPressedKeys = []
        this.recordingShortcutCandidate = ''
        this.recordingShortcutAttempted = false
        this.recordingPrimaryKeyId = ''
    }

    private stopHotkeyCapture (): void {
        this.recordingHotkeyAction = null
        this.recordingCommandHotkeyId = null
        this.resetHotkeyPressState()
        this.resumeTabbyHotkeysAfterCapture()
    }

    private suspendTabbyHotkeysForCapture (): void {
        if (this.tabbyHotkeysDisabledForCapture) { return }
        this.hotkeys?.disable()
        this.tabbyHotkeysDisabledForCapture = true
        if (typeof document !== 'undefined') {
            document.documentElement?.setAttribute('data-windy-quick-commands-hotkey-recording', 'true')
        }
    }

    private resumeTabbyHotkeysAfterCapture (): void {
        if (!this.tabbyHotkeysDisabledForCapture) { return }
        this.hotkeys?.enable()
        this.tabbyHotkeysDisabledForCapture = false
        if (typeof document !== 'undefined') {
            document.documentElement?.removeAttribute('data-windy-quick-commands-hotkey-recording')
        }
    }

    private markCapturedHotkey (kind: 'plugin' | 'command', targetId: string, shortcut: string): void {
        this.clearCapturedHotkeyFeedback()
        this.recentlyCapturedHotkey = { kind, targetId, shortcut: normalizeShortcut(shortcut) }
        this.capturedHotkeyTimer = setTimeout(() => {
            this.capturedHotkeyTimer = null
            this.recentlyCapturedHotkey = null
            this.changeDetector.markForCheck()
        }, 900)
    }

    private clearCapturedHotkeyFeedback (): void {
        if (this.capturedHotkeyTimer !== null) {
            clearTimeout(this.capturedHotkeyTimer)
        }
        this.capturedHotkeyTimer = null
        this.recentlyCapturedHotkey = null
    }

    async removePluginHotkey (action: PluginHotkeyAction, index: number): Promise<void> {
        if (!this.pluginHotkeyDraft || this.pluginHotkeySaving) { return }
        const bindings = this.getPluginHotkeys(action).filter((_binding, bindingIndex) => bindingIndex !== index)
        this.setPluginHotkeyDraftBindings(action, bindings)
        await this.persistHotkeyDialogChanges()
    }

    async clearPluginHotkey (action: PluginHotkeyAction): Promise<void> {
        if (!this.pluginHotkeyDraft || this.pluginHotkeySaving) { return }
        if (this.recordingHotkeyAction === action) { this.stopHotkeyCapture() }
        this.setPluginHotkeyDraftBindings(action, [])
        await this.persistHotkeyDialogChanges()
    }

    async clearCommandHotkey (commandId: string): Promise<void> {
        if (!this.commandHotkeyDraft || this.pluginHotkeySaving) { return }
        if (this.recordingCommandHotkeyId === commandId) { this.stopHotkeyCapture() }
        this.setCommandHotkeyDraft(commandId, '')
        await this.persistHotkeyDialogChanges()
    }

    showHotkeyCommandTooltip (event: Event): void {
        const target = event.currentTarget
        if (!(target instanceof HTMLElement)) { return }
        const bounds = target.getBoundingClientRect()
        this.hotkeyCommandTooltip = {
            text: this.i18n.text('打开命令'),
            left: bounds.right,
            top: bounds.top - 7,
        }
        this.changeDetector.markForCheck()
    }

    hideHotkeyCommandTooltip (): void {
        if (!this.hotkeyCommandTooltip) { return }
        this.hotkeyCommandTooltip = null
        this.changeDetector.markForCheck()
    }

    async openCommandFromHotkeyDialog (commandId: string): Promise<void> {
        if (this.pluginHotkeySaving) { return }
        this.closePluginHotkeyDialog(false)
        this.quickCommands.openCommand(commandId)
    }

    async resetAllPluginHotkeys (): Promise<void> {
        if (!this.pluginHotkeyDraft || this.pluginHotkeySaving) { return }
        this.pluginHotkeyDraft = buildDefaultPluginHotkeyExport()
        this.invalidateHotkeyConflictCache()
        this.stopHotkeyCapture()
        this.clearCapturedHotkeyFeedback()
        this.pluginHotkeyDialogError = ''
        await this.persistHotkeyDialogChanges()
    }

    setBooleanValue (field: string, value: boolean): void {
        this.root[field] = value
        this.save()
    }

    setToolbarButtonVisibility (event: Event): void {
        this.root.showToolbarButton = (event.target as HTMLInputElement).checked
        if (!this.save()) { (event.target as HTMLInputElement).checked = this.root.showToolbarButton !== false }
    }

    setNumber (field: string, event: Event, min: number, max: number): void {
        const raw = Number((event.target as HTMLInputElement).value)
        this.root[field] = Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : min))
        if (!this.save()) { (event.target as HTMLInputElement).value = String(this.root[field] ?? '') }
    }

    releaseNumberWheel (event: WheelEvent): void {
        (event.currentTarget as HTMLInputElement | null)?.blur()
    }

    clearLogs (): void {
        this.activityLog.clear()
        this.runtimeLogs = []
        this.activityLogSizeBytes = this.activityLog.storage.getSizeBytes()
    }

    updateActivityLogRetention (settings: ActivityLogRetentionSettings): void {
        this.root.logRetentionMode = settings.mode
        this.root.logLimit = settings.count
        this.root.logRetentionDays = settings.days
        this.root.logSizeLimitMb = settings.sizeMb
        this.root.logWarningSizeMb = settings.warningSizeMb
        this.root.logSizeUnit = settings.sizeUnit
        this.root.logWarningSizeUnit = settings.warningSizeUnit
        if (!this.save()) { return }
        this.runtimeLogs = this.activityLog.prune(settings)
        this.activityLogSizeBytes = this.activityLog.storage.getSizeBytes()
    }

    private recordActivity (draft: ActivityLogDraft): void {
        // Some host-side controller checks instantiate the prototype without
        // running Angular dependency construction. Logging is non-critical and
        // should never make the requested settings operation fail.
        if (!this.activityLog) { return }
        this.activityLog.record(draft, this.activityLogRetention)
        this.runtimeLogs = this.activityLog.getEntries()
        this.activityLogSizeBytes = this.activityLog.storage.getSizeBytes()
    }

    formatFullTime (isoTime: string): string {
        const date = new Date(isoTime)
        if (Number.isNaN(date.getTime())) {
            return isoTime
        }
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    formatLastUsed (isoTime: string | null | undefined): string {
        return isoTime ? this.formatFullTime(isoTime) : '从未执行'
    }

    private timeValue (isoTime: string | null | undefined): number {
        const value = isoTime ? new Date(isoTime).getTime() : 0
        return Number.isFinite(value) ? value : 0
    }

    private resetCommandFilterPage (): void {
        this.commandPage = 1
        this.batchDeleteConfirmOpen = false
    }

    private applyImportedConfig (config: Record<string, unknown>, failureMessage?: string): boolean {
        const storedConfig = { ...config }
        delete storedConfig.pluginHotkeys
        this.pluginConfig = storedConfig
        if (!this.save(failureMessage)) { return false }
        this.selectedCommandIds = new Set<string>()
        this.commandPage = 1
        this.commandQuery = ''
        this.commandCategory = 'all'
        this.commandUsage = 'all'
        this.closeBatchMove()
        this.batchDeleteConfirmOpen = false
        this.updateCheckInterval = this.pluginUpdate.checkInterval
        return true
    }

    private setPluginHotkeyDraftBindings (
        action: PluginHotkeyAction,
        bindings: PluginHotkeyBinding[],
    ): void {
        if (!this.pluginHotkeyDraft) { return }
        this.pluginHotkeyDraft.actions[action] = bindings.map(binding => Array.isArray(binding) ? [...binding] : binding)
        this.invalidateHotkeyConflictCache()
    }

    private setCommandHotkeyDraft (commandId: string, shortcut: string): void {
        if (!this.commandHotkeyDraft || !this.commandHotkeyCommands.some(command => command.id === commandId)) { return }
        this.commandHotkeyDraft[commandId] = normalizeShortcut(shortcut)
        this.invalidateHotkeyConflictCache()
    }

    private getCommandHotkeyDraftCommands (): QuickCommand[] {
        return this.commandHotkeyCommands.map(command => ({
            ...command,
            shortcut: this.getCommandHotkey(command.id),
        }))
    }

    private getHotkeyConflictCache (): HotkeyConflictCache {
        if (this.hotkeyConflictCache) {
            return this.hotkeyConflictCache
        }

        const commands = this.getCommandHotkeyDraftCommands()
        const hotkeys = this.getPluginHotkeyConflictSource()
        const pluginActions = new Map<PluginHotkeyAction, string>()
        const pluginBindings = new Map<string, string>()
        const pluginByBinding = new Map<string, PluginHotkeyDefinition>()
        pluginHotkeyDefinitions.forEach(definition => {
            this.getPluginHotkeys(definition.action).forEach(binding => {
                const bindingId = pluginHotkeyBindingId(binding)
                if (bindingId && !pluginByBinding.has(bindingId)) {
                    pluginByBinding.set(bindingId, definition)
                }
                const conflict = findPluginHotkeyConflict(
                    hotkeys,
                    commands,
                    definition.action,
                    binding,
                )
                if (!conflict) { return }
                pluginBindings.set(this.pluginBindingConflictKey(definition.action, binding), conflict)
                if (!pluginActions.has(definition.action)) {
                    pluginActions.set(definition.action, conflict)
                }
            })
        })

        const commandsByShortcut = new Map<string, QuickCommand[]>()
        commands.forEach(command => {
            const shortcut = normalizeShortcut(command.shortcut || '')
            if (!shortcut) { return }
            const matches = commandsByShortcut.get(shortcut) || []
            matches.push(command)
            commandsByShortcut.set(shortcut, matches)
        })

        const pluginIds = new Set(pluginHotkeyDefinitions.map(definition => definition.id))
        const drawerByShortcut = new Map(reservedQuickCommandsShortcuts.map(item => (
            [normalizeShortcut(item.shortcut), item.name]
        )))
        const tabbyByShortcut = new Map<string, string>()
        const configuredTabbyHotkeys = [
            ...reservedTabbyShortcuts,
            ...flattenHotkeysConfig(hotkeys)
                .filter(item => !pluginIds.has(item.name))
                .map(item => ({ shortcut: item.shortcut, name: item.name })),
        ]
        configuredTabbyHotkeys.forEach(item => {
            const shortcut = normalizeShortcut(item.shortcut)
            if (shortcut && !tabbyByShortcut.has(shortcut)) {
                tabbyByShortcut.set(shortcut, item.name)
            }
        })

        const commandConflicts = new Map<string, string>()
        commands.forEach(command => {
            const shortcut = normalizeShortcut(command.shortcut || '')
            if (!shortcut) { return }
            const pluginConflict = pluginByBinding.get(pluginHotkeyBindingId(shortcut))
            if (pluginConflict) {
                commandConflicts.set(command.id, `与插件操作“${pluginConflict.title}”冲突`)
                return
            }
            const drawerConflict = drawerByShortcut.get(shortcut)
            if (drawerConflict) {
                commandConflicts.set(command.id, `与抽屉操作“${drawerConflict}”冲突`)
                return
            }
            const commandConflict = commandsByShortcut.get(shortcut)?.find(item => item.id !== command.id)
            if (commandConflict) {
                commandConflicts.set(command.id, `快捷键已被“${commandConflict.name}”使用。`)
                return
            }
            const tabbyConflict = tabbyByShortcut.get(shortcut)
            if (tabbyConflict) {
                commandConflicts.set(command.id, `与 Tabby 操作“${tabbyConflict}”冲突`)
            }
        })

        this.hotkeyConflictCache = {
            pluginActions,
            pluginBindings,
            commands: commandConflicts,
        }
        return this.hotkeyConflictCache
    }

    private pluginBindingConflictKey (action: PluginHotkeyAction, binding: PluginHotkeyBinding): string {
        return `${action}\u0000${pluginHotkeyBindingId(binding)}`
    }

    private invalidateHotkeyConflictCache (): void {
        this.hotkeyConflictCache = null
    }

    private reloadPluginHotkeyDraft (): void {
        this.pluginHotkeyDraft = this.clonePluginHotkeyExport(buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys))
        this.invalidateHotkeyConflictCache()
    }

    private reloadCommandHotkeyDraft (): void {
        this.commandHotkeyDraft = Object.fromEntries(this.commandHotkeyCommands.map(command => (
            [command.id, normalizeShortcut(command.shortcut || '')]
        )))
        this.invalidateHotkeyConflictCache()
    }

    private async commitHotkeyDialogChanges (): Promise<boolean> {
        if (!this.pluginHotkeyDraft || !this.commandHotkeyDraft) { return false }
        const pluginChanged = this.pluginHotkeyDraftDirty
        const commandsChanged = this.commandHotkeyDraftDirty
        const previousPluginHotkeys = buildPluginHotkeyExport(this.tabbyConfig.store?.hotkeys)
        if (pluginChanged) {
            const pluginSaved = await this.persistPluginHotkeyExport(this.clonePluginHotkeyExport(this.pluginHotkeyDraft))
            if (!pluginSaved) { return false }
        }
        if (commandsChanged) {
            this.root.commands = this.getCommandHotkeyDraftCommands()
            if (!this.save('快捷键保存失败')) {
                if (pluginChanged) {
                    await this.persistPluginHotkeyExport(previousPluginHotkeys, '快捷键回滚失败')
                }
                return false
            }
        }
        return true
    }

    private async persistHotkeyDialogChanges (): Promise<boolean> {
        if (!this.pluginHotkeyDraft || !this.commandHotkeyDraft || this.pluginHotkeySaving) { return false }
        if (!this.hotkeyDialogDirty) { return true }
        this.pluginHotkeyDialogError = ''
        this.pluginHotkeySaving = true
        const success = await this.commitHotkeyDialogChanges()
        this.pluginHotkeySaving = false
        this.reloadPluginHotkeyDraft()
        this.reloadCommandHotkeyDraft()
        if (!success) {
            this.pluginHotkeyDialogError = this.i18n.text('快捷键保存失败')
        }
        this.changeDetector.markForCheck()
        return success
    }

    private getPluginHotkeyConflictSource (): Record<string, unknown> {
        const source = this.cloneHotkeyConfig(this.tabbyConfig.store?.hotkeys || {})
        if (this.pluginHotkeyDraft) {
            applyPluginHotkeyExport(source, this.pluginHotkeyDraft)
        }
        return source
    }

    private cloneHotkeyConfig (value: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (Array.isArray(item)) {
                return [key, item.map(binding => Array.isArray(binding) ? [...binding] : binding)]
            }
            if (item && typeof item === 'object') {
                return [key, this.cloneHotkeyConfig(item as Record<string, unknown>)]
            }
            return [key, item]
        }))
    }

    private clonePluginHotkeyExport (value: PluginHotkeyExport): PluginHotkeyExport {
        return {
            version: 1,
            actions: {
                toggleDrawer: value.actions.toggleDrawer.map(binding => Array.isArray(binding) ? [...binding] : binding),
                openSettings: value.actions.openSettings.map(binding => Array.isArray(binding) ? [...binding] : binding),
                switchFocus: value.actions.switchFocus.map(binding => Array.isArray(binding) ? [...binding] : binding),
                toggleHints: value.actions.toggleHints.map(binding => Array.isArray(binding) ? [...binding] : binding),
            },
        }
    }

    private pluginHotkeyExportId (value: PluginHotkeyExport): string {
        return pluginHotkeyDefinitions.map(definition => (
            value.actions[definition.action].map(pluginHotkeyBindingId)
        )).map(bindings => bindings.join('|')).join('::')
    }

    private async persistPluginHotkeyExport (
        value: PluginHotkeyExport,
        failureMessage = '快捷键保存失败',
    ): Promise<boolean> {
        if (!this.tabbyConfig.store.hotkeys || typeof this.tabbyConfig.store.hotkeys !== 'object') {
            this.tabbyConfig.store.hotkeys = {}
        }
        const previous = buildPluginHotkeyExport(this.tabbyConfig.store.hotkeys)
        applyPluginHotkeyExport(this.tabbyConfig.store.hotkeys, value)
        this.invalidateHotkeyConflictCache()
        try {
            await this.tabbyConfig.save()
            this.changeDetector.markForCheck()
            return true
        } catch (error) {
            applyPluginHotkeyExport(this.tabbyConfig.store.hotkeys, previous)
            this.invalidateHotkeyConflictCache()
            const detail = this.i18n.text(error instanceof Error ? error.message : String(error))
            this.showConfigMessage(failureMessage, detail)
            this.changeDetector.markForCheck()
            return false
        }
    }

    private createImportIdFactory (): () => string {
        const prefix = Date.now().toString(36)
        let counter = 0
        return () => `import-${prefix}-${(++counter).toString(36)}`
    }

    private stripCommandRuntime (command: QuickCommand): Omit<QuickCommand, 'usageCount' | 'lastUsedAt'> {
        const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
        return stored
    }

    private save (failureMessage?: string): boolean {
        this.invalidateHotkeyConflictCache()
        try {
            this.pluginConfigStore.set(this.root)
            this.savedConfigSnapshot = JSON.stringify(this.root)
            return true
        } catch (error) {
            this.pluginConfig = JSON.parse(this.savedConfigSnapshot)
            // Prefer the actual saved state, including another window's edits.
            // If a reset invalidated this store, retain the last known snapshot
            // and show the original restart/error instruction instead.
            try { this.refreshPluginConfig() } catch { /* Keep the saved snapshot. */ }
            const detail = this.i18n.text('保存失败，本次更改未保存。详情：') +
                this.i18n.text(error instanceof Error ? error.message : String(error))
            this.showConfigMessage(failureMessage || detail, failureMessage ? detail : '')
            return false
        }
    }

    dismissConfigMessage (): void {
        if (this.configMessageTimer !== null) {
            clearTimeout(this.configMessageTimer)
        }
        this.configMessageTimer = null
        this.configMessage = ''
        this.configMessageDetail = ''
    }

    private showConfigMessage (message: string, detail = ''): void {
        this.dismissConfigMessage()
        if (!message) { return }
        this.configMessage = message
        this.configMessageDetail = detail
        this.configMessageTimer = setTimeout(() => {
            this.dismissConfigMessage()
            this.changeDetector.detectChanges()
        }, 60_000)
    }

    private downloadJson (text: string, fileName: string): void {
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
    }
}
