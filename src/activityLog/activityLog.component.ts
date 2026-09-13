import { Component, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges } from '@angular/core'

import { QuickCommandsI18n } from '../i18n'
import { filterActivityLogs } from './activityLog.query'
import { activityLogSizeValue, defaultActivityLogRetention } from './activityLog.retention'
import {
    ActivityLogCategory,
    ActivityLogEntry,
    ActivityLogLevel,
    ActivityLogRetentionMode,
    ActivityLogRetentionSettings,
    ActivityLogSizeUnit,
} from './activityLog.types'

@Component({
    selector: 'quick-commands-activity-log',
    template: `
      <section class="wqc-activity-section">
        <div class="wqc-activity-head">
          <div>
            <h4>活动日志</h4>
            <div class="wqc-activity-muted">记录命令运行、命令管理、分类以及导入导出操作，最新日志在前。</div>
          </div>
          <span class="wqc-activity-count">{{ entries.length }} 条</span>
        </div>

        <div class="wqc-retention-grid">
          <label>
            <span>保留方式</span>
            <div class="wqc-select-shell" [class.wqc-open]="openMenu === 'retention'" (click)="$event.stopPropagation()">
              <button class="form-control wqc-control wqc-select" type="button" aria-haspopup="listbox" [attr.aria-expanded]="openMenu === 'retention'" (click)="toggleMenu('retention')">{{ retentionModeLabel }}</button>
              <div class="wqc-select-menu" role="listbox" *ngIf="openMenu === 'retention'">
                <button type="button" role="option" [class.wqc-selected]="settings.mode === 'count'" (click)="selectMode('count')">按条数</button>
                <button type="button" role="option" [class.wqc-selected]="settings.mode === 'days'" (click)="selectMode('days')">按天数</button>
                <button type="button" role="option" [class.wqc-selected]="settings.mode === 'size'" (click)="selectMode('size')">按大小</button>
                <button type="button" role="option" [class.wqc-selected]="settings.mode === 'unlimited'" (click)="selectMode('unlimited')">长期保留</button>
              </div>
            </div>
          </label>
          <label *ngIf="settings.mode === 'count'">
            <span>最多保留条数</span>
            <input class="form-control wqc-control wqc-number-input" type="number" min="20" max="20000" step="20" [value]="settings.count" (wheel)="releaseNumberWheel($event)" (change)="changeNumber('count', $event, 20, 20000)">
          </label>
          <label *ngIf="settings.mode === 'days'">
            <span>保留天数</span>
            <input class="form-control wqc-control wqc-number-input" type="number" min="1" max="3650" step="1" [value]="settings.days" (wheel)="releaseNumberWheel($event)" (change)="changeNumber('days', $event, 1, 3650)">
          </label>
          <label *ngIf="settings.mode === 'size'">
            <span>存储上限</span>
            <div class="wqc-size-input" [class.wqc-focused]="openMenu === 'sizeUnit'" (click)="$event.stopPropagation()">
              <input class="wqc-number-input" type="number" [min]="sizeInputMin(settings.sizeUnit)" [max]="sizeInputMax(settings.sizeUnit)" [step]="sizeInputStep(settings.sizeUnit)" [value]="displaySize(settings.sizeMb, settings.sizeUnit)" (wheel)="releaseNumberWheel($event)" (change)="changeSizeNumber('sizeMb', settings.sizeUnit, $event)">
              <div class="wqc-unit-select" [class.wqc-open]="openMenu === 'sizeUnit'">
                <button type="button" aria-label="存储上限单位" aria-haspopup="listbox" [attr.aria-expanded]="openMenu === 'sizeUnit'" (click)="toggleMenu('sizeUnit')">{{ settings.sizeUnit }}</button>
                <div class="wqc-select-menu wqc-unit-menu" role="listbox" *ngIf="openMenu === 'sizeUnit'">
                  <button type="button" role="option" [class.wqc-selected]="settings.sizeUnit === 'MB'" (click)="selectSizeUnit('sizeUnit', 'MB')">MB</button>
                  <button type="button" role="option" [class.wqc-selected]="settings.sizeUnit === 'GB'" (click)="selectSizeUnit('sizeUnit', 'GB')">GB</button>
                </div>
              </div>
            </div>
          </label>
          <label *ngIf="settings.mode === 'unlimited'">
            <span>提醒阈值</span>
            <div class="wqc-size-input" [class.wqc-focused]="openMenu === 'warningUnit'" (click)="$event.stopPropagation()">
              <input class="wqc-number-input" type="number" [min]="sizeInputMin(settings.warningSizeUnit)" [max]="sizeInputMax(settings.warningSizeUnit)" [step]="sizeInputStep(settings.warningSizeUnit)" [value]="displaySize(settings.warningSizeMb, settings.warningSizeUnit)" (wheel)="releaseNumberWheel($event)" (change)="changeSizeNumber('warningSizeMb', settings.warningSizeUnit, $event)">
              <div class="wqc-unit-select" [class.wqc-open]="openMenu === 'warningUnit'">
                <button type="button" aria-label="提醒阈值单位" aria-haspopup="listbox" [attr.aria-expanded]="openMenu === 'warningUnit'" (click)="toggleMenu('warningUnit')">{{ settings.warningSizeUnit }}</button>
                <div class="wqc-select-menu wqc-unit-menu" role="listbox" *ngIf="openMenu === 'warningUnit'">
                  <button type="button" role="option" [class.wqc-selected]="settings.warningSizeUnit === 'MB'" (click)="selectSizeUnit('warningUnit', 'MB')">MB</button>
                  <button type="button" role="option" [class.wqc-selected]="settings.warningSizeUnit === 'GB'" (click)="selectSizeUnit('warningUnit', 'GB')">GB</button>
                </div>
              </div>
            </div>
          </label>
          <div class="wqc-activity-actions">
            <button class="btn btn-secondary" type="button" (click)="clearRequested.emit()">清空活动日志</button>
            <button class="btn btn-secondary" type="button" (click)="openLocationRequested.emit()">打开日志位置</button>
          </div>
        </div>

        <div class="wqc-storage-line">
          <span>{{ retentionHint }}</span>
          <span>当前占用 {{ formatBytes(sizeBytes) }}</span>
        </div>
        <div class="wqc-storage-warning" role="alert" *ngIf="storageWarning">
          活动日志已超过 {{ displaySize(settings.warningSizeMb, settings.warningSizeUnit) }} {{ settings.warningSizeUnit }}，请清理日志或改用自动限制。
        </div>

        <div class="wqc-activity-toolbar" role="search">
          <input class="form-control wqc-control wqc-search-input" type="search" placeholder="搜索消息、对象、命令或目标会话" [value]="textQuery" (input)="setTextQuery($event)">
          <div class="wqc-select-shell" [class.wqc-open]="openMenu === 'category'" (click)="$event.stopPropagation()">
            <button class="form-control wqc-control wqc-select" type="button" aria-label="日志类型" aria-haspopup="listbox" [attr.aria-expanded]="openMenu === 'category'" (click)="toggleMenu('category')">{{ categoryFilterLabel }}</button>
            <div class="wqc-select-menu" role="listbox" *ngIf="openMenu === 'category'">
              <button type="button" role="option" [class.wqc-selected]="category === 'all'" (click)="selectCategory('all')">全部类型</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'execution'" (click)="selectCategory('execution')">命令运行</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'command'" (click)="selectCategory('command')">命令管理</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'category'" (click)="selectCategory('category')">分类管理</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'library'" (click)="selectCategory('library')">导入导出</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'settings'" (click)="selectCategory('settings')">设置</button>
              <button type="button" role="option" [class.wqc-selected]="category === 'system'" (click)="selectCategory('system')">系统</button>
            </div>
          </div>
          <div class="wqc-select-shell" [class.wqc-open]="openMenu === 'level'" (click)="$event.stopPropagation()">
            <button class="form-control wqc-control wqc-select" type="button" aria-label="日志级别" aria-haspopup="listbox" [attr.aria-expanded]="openMenu === 'level'" (click)="toggleMenu('level')">{{ levelFilterLabel }}</button>
            <div class="wqc-select-menu" role="listbox" *ngIf="openMenu === 'level'">
              <button type="button" role="option" [class.wqc-selected]="level === 'all'" (click)="selectLevel('all')">全部结果</button>
              <button type="button" role="option" [class.wqc-selected]="level === 'info'" (click)="selectLevel('info')">信息</button>
              <button type="button" role="option" [class.wqc-selected]="level === 'warn'" (click)="selectLevel('warn')">警告</button>
              <button type="button" role="option" [class.wqc-selected]="level === 'error'" (click)="selectLevel('error')">错误</button>
            </div>
          </div>
        </div>

        <div class="wqc-activity-table-wrap">
          <table class="wqc-activity-table">
            <thead>
              <tr><th class="wqc-sequence-column">序号</th><th>时间</th><th>类型</th><th>结果</th><th>操作</th><th>对象</th><th class="wqc-summary-column">摘要</th><th aria-label="详情"></th><th class="wqc-table-fill" aria-hidden="true"></th></tr>
            </thead>
            <tbody>
              <ng-container *ngFor="let entry of visibleEntries; let rowIndex = index">
                <tr class="wqc-activity-row" [class.wqc-activity-row-warn]="entry.level === 'warn'" [class.wqc-activity-row-error]="entry.level === 'error'">
                  <td data-label="序号" class="wqc-activity-sequence">{{ entryNumber(rowIndex) }}</td>
                  <td data-label="时间" class="wqc-activity-time">{{ formatTime(entry.time) }}</td>
                  <td data-label="类型"><span class="wqc-category-pill">{{ categoryLabel(entry.category) }}</span></td>
                  <td data-label="结果"><span class="wqc-status-pill" [class.wqc-status-warn]="entry.level === 'warn'" [class.wqc-status-error]="entry.level === 'error'">{{ statusLabel(entry) }}</span></td>
                  <td data-label="操作">{{ actionLabel(entry.action) }}</td>
                  <td data-label="对象" class="wqc-activity-subject"><span [title]="subjectLabel(entry)">{{ subjectLabel(entry) }}</span></td>
                  <td data-label="摘要" class="wqc-activity-summary"><span [title]="entry.message">{{ entry.message }}</span></td>
                  <td class="wqc-activity-detail-toggle">
                    <button type="button" [attr.aria-expanded]="isExpanded(entry.id)" [attr.aria-label]="isExpanded(entry.id) ? '收起日志详情' : '展开日志详情'" [disabled]="!detailText(entry)" (click)="toggleExpanded(entry.id)">{{ isExpanded(entry.id) ? '收起' : '详情' }}</button>
                  </td>
                  <td class="wqc-table-fill" aria-hidden="true"></td>
                </tr>
                <tr class="wqc-activity-detail-row" *ngIf="isExpanded(entry.id) && detailText(entry)">
                  <td colspan="9"><div class="wqc-activity-detail-panel"><pre>{{ detailText(entry) }}</pre></div></td>
                </tr>
              </ng-container>
              <tr *ngIf="!visibleEntries.length"><td class="wqc-activity-empty" colspan="9">没有匹配的活动日志</td></tr>
            </tbody>
          </table>
        </div>

        <div class="wqc-activity-pager">
          <span class="wqc-pager-count">当前 {{ filteredCount }} 条数据</span>
          <div class="wqc-pager-controls">
            <button class="btn btn-secondary" type="button" [disabled]="pageNumber <= 1" (click)="previousPage()">上一页</button>
            <span>第 {{ pageNumber }} / {{ pageCount }} 页</span>
            <label class="wqc-page-jump">跳转到 <input class="form-control wqc-control wqc-number-input" type="number" min="1" [max]="pageCount" step="1" [value]="pageNumber" (wheel)="releaseNumberWheel($event)" (change)="jumpToPage($event)" (keyup.enter)="jumpToPage($event)"> 页</label>
            <button class="btn btn-secondary" type="button" [disabled]="pageNumber >= pageCount" (click)="nextPage()">下一页</button>
          </div>
        </div>
      </section>
    `,
    styles: [`
      :host { display: block; border-top: 1px solid var(--wqc-surface-border, var(--bs-border-color)); }
      .wqc-activity-section { padding: 18px 0; }
      .wqc-activity-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .wqc-activity-head h4 { margin: 0 0 5px; }
      .wqc-activity-muted, .wqc-storage-line { color: var(--bs-secondary-color); font-size: 12px; }
      .wqc-activity-count { white-space: nowrap; color: var(--bs-secondary-color); font-size: 12px; }
      .wqc-retention-grid { display: grid; grid-template-columns: minmax(0, .7fr) minmax(0, .7fr) auto; gap: 12px; align-items: end; margin-top: 14px; }
      .wqc-retention-grid label { display: grid; gap: 6px; min-width: 0; margin: 0; font-size: 12px; }
      .wqc-retention-grid .form-control { min-width: 0; }
      .wqc-control, .wqc-size-input { min-height: 36px; border: 1px solid var(--wqc-surface-border, var(--bs-border-color)); border-radius: 8px; color: var(--bs-body-color); background: var(--bs-body-bg); box-shadow: none; transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
      .wqc-control:hover, .wqc-size-input:hover { border-color: color-mix(in srgb, var(--bs-primary) 42%, var(--wqc-surface-border, var(--bs-border-color))); }
      .wqc-control:focus, .wqc-size-input:focus-within, .wqc-size-input.wqc-focused { border-color: var(--bs-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-primary) 16%, transparent); outline: 0; }
      .wqc-number-input::-webkit-inner-spin-button, .wqc-number-input::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
      .wqc-number-input { -moz-appearance: textfield; appearance: textfield; }
      .wqc-select-shell { position: relative; min-width: 0; }
      .wqc-select-shell::after, .wqc-unit-select::after { content: ''; position: absolute; top: 50%; right: 13px; width: 7px; height: 7px; border-right: 1.5px solid var(--bs-secondary-color); border-bottom: 1.5px solid var(--bs-secondary-color); pointer-events: none; transform: translateY(-70%) rotate(45deg); transition: transform .15s ease; }
      .wqc-select-shell.wqc-open::after, .wqc-unit-select.wqc-open::after { transform: translateY(-25%) rotate(225deg); }
      .wqc-select { display: flex; align-items: center; width: 100%; padding-right: 36px; text-align: left; cursor: pointer; }
      .wqc-select-menu { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 30; display: grid; gap: 3px; min-width: max-content; padding: 5px; border: 1px solid var(--wqc-surface-border, var(--bs-border-color)); border-radius: 9px; background: var(--bs-body-bg); box-shadow: 0 10px 28px color-mix(in srgb, #000 18%, transparent); }
      .wqc-select-menu button { min-height: 30px; padding: 5px 9px; border: 0; border-radius: 6px; color: var(--bs-body-color); background: transparent; text-align: left; white-space: nowrap; font-size: 12px; cursor: pointer; }
      .wqc-select-menu button:hover { background: color-mix(in srgb, var(--bs-primary) 9%, transparent); }
      .wqc-select-menu button.wqc-selected { color: var(--bs-primary); background: color-mix(in srgb, var(--bs-primary) 14%, transparent); font-weight: 650; }
      .wqc-size-input { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 68px; }
      .wqc-size-input > input { width: 100%; min-width: 0; height: 34px; padding: 6px 10px; border: 0; border-radius: 8px 0 0 8px; color: var(--bs-body-color); background: transparent; outline: 0; }
      .wqc-unit-select { position: relative; border-left: 1px solid var(--wqc-surface-border, var(--bs-border-color)); }
      .wqc-unit-select > button { width: 100%; height: 34px; padding: 0 27px 0 10px; border: 0; color: var(--bs-body-color); background: transparent; text-align: left; font-size: 12px; cursor: pointer; }
      .wqc-unit-select::after { right: 12px; }
      .wqc-unit-menu { right: 0; left: auto; min-width: 68px; }
      .wqc-activity-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; justify-content: flex-end; justify-self: end; }
      .wqc-activity-actions .btn { max-width: 100%; white-space: nowrap; }
      .wqc-activity-section .btn-secondary { color: var(--wqc-text, var(--bs-body-color)); background: color-mix(in srgb, var(--bs-body-bg) 92%, var(--wqc-text, var(--bs-body-color)) 8%); border-color: var(--wqc-control-border, var(--wqc-surface-border, var(--bs-border-color))); }
      .wqc-activity-section .btn-secondary:hover, .wqc-activity-section .btn-secondary:focus-visible { color: var(--wqc-accent, var(--bs-primary)); background: color-mix(in srgb, var(--bs-body-bg) 86%, var(--wqc-accent, var(--bs-primary)) 14%); border-color: var(--wqc-accent, var(--bs-primary)); }
      .wqc-storage-line { display: flex; justify-content: space-between; gap: 12px; margin-top: 9px; }
      .wqc-storage-warning { margin-top: 10px; padding: 9px 11px; border: 1px solid color-mix(in srgb, #d97706 45%, transparent); border-radius: 7px; color: #b45309; background: color-mix(in srgb, #d97706 9%, transparent); font-size: 12px; }
      .wqc-activity-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 140px 125px; gap: 8px; margin-top: 14px; }
      .wqc-search-input { font-size: 12px; }
      .wqc-search-input::placeholder { color: var(--wqc-muted, var(--bs-secondary-color)); opacity: 1; }
      .wqc-activity-table-wrap { container-type: inline-size; margin-top: 12px; overflow-x: auto; border: 1px solid var(--wqc-surface-border, var(--bs-border-color)); border-radius: 8px; }
      .wqc-activity-table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 12px; }
      .wqc-activity-table th, .wqc-activity-table td { padding: 9px 10px; border-bottom: 1px solid var(--wqc-surface-border, var(--bs-border-color)); text-align: left; vertical-align: middle; }
      .wqc-activity-table th { color: var(--bs-secondary-color); background: color-mix(in srgb, var(--bs-body-color) 4%, var(--bs-body-bg)); font-size: 11px; font-weight: 650; }
      .wqc-activity-table thead th:not(.wqc-table-fill), .wqc-activity-row > td:not(.wqc-table-fill) { width: 1%; white-space: nowrap; }
      .wqc-table-fill { width: 100%; padding: 0 !important; }
      .wqc-sequence-column, .wqc-activity-sequence { padding-right: 6px !important; padding-left: 6px !important; text-align: center !important; white-space: nowrap; }
      .wqc-summary-column { white-space: nowrap; }
      .wqc-activity-table tbody tr:last-child td { border-bottom: 0; }
      .wqc-activity-row-warn { box-shadow: inset 3px 0 #d97706; } .wqc-activity-row-error { box-shadow: inset 3px 0 var(--bs-danger); }
      .wqc-activity-sequence, .wqc-activity-time { color: var(--bs-secondary-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .wqc-category-pill, .wqc-status-pill { display: inline-block; padding: 2px 6px; border-radius: 5px; white-space: nowrap; background: color-mix(in srgb, var(--bs-primary) 10%, transparent); color: var(--bs-primary); font-size: 10px; font-weight: 700; }
      .wqc-status-warn { color: #b45309; background: color-mix(in srgb, #d97706 13%, transparent); }
      .wqc-status-error { color: var(--bs-danger); background: color-mix(in srgb, var(--bs-danger) 12%, transparent); }
      .wqc-activity-subject > span, .wqc-activity-summary > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wqc-activity-subject > span { max-width: clamp(80px, 16vw, 180px); }
      .wqc-activity-summary > span { max-width: clamp(110px, 28vw, 320px); }
      .wqc-activity-detail-toggle { padding-right: 6px !important; padding-left: 6px !important; white-space: nowrap; }
      .wqc-activity-detail-toggle button { padding: 2px 0; border: 0; color: var(--bs-primary); background: transparent; white-space: nowrap; font-size: 11px; }
      .wqc-activity-detail-toggle button:disabled { visibility: hidden; }
      .wqc-activity-detail-row td { padding: 0; background: color-mix(in srgb, var(--bs-body-color) 3%, var(--bs-body-bg)); }
      .wqc-activity-detail-panel { position: sticky; left: 0; width: 100cqi; max-width: 100cqi; box-sizing: border-box; }
      .wqc-activity-detail-row pre { width: 100%; max-height: 220px; box-sizing: border-box; margin: 0; padding: 11px 13px; overflow-x: hidden; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; color: var(--bs-body-color); font: 11px/1.5 "Cascadia Code", "JetBrains Mono", Consolas, monospace; }
      .wqc-activity-empty { padding: 24px !important; color: var(--bs-secondary-color); text-align: center !important; }
      .wqc-activity-pager { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; color: var(--bs-secondary-color); font-size: 12px; }
      .wqc-pager-count { white-space: nowrap; }
      .wqc-pager-controls { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
      .wqc-pager-controls .btn { min-width: 72px; }
      .wqc-page-jump { display: flex; align-items: center; gap: 6px; margin: 0; white-space: nowrap; }
      .wqc-page-jump input { width: 58px; min-height: 32px; padding: 4px 7px; text-align: center; font-variant-numeric: tabular-nums; }
      @media (max-width: 760px) {
        .wqc-retention-grid, .wqc-activity-toolbar { grid-template-columns: 1fr; }
        .wqc-activity-actions { justify-content: flex-start; }
        .wqc-storage-line { flex-direction: column; gap: 3px; }
        .wqc-activity-table-wrap { border: 0; overflow: visible; }
        .wqc-activity-table, .wqc-activity-table tbody, .wqc-activity-table tr, .wqc-activity-table td { display: block; width: 100%; min-width: 0; }
        .wqc-activity-table thead { display: none; }
        .wqc-activity-row { display: grid !important; grid-template-columns: 86px minmax(0, 1fr); margin-bottom: 9px; border: 1px solid var(--wqc-surface-border, var(--bs-border-color)); border-radius: 8px; padding: 7px 9px; }
        .wqc-activity-row td { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 8px; padding: 5px 0; border: 0; white-space: normal; }
        .wqc-activity-row .wqc-table-fill { display: none; }
        .wqc-activity-row td::before { content: attr(data-label); color: var(--bs-secondary-color); font-size: 11px; }
        .wqc-activity-detail-toggle { display: block !important; padding-left: 86px !important; }
        .wqc-activity-detail-toggle::before { display: none; }
        .wqc-activity-detail-row { margin: -9px 0 9px; border: 1px solid var(--wqc-surface-border, var(--bs-border-color)); border-top: 0; border-radius: 0 0 8px 8px; }
        .wqc-activity-detail-panel { position: static; width: 100%; max-width: 100%; }
        .wqc-activity-pager { align-items: flex-start; flex-direction: column; gap: 8px; }
        .wqc-pager-controls { justify-content: flex-start; flex-wrap: wrap; }
      }
    `],
})
export class ActivityLogComponent implements OnChanges {
    @Input() entries: ActivityLogEntry[] = []
    @Input() settings: ActivityLogRetentionSettings = { ...defaultActivityLogRetention }
    @Input() sizeBytes = 0
    @Output() settingsChange = new EventEmitter<ActivityLogRetentionSettings>()
    @Output() clearRequested = new EventEmitter<void>()
    @Output() openLocationRequested = new EventEmitter<void>()

    textQuery = ''
    category: 'all' | ActivityLogCategory = 'all'
    level: 'all' | ActivityLogLevel = 'all'
    page = 1
    readonly pageSize = 8
    openMenu: 'retention' | 'category' | 'level' | 'sizeUnit' | 'warningUnit' | null = null
    private expandedIds = new Set<string>()

    constructor (private i18n: QuickCommandsI18n) {}

    ngOnChanges (_changes: SimpleChanges): void {
        this.page = Math.min(this.page, this.pageCount)
    }

    get filteredEntries (): ActivityLogEntry[] {
        return filterActivityLogs(this.entries, { text: this.textQuery, category: this.category, level: this.level })
    }

    get filteredCount (): number { return this.filteredEntries.length }
    get pageCount (): number { return Math.max(1, Math.ceil(this.filteredCount / this.pageSize)) }
    get pageNumber (): number { return Math.min(this.page, this.pageCount) }
    get visibleEntries (): ActivityLogEntry[] {
        const start = (this.pageNumber - 1) * this.pageSize
        return this.filteredEntries.slice(start, start + this.pageSize)
    }

    get storageWarning (): boolean {
        return this.settings.mode === 'unlimited' && this.sizeBytes >= this.settings.warningSizeMb * 1024 * 1024
    }

    get retentionModeLabel (): string {
        const labels: Record<ActivityLogRetentionMode, string> = {
            count: '按条数', days: '按天数', size: '按大小', unlimited: '长期保留',
        }
        return this.i18n.text(labels[this.settings.mode])
    }

    get categoryFilterLabel (): string {
        return this.category === 'all' ? this.i18n.text('全部类型') : this.categoryLabel(this.category)
    }

    get levelFilterLabel (): string {
        const labels: Record<'all' | ActivityLogLevel, string> = {
            all: '全部结果', info: '信息', warn: '警告', error: '错误',
        }
        return this.i18n.text(labels[this.level])
    }

    get retentionHint (): string {
        if (this.settings.mode === 'days') { return `自动删除超过 ${this.settings.days} 天的旧日志` }
        if (this.settings.mode === 'size') { return `超过 ${this.displaySize(this.settings.sizeMb, this.settings.sizeUnit)} ${this.settings.sizeUnit} 时自动删除最旧日志` }
        if (this.settings.mode === 'unlimited') { return `不自动清理，超过 ${this.displaySize(this.settings.warningSizeMb, this.settings.warningSizeUnit)} ${this.settings.warningSizeUnit} 后提醒` }
        return `最多保留最近 ${this.settings.count} 条日志`
    }

    @HostListener('document:click')
    closeMenus (): void { this.openMenu = null }

    @HostListener('document:keydown.escape')
    closeMenusOnEscape (): void { this.openMenu = null }

    toggleMenu (menu: NonNullable<ActivityLogComponent['openMenu']>): void {
        this.openMenu = this.openMenu === menu ? null : menu
    }

    selectMode (mode: ActivityLogRetentionMode): void {
        this.openMenu = null
        this.settingsChange.emit({ ...this.settings, mode })
    }

    changeNumber (field: 'count' | 'days', event: Event, min: number, max: number): void {
        const input = event.target as HTMLInputElement
        const value = Math.max(min, Math.min(max, Math.round(Number(input.value) || min)))
        input.value = String(value)
        this.settingsChange.emit({ ...this.settings, [field]: value })
    }

    changeSizeNumber (field: 'sizeMb' | 'warningSizeMb', unit: ActivityLogSizeUnit, event: Event): void {
        const input = event.target as HTMLInputElement
        const rawValue = Number(input.value)
        const displayValue = Math.max(this.sizeInputMin(unit), Math.min(this.sizeInputMax(unit), Number.isFinite(rawValue) ? rawValue : this.sizeInputMin(unit)))
        const valueMb = Math.max(1, Math.min(102400, Math.round(displayValue * (unit === 'GB' ? 1024 : 1))))
        input.value = String(this.displaySize(valueMb, unit))
        this.settingsChange.emit({ ...this.settings, [field]: valueMb })
    }

    selectSizeUnit (field: 'sizeUnit' | 'warningUnit', unit: ActivityLogSizeUnit): void {
        this.openMenu = null
        const settingField = field === 'sizeUnit' ? 'sizeUnit' : 'warningSizeUnit'
        this.settingsChange.emit({ ...this.settings, [settingField]: unit })
    }

    displaySize (sizeMb: number, unit: ActivityLogSizeUnit): number {
        return activityLogSizeValue(sizeMb, unit)
    }

    sizeInputMin (unit: ActivityLogSizeUnit): number { return unit === 'GB' ? 0.01 : 1 }
    sizeInputMax (unit: ActivityLogSizeUnit): number { return unit === 'GB' ? 100 : 102400 }
    sizeInputStep (unit: ActivityLogSizeUnit): number { return unit === 'GB' ? 0.01 : 1 }

    releaseNumberWheel (event: WheelEvent): void { (event.currentTarget as HTMLInputElement | null)?.blur() }
    setTextQuery (event: Event): void { this.textQuery = (event.target as HTMLInputElement).value; this.page = 1 }
    selectCategory (category: 'all' | ActivityLogCategory): void { this.category = category; this.page = 1; this.openMenu = null }
    selectLevel (level: 'all' | ActivityLogLevel): void { this.level = level; this.page = 1; this.openMenu = null }
    previousPage (): void { this.page = Math.max(1, this.pageNumber - 1) }
    nextPage (): void { this.page = Math.min(this.pageCount, this.pageNumber + 1) }
    jumpToPage (event: Event): void {
        const input = event.target as HTMLInputElement
        this.page = Math.max(1, Math.min(this.pageCount, Math.round(Number(input.value) || 1)))
        input.value = String(this.pageNumber)
    }
    entryNumber (rowIndex: number): number { return (this.pageNumber - 1) * this.pageSize + rowIndex + 1 }
    isExpanded (id: string): boolean { return this.expandedIds.has(id) }
    toggleExpanded (id: string): void { this.expandedIds.has(id) ? this.expandedIds.delete(id) : this.expandedIds.add(id) }

    categoryLabel (category: ActivityLogCategory | undefined): string {
        const labels: Record<ActivityLogCategory, string> = {
            execution: '命令运行', command: '命令管理', category: '分类管理',
            library: '导入导出', settings: '设置', system: '系统',
        }
        return this.i18n.text(labels[category || 'execution'])
    }

    statusLabel (entry: ActivityLogEntry): string {
        if (entry.status === 'success') { return this.i18n.text('成功') }
        if (entry.level === 'error' || entry.status === 'failure') { return this.i18n.text('失败') }
        if (entry.level === 'warn' || entry.status === 'warning') { return this.i18n.text('警告') }
        return this.i18n.text('信息')
    }

    actionLabel (action: string | undefined): string {
        const labels: Record<string, string> = {
            'execution.start': '开始执行', 'execution.complete': '执行完成', 'execution.fail': '执行失败', 'execution.event': '运行事件',
            'command.create': '新增', 'command.update': '编辑', 'command.delete': '删除', 'command.duplicate': '复制',
            'command.move': '移动', 'command.reorder': '排序', 'command.favorite': '收藏', 'command.pin': '置顶',
            'category.create': '新增分类', 'category.rename': '重命名', 'category.delete': '删除分类', 'category.reorder': '分类排序',
            'library.import': '导入', 'library.export': '导出', 'settings.reset': '恢复默认', 'system.event': '系统事件',
        }
        return this.i18n.text(labels[action || 'execution.event'] || action || '运行事件')
    }

    subjectLabel (entry: ActivityLogEntry): string {
        return entry.subject?.name || entry.commandName || '—'
    }

    detailText (entry: ActivityLogEntry): string {
        const lines: string[] = []
        if (entry.commandText) { lines.push(`命令：${entry.commandText}`) }
        if (entry.line) { lines.push(`源行：${entry.line}`) }
        if (entry.mode) { lines.push(`模式：${entry.mode}`) }
        if (entry.durationMs !== undefined) { lines.push(`耗时：${this.formatDuration(entry.durationMs)}`) }
        if (entry.targetNames?.length) { lines.push(`目标：${entry.targetNames.join('、')}`) }
        Object.entries(entry.details || {}).forEach(([key, value]) => {
            const rendered = Array.isArray(value) ? value.join('、') : String(value)
            lines.push(`${this.detailKeyLabel(key)}：${rendered}`)
        })
        return lines.join('\n')
    }

    formatTime (isoTime: string): string {
        const date = new Date(isoTime)
        if (Number.isNaN(date.getTime())) { return isoTime }
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    formatBytes (bytes: number): string {
        if (bytes < 1024) { return `${bytes} B` }
        if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB` }
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    private formatDuration (durationMs: number): string {
        return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(2)}s`
    }

    private detailKeyLabel (key: string): string {
        const labels: Record<string, string> = {
            category: '分类', from: '原位置', to: '新位置', direction: '方向', sourceName: '来源命令',
            commandCount: '命令数量', clearedReferences: '清理引用', downloaded: '已下载', copied: '已复制',
            mode: '方式', enabled: '启用', reason: '原因',
        }
        return this.i18n.text(labels[key] || key)
    }
}
