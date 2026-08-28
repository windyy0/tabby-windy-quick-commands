import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { PlatformService } from 'tabby-core'
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

const historyDateFormatters = {
    'zh-CN': new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    en: new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
}

@Component({
    selector: 'quick-commands-settings-tab',
    template: `
      <div class="wqc-settings">
        <header class="wqc-header">
          <div>
            <h3>{{ pluginTitle }}</h3>
            <div class="wqc-muted">{{ commandCount }} 条命令，{{ logCount }} 条运行日志</div>
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
              <div class="wqc-muted">导出或恢复命令、分类、触发器和所有插件设置；运行日志与使用统计不包含在内。</div>
            </div>
          </div>
          <div class="wqc-config-actions">
            <button class="btn btn-secondary" type="button" (click)="exportPluginConfig()">导出</button>
            <button class="btn btn-secondary" type="button" (click)="pluginConfigFile.click()">导入</button>
            <button class="btn wqc-danger-button wqc-reset-config" type="button" (click)="openResetDefaultsConfirm()">恢复默认配置</button>
            <input #pluginConfigFile class="wqc-hidden-file" type="file" accept="application/json,.json" (change)="importPluginConfig($event)">
          </div>
          <div class="wqc-config-message" *ngIf="configMessage">{{ configMessage }}</div>
        </section>

        <section class="wqc-section">
          <h4>执行</h4>
          <div class="wqc-grid">
            <label class="wqc-check">
              <input class="wqc-command-check" type="checkbox" [checked]="root.requireConfirmBeforeExecute" (change)="setBoolean('requireConfirmBeforeExecute', $event)">
              <span>每次执行前确认</span>
            </label>
            <label class="wqc-check">
              <input class="wqc-command-check" type="checkbox" [checked]="root.confirmBroadcast !== false" (change)="setBoolean('confirmBroadcast', $event)">
              <span>发送到所有会话时必须确认</span>
            </label>
          </div>
          <div class="wqc-grid">
            <div class="wqc-field">
              <span>逐行发送失败后</span>
              <div class="wqc-select-shell" [class.wqc-open]="failureMenuOpen" (click)="$event.stopPropagation()">
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
            <label>
              <span>导出文件名</span>
              <input class="form-control" [value]="root.exportFileName || defaultExportFileName" (change)="setString('exportFileName', $event)">
            </label>
            <label>
              <span>面板宽度</span>
              <input class="form-control" type="number" min="420" max="760" step="20" [value]="root.drawerWidth || 560" (change)="setNumber('drawerWidth', $event, 420, 760)">
            </label>
            <label>
              <span class="wqc-field-label">
                输出匹配缓冲区
                <span class="wqc-help" tabindex="0" aria-label="查看输出匹配缓冲区说明">
                  <span class="wqc-help-icon" aria-hidden="true">?</span>
                  <span class="wqc-help-tooltip" role="tooltip">
                    用于输出触发器。插件会保留终端最近输出的这些字符，并在其中查找成功或错误关键词。这里按字符数计算，不是行数。数值太小可能让较早的输出被覆盖，导致匹配不到；数值越大则会多占用少量内存。一般保持默认 8000，只有大量连续输出把目标文字冲掉时才需要调大。
                  </span>
                </span>
              </span>
              <input class="form-control" type="number" min="1000" step="1000" [value]="root.recentOutputLimit || 8000" (change)="setNumber('recentOutputLimit', $event, 1000, 50000)">
            </label>
          </div>
        </section>

        <section class="wqc-section">
          <div class="wqc-section-head">
            <div>
              <h4>命令管理与统计</h4>
              <div class="wqc-muted">按关键词、分类和使用状态筛选，并按最近使用时间排序，每页 6 条。</div>
            </div>
            <span class="wqc-count">{{ commandStats.length }} / {{ commandCount }} 条命令</span>
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
            <span>确认永久删除选中的 {{ selectedCommandCount }} 条命令？运行日志将保留。</span>
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

        <section class="wqc-section">
          <div class="wqc-section-head">
            <div>
              <h4>运行日志</h4>
              <div class="wqc-muted">默认保留 200 条，最多 2000 条；每页 {{ logPageSize }} 条，最新日志在前。</div>
            </div>
            <span class="wqc-count">{{ filteredLogCount }} / {{ logCount }} 条</span>
          </div>
          <div class="wqc-grid">
            <label>
              <span>日志保留条数</span>
              <input class="form-control" type="number" min="20" max="2000" step="20" [value]="root.logLimit || 200" (change)="setNumber('logLimit', $event, 20, 2000)">
            </label>
            <div class="wqc-actions">
              <button class="btn btn-secondary" type="button" (click)="clearLogs()">清空运行日志</button>
              <button class="btn btn-secondary" type="button" (click)="openLogLocation()">打开日志位置</button>
            </div>
          </div>
          <div class="wqc-log-toolbar">
            <input class="form-control" placeholder="搜索消息、命令或目标会话" [value]="logQuery" (input)="setLogQuery($event)">
            <div class="wqc-log-filters" aria-label="日志级别">
              <button type="button" [class.wqc-active]="logLevel === 'all'" (click)="setLogLevel('all')">全部</button>
              <button type="button" [class.wqc-active]="logLevel === 'info'" (click)="setLogLevel('info')">信息</button>
              <button type="button" [class.wqc-active]="logLevel === 'warn'" (click)="setLogLevel('warn')">警告</button>
              <button type="button" [class.wqc-active]="logLevel === 'error'" (click)="setLogLevel('error')">错误</button>
            </div>
          </div>
          <div class="wqc-log-list">
            <article class="wqc-log" *ngFor="let log of visibleLogs" [class.wqc-log-warn]="log.level === 'warn'" [class.wqc-log-error]="log.level === 'error'">
              <header class="wqc-log-head">
                <span class="wqc-log-level">{{ levelLabel(log.level) }}</span>
                <strong class="wqc-log-command">{{ commandName(log) }}</strong>
                <time class="wqc-log-time">{{ formatFullTime(log.time) }}</time>
              </header>
              <div class="wqc-log-message">{{ log.message }}</div>
              <pre class="wqc-log-content" *ngIf="logContent(log)">{{ logContent(log) }}</pre>
              <div class="wqc-log-meta" *ngIf="log.line || log.mode || log.durationMs !== undefined || (log.targetNames && log.targetNames.length)">
                <span *ngIf="log.line">源行 {{ log.line }}</span>
                <span *ngIf="log.mode">{{ log.mode }}</span>
                <span *ngIf="log.durationMs !== undefined">耗时 {{ formatDuration(log.durationMs) }}</span>
                <span *ngIf="log.targetNames && log.targetNames.length" [title]="log.targetNames.join('、')">目标：{{ targetSummary(log.targetNames) }}</span>
              </div>
            </article>
            <div class="wqc-empty" *ngIf="!visibleLogs.length">没有匹配的运行日志</div>
          </div>
          <div class="wqc-pager" *ngIf="logPageCount > 1">
            <button class="btn btn-secondary" type="button" [disabled]="logPageNumber <= 1" (click)="previousLogPage()">上一页</button>
            <span>第 {{ logPageNumber }} / {{ logPageCount }} 页</span>
            <button class="btn btn-secondary" type="button" [disabled]="logPageNumber >= logPageCount" (click)="nextLogPage()">下一页</button>
          </div>
        </section>

        <section class="wqc-section wqc-update-section" id="wqc-plugin-update">
          <div class="wqc-section-head">
            <div>
              <div class="wqc-update-title-line">
                <h4>版本更新</h4>
                <span class="wqc-update-current-version">当前版本 v{{ updateState.currentVersion }}</span>
              </div>
              <div class="wqc-muted">管理自动检查、查看历史更新和安装新版本。</div>
            </div>
            <button class="btn btn-secondary" type="button" (click)="openUpdateHistory()">更新历史</button>
          </div>

          <div class="wqc-update-preferences">
            <div class="wqc-update-interval">
              <span class="wqc-update-interval-label">自动检查</span>
              <div class="wqc-select-shell wqc-update-interval-shell" [class.wqc-open]="updateIntervalMenuOpen" (click)="$event.stopPropagation()">
                <button class="wqc-select wqc-update-interval-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="updateIntervalMenuOpen" (click)="toggleUpdateIntervalMenu()">
                  <span>{{ updateCheckIntervalLabel }}</span>
                </button>
                <div class="wqc-select-menu wqc-update-interval-menu" role="listbox" *ngIf="updateIntervalMenuOpen">
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'daily'" [class.wqc-selected]="updateCheckInterval === 'daily'" (click)="selectUpdateCheckInterval('daily')">每天</button>
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'weekly'" [class.wqc-selected]="updateCheckInterval === 'weekly'" (click)="selectUpdateCheckInterval('weekly')">每周</button>
                  <button type="button" role="option" [attr.aria-selected]="updateCheckInterval === 'never'" [class.wqc-selected]="updateCheckInterval === 'never'" (click)="selectUpdateCheckInterval('never')">从不</button>
                </div>
              </div>
            </div>
            <button class="btn btn-secondary wqc-back-to-top" type="button" (click)="scrollToSettingsTop()">返回顶部 <span aria-hidden="true">↑</span></button>
          </div>

          <p class="wqc-muted" *ngIf="!canInstallUpdate">
            <span>Dev 读取正式版的版本信息和更新历史，不会安装正式包。</span><br>
            <span>更新本地代码后，请在源码目录运行：</span> <code data-i18n-skip>npm run install:tabby:dev</code> <span>然后重启 Tabby。</span>
          </p>
          <div class="wqc-update-panel" *ngIf="updateState.available">
            <button class="wqc-update-summary" type="button" [attr.aria-expanded]="updateDetailsExpanded" (click)="toggleUpdateDetails()">
              <span class="wqc-update-summary-title">
                <span class="wqc-update-dot" aria-hidden="true"></span>
                发现新版本 v{{ updateState.latestVersion }}
                <small *ngIf="updateState.ignored">已停止提醒</small>
              </span>
              <span class="wqc-update-expand">{{ updateDetailsExpanded ? '收起' : '展开' }}</span>
            </button>
            <div class="wqc-update-details" *ngIf="updateDetailsExpanded">
              <pre class="wqc-update-notes" data-i18n-skip *ngIf="updateState.releaseNotes">{{ updateState.releaseNotes }}</pre>
              <div class="wqc-update-empty" *ngIf="!updateState.releaseNotes">本次更新未提供更新说明。</div>
              <div class="wqc-update-actions">
                <button class="btn btn-primary" type="button" [disabled]="!canInstallUpdate || updateState.status === 'installing' || updateState.status === 'restart'" (click)="installUpdate()">
                  {{ updateState.status === 'installing' ? '正在更新…' : updateState.status === 'restart' ? '等待重启' : '立即更新' }}
                </button>
                <button class="btn btn-secondary" type="button" [disabled]="updateState.ignored" (click)="ignoreCurrentUpdate()">{{ updateState.ignored ? '已停止提醒' : '本版本不再提醒' }}</button>
              </div>
            </div>
          </div>
        </section>

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
              <p>确定恢复所有插件设置的默认值？现有命令、分类和输出触发器将保留，运行日志和使用统计也不会清除。</p>
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
                  <li>插件设置、配置备份、运行日志和使用统计</li>
                  <li>插件本地缓存</li>
                </ul>
              </div>
              <p>请先导出需要保留的命令和配置；导出文件不包含运行日志和使用统计。</p>
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
              <div class="wqc-update-history-message wqc-update-history-error" *ngIf="updateHistoryState.status === 'error'">
                加载失败：{{ updateHistoryState.error || '请稍后重试' }}
              </div>
              <div class="wqc-update-history-message" *ngIf="updateHistoryState.status === 'ready' && !updateHistoryState.entries.length">
                npm 暂无已发布版本记录。
              </div>

              <div class="wqc-update-history-list" *ngIf="updateHistoryState.status === 'ready' && updateHistoryState.entries.length">
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
              <button class="btn btn-secondary" type="button" [disabled]="updateHistoryState.status === 'loading'" (click)="reloadUpdateHistory()">重新加载</button>
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
      .wqc-update-preferences {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wqc-update-card-check {
        justify-content: flex-end;
        min-width: 0;
      }

      .wqc-update-preferences {
        width: 100%;
        min-height: 36px;
        flex-wrap: wrap;
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

      .wqc-update-section > .wqc-section-head > .btn,
      .wqc-back-to-top {
        min-height: 32px;
        font-size: 11px;
      }

      .wqc-back-to-top {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        white-space: nowrap;
      }

      .wqc-back-to-top span {
        display: inline-flex;
        align-items: center;
        line-height: 1;
        transform: translateY(-1px);
      }

      .wqc-update-panel {
        margin-top: 11px;
        overflow: hidden;
        background: color-mix(in srgb, var(--bs-primary) 5%, var(--bs-body-bg));
        border: 1px solid color-mix(in srgb, var(--bs-primary) 24%, var(--wqc-surface-border));
        border-radius: 8px;
      }

      .wqc-update-summary,
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
        justify-content: space-between;
        gap: 12px;
        min-height: 38px;
        padding: 8px 11px;
        font-size: 12px;
      }

      .wqc-update-summary:hover,
      .wqc-update-summary:focus-visible,
      .wqc-update-history-summary:hover,
      .wqc-update-history-summary:focus-visible {
        background: color-mix(in srgb, var(--bs-primary) 7%, transparent);
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
        color: var(--wqc-accent);
        font-size: 11px;
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
        padding-top: 0;
        border-top: 0;
      }

      .wqc-config-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }

      .wqc-config-actions .btn {
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
        margin-top: 10px;
        padding: 8px 10px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 8%, transparent);
        border-radius: 7px;
        font-size: 12px;
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

      .wqc-check {
        grid-template-columns: 16px minmax(0, 1fr);
        align-items: center;
        min-height: 36px;
        cursor: pointer;
        transition: color 150ms ease;
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
      .wqc-stat-header,
      .wqc-log-time,
      .wqc-log-meta,
      .wqc-log-meta span {
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

      .wqc-log-toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto;
        gap: 10px;
        align-items: center;
      }

      .wqc-log-filters {
        display: flex;
        gap: 5px;
        padding: 4px;
        border: 1px solid var(--bs-border-color);
        border-radius: 8px;
      }

      .wqc-log-filters button {
        min-height: 28px;
        padding: 0 9px;
        color: var(--bs-secondary-color);
        background: transparent;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
      }

      .wqc-log-filters button:hover,
      .wqc-log-filters button.wqc-active {
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 12%, transparent);
      }

      .wqc-log-list {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }

      .wqc-log {
        display: grid;
        gap: 8px;
        border: 1px solid var(--wqc-surface-border);
        border-left: 3px solid color-mix(in srgb, var(--bs-primary) 55%, var(--wqc-surface-border));
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 12px;
      }

      .wqc-log-warn {
        border-left-color: #d97706;
      }

      .wqc-log-error {
        border-left-color: var(--bs-danger);
      }

      .wqc-log-head {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 9px;
        align-items: center;
      }

      .wqc-log-level {
        min-width: 38px;
        padding: 2px 6px;
        color: var(--bs-primary);
        background: color-mix(in srgb, var(--bs-primary) 12%, transparent);
        border-radius: 5px;
        text-align: center;
        font-size: 10px;
        font-weight: 700;
      }

      .wqc-log-warn .wqc-log-level {
        color: #b45309;
        background: color-mix(in srgb, #d97706 13%, transparent);
      }

      .wqc-log-error .wqc-log-level {
        color: var(--bs-danger);
        background: color-mix(in srgb, var(--bs-danger) 12%, transparent);
      }

      .wqc-log-command {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wqc-log-time {
        color: var(--bs-secondary-color);
        font-variant-numeric: tabular-nums;
      }

      .wqc-log-message {
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .wqc-log-content {
        max-height: 150px;
        margin: 0;
        padding: 9px 10px;
        overflow: auto;
        color: var(--bs-body-color);
        background: color-mix(in srgb, var(--bs-body-color) 6%, var(--bs-body-bg));
        border: 1px solid var(--bs-border-color);
        border-radius: 7px;
        font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .wqc-log-meta {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .wqc-log-meta span {
        max-width: 100%;
        padding: 2px 6px;
        overflow: hidden;
        color: var(--bs-secondary-color);
        background: color-mix(in srgb, var(--bs-body-color) 5%, transparent);
        border-radius: 5px;
        text-overflow: ellipsis;
        white-space: nowrap;
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

        .wqc-log-toolbar {
          grid-template-columns: 1fr;
        }

        .wqc-command-filter-options {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        }

        .wqc-log-filters {
          width: max-content;
          max-width: 100%;
          overflow-x: auto;
        }

        .wqc-log-head {
          grid-template-columns: auto minmax(0, 1fr);
        }

        .wqc-log-time {
          grid-column: 1 / -1;
        }
      }

      @media (max-width: 520px) {
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

        .wqc-update-section .wqc-section-head > .btn {
          align-self: flex-start;
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

        .wqc-update-actions {
          align-items: stretch;
          flex-direction: column;
        }

        .wqc-config-actions {
          align-items: stretch;
          flex-wrap: wrap;
          width: 100%;
        }

        .wqc-config-actions .btn {
          flex: 0 0 auto;
        }

        .wqc-reset-config {
          margin-left: auto;
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
    failureMenuOpen = false
    updateIntervalMenuOpen = false
    commandCategoryMenuOpen = false
    commandUsageMenuOpen = false
    logLevel: 'all' | 'info' | 'warn' | 'error' = 'all'
    logQuery = ''
    commandQuery = ''
    commandCategory = 'all'
    commandUsage: 'all' | 'used' | 'unused' = 'all'
    commandPage = 1
    logPage = 1
    readonly logPageSize = 3
    batchDeleteConfirmOpen = false
    batchMoveOpen = false
    batchMoveCategoryMenuOpen = false
    batchMoveCategory = ''
    pendingConfigImport: PluginConfigImportFile | null = null
    resetDefaultsConfirmOpen = false
    resetInitialConfirmOpen = false
    resetInitialAcknowledged = false
    resetInitialError = ''
    resetInProgress = false
    selectedCommandIds = new Set<string>()
    runtimeLogs: any[] = []
    runtimeStats: CommandUsageStats = {}
    configMessage = ''
    readonly projectUrl = 'https://github.com/windyy0/tabby-windy-quick-commands'
    readonly issuesUrl = 'https://github.com/windyy0/tabby-windy-quick-commands/issues'
    updateState: PluginUpdateState
    updateCheckInterval: UpdateCheckInterval
    updateDetailsExpanded = false
    updateHistoryOpen = false
    updateHistoryState: PluginUpdateHistoryState = { status: 'idle', entries: [], error: '' }
    expandedHistoryVersions = new Set<string>()
    private historyExpansionInitialized = false
    private configMessageTimer: ReturnType<typeof setTimeout> | null = null
    private runtimeStore: QuickCommandsRuntimeStore
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private pluginConfig: Record<string, any>
    private savedConfigSnapshot: string
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
    ) {
        this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
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
        if (this.configMessageTimer) {
            clearTimeout(this.configMessageTimer)
        }

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

    get filteredLogs (): any[] {
        const query = this.logQuery.trim().toLowerCase()
        const logs = [...this.runtimeLogs].reverse()
        return logs.filter(log => {
            if (this.logLevel !== 'all' && log.level !== this.logLevel) {
                return false
            }
            if (!query) {
                return true
            }
            const text = [
                log.message,
                this.commandName(log),
                this.logContent(log),
                log.mode,
                ...(Array.isArray(log.targetNames) ? log.targetNames : []),
            ].filter(Boolean).join(' ').toLowerCase()
            return text.includes(query)
        })
    }

    get visibleLogs (): any[] {
        const start = (this.logPageNumber - 1) * this.logPageSize
        return this.filteredLogs.slice(start, start + this.logPageSize)
    }

    get filteredLogCount (): number {
        return this.filteredLogs.length
    }

    get logPageCount (): number {
        return Math.max(1, Math.ceil(this.filteredLogCount / this.logPageSize))
    }

    get logPageNumber (): number {
        return Math.min(this.logPage, this.logPageCount)
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

    @HostListener('document:keydown.escape')
    closeFailureMenuOnEscape (): void {
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
        this.runtimeLogs = this.runtimeStore.getLogs()
        this.runtimeStats = this.runtimeStore.getStats()
    }

    @HostListener(`window:${pluginConfigChangedEvent}`)
    refreshPluginConfig (): void {
        this.pluginConfig = this.pluginConfigStore.load(createDefaultQuickCommandsConfig(this.i18n.language), true)
        this.savedConfigSnapshot = JSON.stringify(this.pluginConfig)
        this.updateCheckInterval = this.pluginUpdate.checkInterval
    }

    @HostListener(`window:${pluginDataResetEvent}`)
    refreshAfterDataReset (): void {
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
        this.refreshPluginConfig()
        this.refreshRuntimeData()
        this.selectedCommandIds.clear()
        this.commandQuery = ''; this.commandCategory = 'all'; this.commandUsage = 'all'; this.commandPage = 1
        this.logQuery = ''; this.logLevel = 'all'; this.logPage = 1
        this.pendingConfigImport = null
        this.batchDeleteConfirmOpen = false
        this.closeBatchMove()
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

    scrollToUpdateSettings (): void {
        this.scrollTo('#wqc-plugin-update')
    }

    scrollToSettingsTop (): void {
        this.scrollTo('.wqc-settings')
    }

    get canInstallUpdate (): boolean {
        return this.pluginUpdate.canInstallUpdate
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

    setLogLevel (level: 'all' | 'info' | 'warn' | 'error'): void {
        this.logLevel = level
        this.logPage = 1
    }

    setLogQuery (event: Event): void {
        this.logQuery = (event.target as HTMLInputElement).value
        this.logPage = 1
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
        if (!category || !this.selectedCommandCount) {
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
        this.save()
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
        const stats = this.runtimeStore.getStats()
        selectedIds.forEach(commandId => delete stats[commandId])
        this.runtimeStore.setStats(stats)
        this.runtimeStats = stats
        this.commandPage = Math.min(this.commandPage, Math.max(1, Math.ceil(remaining.length / 6)))
        this.clearCommandSelection()
    }

    previousLogPage (): void {
        this.logPage = Math.max(1, this.logPageNumber - 1)
    }

    nextLogPage (): void {
        this.logPage = Math.min(this.logPageCount, this.logPageNumber + 1)
    }

    openLogLocation (): void {
        const path = this.runtimeStore.logsPath
        if (path) {
            this.platform.showItemInFolder(path)
        }
    }

    openExternal (event: Event, url: string): void {
        event.preventDefault()
        this.platform.openExternal(url)
    }

    exportPluginConfig (): void {
        const payload = this.pluginConfigStore.exportPayload(this.root)
        const text = JSON.stringify(payload, null, 2)
        const date = new Date().toISOString().slice(0, 10)
        try {
            this.downloadJson(text, `${pluginIdentity.packageName}-config-${date}.json`)
            this.showConfigMessage('已触发插件配置文件下载，请检查下载目录。')
        } catch {
            this.showConfigMessage('无法触发配置文件下载，请重试。')
        }
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
            this.showConfigMessage(`导入失败：${error instanceof Error ? error.message : '配置文件无效。'}`)
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
        if (!this.applyImportedConfig(next)) { return }
        this.pendingConfigImport = null
        this.showConfigMessage('命令已合并导入。')
    }

    importPendingFullConfig (): void {
        const imported = this.pendingConfigImport?.config
        if (!imported) {
            return
        }
        if (!this.applyImportedConfig(imported)) { return }
        this.pendingConfigImport = null
        this.showConfigMessage('插件配置已导入。按钮显示设置将在重启 Tabby 后生效。')
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

    restoreDefaultSettings (): void {
        if (!this.resetDefaultsConfirmOpen || this.resetInitialConfirmOpen) { return }
        const restored = buildDefaultSettingsConfig(this.root, defaultQuickCommandsConfig)
        if (!this.applyImportedConfig(restored)) { return }
        this.resetDefaultsConfirmOpen = false
        this.showConfigMessage('已恢复默认配置，现有命令、分类和输出触发器已保留。按钮显示设置将在重启 Tabby 后生效。')
    }

    setBoolean (field: string, event: Event): void {
        this.root[field] = (event.target as HTMLInputElement).checked
        if (!this.save()) { (event.target as HTMLInputElement).checked = Boolean(this.root[field]) }
    }

    setToolbarButtonVisibility (event: Event): void {
        this.root.showToolbarButton = (event.target as HTMLInputElement).checked
        if (!this.save()) { (event.target as HTMLInputElement).checked = this.root.showToolbarButton !== false }
    }

    setString (field: string, event: Event): void {
        this.root[field] = (event.target as HTMLInputElement).value
        if (!this.save()) { (event.target as HTMLInputElement).value = String(this.root[field] ?? '') }
    }

    setNumber (field: string, event: Event, min: number, max: number): void {
        const raw = Number((event.target as HTMLInputElement).value)
        this.root[field] = Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : min))
        if (!this.save()) { (event.target as HTMLInputElement).value = String(this.root[field] ?? '') }
    }

    clearLogs (): void {
        this.runtimeStore.setLogs([])
        this.runtimeLogs = []
        this.logPage = 1
    }

    formatTime (isoTime: string): string {
        const date = new Date(isoTime)
        if (Number.isNaN(date.getTime())) {
            return isoTime
        }
        return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
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

    levelLabel (level: string): string {
        if (level === 'error') {
            return '错误'
        }
        if (level === 'warn') {
            return '警告'
        }
        return '信息'
    }

    commandName (log: any): string {
        if (log.commandName) {
            return log.commandName
        }
        const command = Array.isArray(this.root.commands)
            ? this.root.commands.find((item: any) => item.id === log.commandId)
            : null
        return command?.name || log.commandId || '系统'
    }

    targetSummary (targets: string[]): string {
        if (targets.length <= 2) {
            return targets.join('、')
        }
        return `${targets.slice(0, 2).join('、')} 等 ${targets.length} 个会话`
    }

    logContent (log: any): string {
        const command = Array.isArray(this.root.commands)
            ? this.root.commands.find((item: any) => item.id === log.commandId)
            : null
        const content = String(log.commandText || command?.command || '')
        if (!content || !log.line) {
            return content
        }
        return content.split(/\r?\n/)[Number(log.line) - 1] || content
    }

    formatDuration (durationMs: number): string {
        const value = Math.max(0, Number(durationMs) || 0)
        if (value < 1000) {
            return `${Math.round(value)} ms`
        }
        return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`
    }

    private timeValue (isoTime: string | null | undefined): number {
        const value = isoTime ? new Date(isoTime).getTime() : 0
        return Number.isFinite(value) ? value : 0
    }

    private resetCommandFilterPage (): void {
        this.commandPage = 1
        this.batchDeleteConfirmOpen = false
    }

    private applyImportedConfig (config: Record<string, unknown>): boolean {
        this.pluginConfig = config
        if (!this.save()) { return false }
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

    private createImportIdFactory (): () => string {
        const prefix = Date.now().toString(36)
        let counter = 0
        return () => `import-${prefix}-${(++counter).toString(36)}`
    }

    private stripCommandRuntime (command: QuickCommand): Omit<QuickCommand, 'usageCount' | 'lastUsedAt'> {
        const { usageCount: _usageCount, lastUsedAt: _lastUsedAt, ...stored } = command
        return stored
    }

    private save (): boolean {
        try {
            this.pluginConfigStore.set(this.root)
            this.savedConfigSnapshot = JSON.stringify(this.root)
            this.configMessage = ''
            return true
        } catch (error) {
            this.pluginConfig = JSON.parse(this.savedConfigSnapshot)
            // Prefer the actual saved state, including another window's edits.
            // If a reset invalidated this store, retain the last known snapshot
            // and show the original restart/error instruction instead.
            try { this.refreshPluginConfig() } catch { /* Keep the saved snapshot. */ }
            this.showConfigMessage(this.i18n.text('保存失败，本次更改未保存。详情：') +
                this.i18n.text(error instanceof Error ? error.message : String(error)))
            return false
        }
    }

    private showConfigMessage (message: string): void {
        if (this.configMessageTimer) {
            clearTimeout(this.configMessageTimer)
        }
        this.configMessage = message
        this.configMessageTimer = setTimeout(() => {
            this.configMessage = ''
            this.configMessageTimer = null
            this.changeDetector.detectChanges()
        }, 5000)
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
