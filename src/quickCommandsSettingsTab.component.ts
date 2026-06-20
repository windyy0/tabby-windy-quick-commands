import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { CommandUsageStats, QuickCommandsRuntimeStore } from './runtimeStorage'
import { defaultQuickCommandsConfig } from './configProvider'
import { QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { QuickCommandsI18n } from './i18n'

@Component({
    selector: 'quick-commands-settings-tab',
    template: `
      <div class="wqc-settings">
        <header class="wqc-header">
          <div>
            <h3>快速命令</h3>
            <div class="wqc-muted">{{ commandCount }} 条命令，{{ logCount }} 条运行日志</div>
          </div>
          <label class="wqc-header-toggle" title="修改后重启 Tabby 生效；隐藏按钮后仍可使用快捷键">
            <input class="wqc-command-check" type="checkbox" [checked]="root.showToolbarButton !== false" (change)="setToolbarButtonVisibility($event)">
            <span>显示右上角按钮</span>
            <small>重启后生效</small>
          </label>
        </header>

        <div class="wqc-plugin-intro">
          <strong>Tabby Windy Quick Commands</strong>
          <p>在 Tabby 中集中管理和执行常用终端命令，支持分类搜索、快捷键、多会话发送、逐行执行、输出触发器以及命令库导入导出。</p>
          <span>插件配置、命令库、运行日志和使用统计均采用独立文件存储；Tabby 总配置中只保留全局快捷键。</span>
        </div>

        <section class="wqc-section wqc-config-section">
          <div class="wqc-section-head">
            <div>
              <h4>插件配置</h4>
              <div class="wqc-muted">导出或恢复命令、分类、触发器和所有插件设置；运行日志与使用统计不包含在内。</div>
            </div>
            <div class="wqc-config-actions">
              <button class="btn btn-secondary" type="button" (click)="exportPluginConfig()">导出配置</button>
              <button class="btn btn-secondary" type="button" (click)="pluginConfigFile.click()">导入配置</button>
              <input #pluginConfigFile class="wqc-hidden-file" type="file" accept="application/json,.json" (change)="importPluginConfig($event)">
            </div>
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
                  <span>{{ commandCategoryLabel }}</span>
                </button>
                <div class="wqc-select-menu" role="listbox" *ngIf="commandCategoryMenuOpen">
                  <button type="button" role="option" [attr.aria-selected]="commandCategory === 'all'" [class.wqc-selected]="commandCategory === 'all'" (click)="setCommandCategory('all')">全部分类</button>
                  <button type="button" role="option" *ngFor="let category of commandCategories" [attr.aria-selected]="commandCategory === category" [class.wqc-selected]="commandCategory === category" (click)="setCommandCategory(category)">{{ category }}</button>
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
            <button class="btn wqc-danger-button" type="button" [disabled]="!selectedCommandCount" (click)="openBatchDeleteConfirm()">批量删除</button>
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
                <strong>{{ command.name }}</strong>
                <span class="wqc-pill">{{ command.category }}</span>
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

      .wqc-plugin-intro strong {
        display: block;
        margin-bottom: 6px;
        color: var(--wqc-accent);
        font-size: 14px;
      }

      .wqc-plugin-intro p {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
      }

      .wqc-plugin-intro span {
        display: block;
        margin-top: 7px;
        color: var(--wqc-muted);
        font-size: 12px;
        line-height: 1.5;
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
        flex-wrap: wrap;
      }

      .wqc-hidden-file {
        display: none;
      }

      .wqc-config-message {
        margin-top: -4px;
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

      .wqc-select-shell {
        position: relative;
        display: block;
      }

      .wqc-select-shell::after {
        position: absolute;
        top: 50%;
        right: 13px;
        width: 7px;
        height: 7px;
        border-right: 1.5px solid var(--bs-secondary-color);
        border-bottom: 1.5px solid var(--bs-secondary-color);
        content: '';
        pointer-events: none;
        transform: translateY(-70%) rotate(45deg);
        transition: transform 120ms ease;
        z-index: 2;
      }

      .wqc-select-shell.wqc-open::after {
        transform: translateY(-25%) rotate(225deg);
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
        transform: translateY(-1px);
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
    readonly defaultExportFileName = 'tabby-windy-quick-commands-{date}.json'
    failureMenuOpen = false
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
    selectedCommandIds = new Set<string>()
    runtimeLogs: any[] = []
    runtimeStats: CommandUsageStats = {}
    configMessage = ''
    private configMessageTimer: ReturnType<typeof setTimeout> | null = null
    private runtimeStore: QuickCommandsRuntimeStore
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private pluginConfig: Record<string, any>
    private stopLocalizing: (() => void) | null = null
    private localeSubscription: { unsubscribe: () => void } | null = null

    constructor (
        private platform: PlatformService,
        private changeDetector: ChangeDetectorRef,
        private element: ElementRef<HTMLElement>,
        private i18n: QuickCommandsI18n,
        private zone: NgZone,
    ) {
        this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(this.platform.getConfigPath())
        this.pluginConfig = this.pluginConfigStore.load(defaultQuickCommandsConfig)
        this.refreshRuntimeData()
    }

    ngAfterViewInit (): void {
        this.startLocalizing()
        this.localeSubscription = this.i18n.localeChanged$.subscribe(() => {
            this.startLocalizing()
        })
    }

    ngOnDestroy (): void {
        if (this.configMessageTimer) {
            clearTimeout(this.configMessageTimer)
        }
        this.stopLocalizing?.()
        this.localeSubscription?.unsubscribe()
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
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
    }

    @HostListener('document:keydown.escape')
    closeFailureMenuOnEscape (): void {
        this.failureMenuOpen = false
        this.commandCategoryMenuOpen = false
        this.commandUsageMenuOpen = false
        this.batchDeleteConfirmOpen = false
    }

    @HostListener('window:windy-quick-commands-runtime-changed')
    refreshRuntimeData (): void {
        this.runtimeStore = new QuickCommandsRuntimeStore(this.platform.getConfigPath())
        this.runtimeLogs = this.runtimeStore.getLogs()
        this.runtimeStats = this.runtimeStore.getStats()
    }

    @HostListener('window:windy-quick-commands-config-changed')
    refreshPluginConfig (): void {
        this.pluginConfig = this.pluginConfigStore.load(defaultQuickCommandsConfig, true)
    }

    toggleFailureMenu (): void {
        this.failureMenuOpen = !this.failureMenuOpen
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
        this.commandUsageMenuOpen = false
        this.failureMenuOpen = false
    }

    toggleCommandUsageMenu (): void {
        this.commandUsageMenuOpen = !this.commandUsageMenuOpen
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
    }

    openBatchDeleteConfirm (): void {
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

        const stats = this.runtimeStore.getStats()
        selectedIds.forEach(commandId => delete stats[commandId])
        this.runtimeStore.setStats(stats)
        this.runtimeStats = stats
        this.commandPage = Math.min(this.commandPage, Math.max(1, Math.ceil(remaining.length / 6)))
        this.clearCommandSelection()
        this.save()
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

    exportPluginConfig (): void {
        const payload = this.pluginConfigStore.exportPayload(this.root)
        const text = JSON.stringify(payload, null, 2)
        const date = new Date().toISOString().slice(0, 10)
        try {
            this.downloadJson(text, `tabby-windy-quick-commands-config-${date}.json`)
            this.showConfigMessage('已触发插件配置文件下载，请检查下载目录。')
        } catch {
            this.showConfigMessage('无法触发配置文件下载，请重试。')
        }
    }

    async importPluginConfig (event: Event): Promise<void> {
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
            const imported = this.pluginConfigStore.parseImport(await file.text())
            this.pluginConfig = imported
            this.pluginConfigStore.set(imported)
            this.selectedCommandIds = new Set<string>()
            this.commandPage = 1
            this.showConfigMessage('插件配置已导入。按钮显示设置将在重启 Tabby 后生效。')
        } catch (error) {
            this.showConfigMessage(`导入失败：${error instanceof Error ? error.message : '配置文件无效。'}`)
        }
    }

    setBoolean (field: string, event: Event): void {
        this.root[field] = (event.target as HTMLInputElement).checked
        this.save()
    }

    setToolbarButtonVisibility (event: Event): void {
        this.root.showToolbarButton = (event.target as HTMLInputElement).checked
        this.save()
    }

    setString (field: string, event: Event): void {
        this.root[field] = (event.target as HTMLInputElement).value
        this.save()
    }

    setNumber (field: string, event: Event, min: number, max: number): void {
        const raw = Number((event.target as HTMLInputElement).value)
        this.root[field] = Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : min))
        this.save()
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

    private save (): void {
        this.pluginConfigStore.set(this.root)
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
