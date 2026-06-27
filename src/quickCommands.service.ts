import { Injectable } from '@angular/core'
import { SettingsTabComponent } from 'tabby-settings'
import { AppService, ConfigService, LogService, Logger, PlatformService } from 'tabby-core'
import {
    AutomationLogEntry,
    ExecutionMode,
    ImportMode,
    QuickAutomationRule,
    QuickCommand,
    QuickCommandsConfig,
} from './types'
import { defaultCommands, defaultQuickCommandsConfig } from './configProvider'
import {
    applyImportPreview,
    buildTerminalPayload,
    buildImportPreview,
    ImportPreview,
    normalizeCommandConfig,
    normalizeCommandText,
    parseImportPayload,
    resolveSelectedCommand,
    sanitizeAutomationReferences,
} from './commandLibrary'
import {
    findShortcutConflict,
    flattenHotkeysConfig,
    normalizeShortcut,
    shortcutFromKeyboardEvent,
} from './shortcutManager'
import { getDangerCheck } from './safety'
import { getExecutableLineCount, parseScriptSteps, ScriptStep } from './scriptParser'
import { CommandUsageStats, QuickCommandsRuntimeStore } from './runtimeStorage'
import { findOutputMatch, isValidOutputPattern } from './outputAutomation'
import { pluginConfigChangedEvent, QuickCommandsPluginConfigStore } from './pluginConfigStorage'
import { QuickCommandsI18n } from './i18n'

interface OutputSubscription {
    unsubscribe: () => void
}

interface OutputStreamLike {
    subscribe: (handler: (data: string) => void) => OutputSubscription
}

interface OutputBuffer {
    text: string
    startOffset: number
    endOffset: number
}

interface AutomationRuleResult {
    outcome: 'match' | 'error' | 'timeout' | 'stopped'
    matchedText: string
}

interface TerminalTabLike {
    title?: string
    profile?: {
        name?: string
    }
    sendInput: (data: string) => void
    output$?: OutputStreamLike
    session?: {
        output$?: OutputStreamLike
    } | null
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

interface RunState {
    commandId: string
    startedAt: string
    currentStep: number
    totalSteps: number
    sourceLine: number
    paused: boolean
    stopped: boolean
    waitingManual: boolean
    manualResolver?: () => void
}

const css = `
.tqc-root {
  position: fixed;
  inset: 0 0 0 auto;
  z-index: 10000;
  pointer-events: none;
  font-family: var(--font-family, "Inter", "Segoe UI", system-ui, sans-serif);
}

.tqc-drawer {
  position: relative;
  container-type: inline-size;
  --tqc-accent: color-mix(in srgb, var(--bs-primary, #1677ff) 72%, var(--tqc-text) 28%);
  --tqc-danger: var(--bs-danger, #c2410c);
  --tqc-success: var(--bs-success, #15803d);
  --tqc-panel-solid: var(--bs-body-bg, #ffffff);
  --tqc-text: var(--bs-body-color, #1f2937);
  --tqc-muted: color-mix(in srgb, var(--tqc-text) 72%, transparent);
  --tqc-border: var(--bs-border-color, rgba(15, 23, 42, 0.14));
  --tqc-accent-soft: color-mix(in srgb, var(--tqc-accent) 14%, transparent);
  --tqc-panel: color-mix(in srgb, var(--tqc-panel-solid) 94%, transparent);
  --tqc-surface-border: color-mix(in srgb, var(--tqc-panel-solid) 72%, var(--tqc-text) 28%);
  --tqc-control-border: color-mix(in srgb, var(--tqc-panel-solid) 62%, var(--tqc-text) 38%);
  --tqc-border-strong: color-mix(in srgb, var(--tqc-border) 72%, var(--tqc-text));
  --tqc-subtle: color-mix(in srgb, var(--tqc-panel-solid) 88%, var(--tqc-text) 12%);
  --tqc-code: color-mix(in srgb, var(--tqc-panel-solid) 92%, var(--tqc-text) 8%);
  --tqc-window-control-safe: 34px;
  width: min(var(--tqc-width, 520px), 100vw);
  height: 100vh;
  margin-left: auto;
  pointer-events: auto;
  color: var(--tqc-text);
  background: var(--tqc-panel);
  border-left: 1px solid var(--tqc-border);
  box-shadow: -18px 0 40px rgba(15, 23, 42, 0.16);
  transform: translateX(102%);
  transition: transform 160ms ease;
  display: grid;
  grid-template-rows: auto 1fr auto;
  backdrop-filter: blur(18px);
}

.tqc-root.tqc-open .tqc-drawer {
  transform: translateX(0);
}

.tqc-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  width: 10px;
  cursor: ew-resize;
}

.tqc-header,
.tqc-footer {
  padding: 14px 16px;
  background: color-mix(in srgb, var(--tqc-panel-solid) 82%, transparent);
}

.tqc-header {
  padding-top: calc(14px + var(--tqc-window-control-safe));
  border-bottom: 1px solid var(--tqc-border);
}

.tqc-top-row {
  position: absolute;
  top: 12px;
  left: 16px;
  z-index: 4;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.tqc-top-row .tqc-icon-button {
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.tqc-footer {
  border-top: 1px solid var(--tqc-border);
}

.tqc-titlebar,
.tqc-search-row,
.tqc-footer-row,
.tqc-category-tools,
.tqc-command-actions,
.tqc-summary-row,
.tqc-inline-actions,
.tqc-card-head,
.tqc-run-status,
.tqc-line-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tqc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  flex: 1;
  min-width: 0;
}

.tqc-title svg {
  width: 20px;
  height: 20px;
  color: var(--tqc-accent);
}

.tqc-icon-button,
.tqc-primary,
.tqc-secondary,
.tqc-chip,
.tqc-mode,
.tqc-command,
.tqc-mini {
  border: 1px solid var(--tqc-control-border);
  background: var(--tqc-panel-solid);
  color: var(--tqc-text);
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}

.tqc-icon-button {
  width: 32px;
  height: 32px;
  min-width: 32px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.tqc-icon-button svg,
.tqc-secondary svg,
.tqc-primary svg,
.tqc-mini svg {
  width: 15px;
  height: 15px;
}

.tqc-icon-button:not(:disabled):hover,
.tqc-secondary:not(:disabled):hover,
.tqc-chip:not(:disabled):hover,
.tqc-mode:not(:disabled):hover,
.tqc-mini:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 38%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-accent) 7%, var(--tqc-panel-solid));
  color: color-mix(in srgb, var(--tqc-accent) 72%, var(--tqc-text));
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.1);
  transform: translateY(-1px);
}

.tqc-command:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 32%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-accent) 6%, var(--tqc-panel-solid));
  box-shadow: 0 5px 14px rgba(15, 23, 42, 0.08);
}

.tqc-icon-button.tqc-active {
  border-color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
  color: var(--tqc-accent);
}

.tqc-icon-button.tqc-active:hover,
.tqc-chip.tqc-active:hover,
.tqc-mode.tqc-active:hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 78%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-accent) 19%, var(--tqc-panel-solid));
  color: var(--tqc-accent);
}

.tqc-icon-button.tqc-menu-danger:not(:disabled):hover {
  color: var(--tqc-danger);
  border-color: color-mix(in srgb, var(--tqc-danger) 38%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-danger) 10%, var(--tqc-panel-solid));
}

.tqc-search-row {
  position: relative;
  margin-top: 12px;
}

.tqc-search-clear {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 28px;
  height: 28px;
  min-width: 28px;
  transform: none;
  color: var(--tqc-muted);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.tqc-icon-button.tqc-search-clear:not(:disabled):hover,
.tqc-icon-button.tqc-search-clear:focus-visible {
  color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
  border-color: transparent;
  box-shadow: none;
  transform: none;
}

.tqc-search {
  flex: 1;
  min-width: 0;
  height: 36px;
  border-radius: 7px;
  border: 1px solid var(--tqc-border);
  background: var(--tqc-subtle);
  color: var(--tqc-text);
  padding: 0 40px 0 12px;
  outline: none;
  font: inherit;
  font-size: 13px;
  transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

.tqc-search:hover,
.tqc-input:hover,
.tqc-textarea:hover,
.tqc-select:hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 30%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-accent) 3%, var(--tqc-subtle));
}

.tqc-search:focus,
.tqc-input:focus,
.tqc-textarea:focus,
.tqc-select:focus {
  border-color: var(--tqc-accent);
  box-shadow: 0 0 0 2px var(--tqc-accent-soft);
}

.tqc-category-tools {
  margin-top: 10px;
  flex-wrap: wrap;
}

.tqc-header-menu-shell,
.tqc-category-action-menu-shell {
  position: relative;
}

.tqc-header-menu-shell > .tqc-secondary {
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
}

.tqc-header-menu-shell > .tqc-secondary.tqc-active {
  color: var(--tqc-accent);
  border-color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
}

.tqc-action-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 14;
  display: grid;
  gap: 3px;
  width: 160px;
  padding: 5px;
  color: var(--tqc-text);
  background: var(--tqc-panel-solid);
  border: 1px solid var(--tqc-border);
  border-radius: 8px;
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
}

.tqc-header-menu-shell > .tqc-action-menu {
  width: max-content;
}

.tqc-header-menu-shell > .tqc-action-menu button {
  white-space: nowrap;
}

.tqc-action-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 0 9px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.tqc-action-menu button:not(:disabled):hover {
  color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
}

.tqc-action-menu button.tqc-menu-danger:not(:disabled):hover {
  color: var(--tqc-danger);
  background: color-mix(in srgb, var(--tqc-danger) 10%, transparent);
}

.tqc-action-menu button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.tqc-action-menu svg {
  width: 15px;
  height: 15px;
}

.tqc-categories {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}

.tqc-category-scroll {
  display: flex;
  gap: 8px;
  overflow: hidden;
  min-width: 0;
  padding: 3px 8px 4px;
}

.tqc-category-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tqc-category-actions > .tqc-icon-button {
  flex: none;
  align-self: start;
}

.tqc-category-overflow-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 12;
  width: min(260px, calc(100vw - 32px));
  max-height: min(360px, 55vh);
  overflow: auto;
  padding: 6px;
  color: var(--tqc-text);
  background: var(--tqc-panel-solid);
  border: 1px solid var(--tqc-border);
  border-radius: 9px;
  box-shadow: 0 14px 38px rgba(15, 23, 42, 0.2);
}

.tqc-category-overflow-search {
  width: 100%;
  height: 32px;
  margin-bottom: 6px;
  padding: 0 9px;
  color: var(--tqc-text);
  background: var(--tqc-subtle);
  border: 1px solid var(--tqc-border);
  border-radius: 7px;
  outline: none;
  font: inherit;
  font-size: 12px;
}

.tqc-category-overflow-search:focus {
  border-color: var(--tqc-accent);
  box-shadow: 0 0 0 2px var(--tqc-accent-soft);
}

.tqc-category-overflow-options {
  display: grid;
  gap: 3px;
}

.tqc-category-overflow-option {
  position: relative;
  width: 100%;
  min-height: 32px;
  padding: 0 9px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}

.tqc-category-overflow-option.tqc-drop-before::before,
.tqc-category-overflow-option.tqc-drop-after::after {
  content: "";
  position: absolute;
  right: 6px;
  left: 6px;
  height: 3px;
  border-radius: 999px;
  background: var(--tqc-accent);
  box-shadow: 0 0 0 2px var(--tqc-accent-soft);
}

.tqc-category-overflow-option.tqc-drop-before::before {
  top: -3px;
}

.tqc-category-overflow-option.tqc-drop-after::after {
  bottom: -3px;
}

.tqc-category-overflow-option:hover,
.tqc-category-overflow-option.tqc-active {
  color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
}

.tqc-chip {
  position: relative;
  height: 31px;
  border-radius: 7px;
  padding: 0 11px;
  font-size: 12px;
  white-space: nowrap;
}

.tqc-chip.tqc-drop-before::before,
.tqc-chip.tqc-drop-after::after {
  content: "";
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 3px;
  border-radius: 999px;
  background: var(--tqc-accent);
  box-shadow: 0 0 0 2px var(--tqc-accent-soft);
}

.tqc-chip.tqc-drop-before::before {
  left: -6px;
}

.tqc-chip.tqc-drop-after::after {
  right: -6px;
}

.tqc-chip.tqc-active,
.tqc-mode.tqc-active {
  border-color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
  color: var(--tqc-accent);
}

.tqc-body {
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(160px, 34%, 210px) minmax(0, 1fr);
  gap: 12px;
  padding: 14px 16px;
  overflow: hidden;
}

.tqc-list,
.tqc-detail {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-color: color-mix(in srgb, var(--tqc-muted) 28%, transparent) transparent;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}

.tqc-list::-webkit-scrollbar,
.tqc-detail::-webkit-scrollbar,
.tqc-category-overflow-menu::-webkit-scrollbar {
  width: 8px;
}

.tqc-list::-webkit-scrollbar-track,
.tqc-detail::-webkit-scrollbar-track,
.tqc-category-overflow-menu::-webkit-scrollbar-track {
  background: transparent;
}

.tqc-list::-webkit-scrollbar-thumb,
.tqc-detail::-webkit-scrollbar-thumb,
.tqc-category-overflow-menu::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--tqc-muted) 24%, transparent);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}

.tqc-list::-webkit-scrollbar-thumb:hover,
.tqc-detail::-webkit-scrollbar-thumb:hover,
.tqc-category-overflow-menu::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--tqc-accent) 38%, transparent);
  border: 2px solid transparent;
  background-clip: padding-box;
}

.tqc-detail {
  padding-top: 3px;
}

.tqc-list-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 8px;
}

.tqc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 1px;
}

.tqc-list-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tqc-list-sort {
  display: flex;
  gap: 6px;
}

.tqc-command {
  min-width: 0;
  overflow: hidden;
  border-color: var(--tqc-surface-border);
  border-radius: 8px;
  padding: 10px;
  text-align: left;
  display: grid;
  gap: 5px;
  cursor: pointer;
}

.tqc-command-shell {
  position: relative;
  min-width: 0;
}

.tqc-command-shell .tqc-command {
  width: 100%;
  padding-right: 70px;
}

.tqc-command-edit,
.tqc-command-run {
  position: absolute;
  top: 7px;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--tqc-muted);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-2px);
  transition: opacity 140ms ease, transform 140ms ease, background-color 140ms ease, border-color 140ms ease;
}

.tqc-command-edit {
  right: 6px;
}

.tqc-command-run {
  right: 34px;
}

.tqc-command-edit:hover,
.tqc-command-edit:focus-visible,
.tqc-command-run:hover,
.tqc-command-run:focus-visible {
  color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
  border-color: transparent;
  box-shadow: none;
}

.tqc-command-shell:hover .tqc-command-edit,
.tqc-command-shell:hover .tqc-command-run,
.tqc-command-shell:focus-within .tqc-command-edit,
.tqc-command-shell:focus-within .tqc-command-run,
.tqc-command.tqc-selected ~ .tqc-command-edit,
.tqc-command.tqc-selected ~ .tqc-command-run {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.tqc-command-edit svg {
  width: 14px;
  height: 14px;
}

.tqc-command-run svg {
  width: 18px;
  height: 18px;
}

.tqc-command.tqc-dragging {
  opacity: 0.55;
}

.tqc-command.tqc-selected {
  border-color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
}

.tqc-command.tqc-selected:hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 80%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-accent) 17%, var(--tqc-panel-solid));
}

.tqc-command-top {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

.tqc-command-name,
.tqc-detail-name {
  font-weight: 650;
  overflow-wrap: anywhere;
}

.tqc-command-name {
  display: block;
  flex: 1;
  min-width: 0;
  max-width: 100%;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tqc-command-desc,
.tqc-muted {
  color: var(--tqc-muted);
}

.tqc-command-desc {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.tqc-command-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tqc-kbd,
.tqc-pill {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  border: 1px solid var(--tqc-border);
  border-radius: 5px;
  padding: 0 6px;
  background: var(--tqc-subtle);
  color: var(--tqc-muted);
  font-size: 11px;
}

.tqc-kbd {
  border-bottom-color: var(--tqc-border-strong);
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
}

.tqc-pill {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tqc-pill.tqc-good {
  color: var(--tqc-success);
  border-color: color-mix(in srgb, var(--tqc-success) 38%, var(--tqc-border));
}

.tqc-empty {
  color: var(--tqc-muted);
  font-size: 13px;
  padding: 20px 8px;
  text-align: center;
}

.tqc-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.tqc-detail-head {
  display: block;
}

.tqc-detail-name {
  font-size: 16px;
  line-height: 1.3;
}

.tqc-detail-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 5px;
}

.tqc-detail-desc {
  color: var(--tqc-muted);
  font-size: 12px;
  line-height: 1.45;
  min-width: 0;
  overflow-wrap: anywhere;
}

.tqc-command-actions {
  flex-wrap: wrap;
  justify-content: flex-start;
  max-width: none;
  width: 100%;
}

.tqc-command-menu-shell {
  position: relative;
}

.tqc-command-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: auto;
  z-index: 8;
  display: grid;
  gap: 3px;
  width: 156px;
  box-sizing: border-box;
  padding: 5px;
  color: var(--tqc-text);
  background: var(--tqc-panel-solid);
  border: 1px solid var(--tqc-border);
  border-radius: 8px;
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
}

.tqc-command-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 9px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.tqc-command-menu button:hover {
  color: var(--tqc-accent);
  background: var(--tqc-accent-soft);
}

.tqc-command-menu button.tqc-menu-danger:hover {
  color: var(--tqc-danger);
  background: color-mix(in srgb, var(--tqc-danger) 10%, transparent);
}

.tqc-command-menu svg {
  width: 15px;
  height: 15px;
  flex: none;
}

.tqc-command-card {
  width: 100%;
  box-sizing: border-box;
  border-color: color-mix(in srgb, var(--tqc-accent) 28%, var(--tqc-surface-border));
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
}

.tqc-command-card > label {
  display: block;
  width: 100%;
}

.tqc-textarea.tqc-command-editor {
  display: block;
  width: 100%;
  height: calc(var(--tqc-command-height, 1.48em) + 22px);
  min-height: calc(1.48em + 22px);
  max-height: 20vh;
  box-sizing: border-box;
  overflow-y: auto;
  resize: none;
}

.tqc-execution-card .tqc-mode-row {
  margin-bottom: 10px;
}

.tqc-card {
  border: 1px solid var(--tqc-surface-border);
  background: var(--tqc-panel-solid);
  border-radius: 8px;
  padding: 12px;
}

.tqc-card.tqc-compact {
  padding: 10px;
}

.tqc-card-head {
  justify-content: space-between;
  margin-bottom: 10px;
}

.tqc-card-head .tqc-label {
  margin-bottom: 0;
}

.tqc-card-title {
  min-width: 0;
}

.tqc-card-head.tqc-collapsible {
  margin-bottom: 0;
}

.tqc-card-head.tqc-collapsible + .tqc-card-content {
  margin-top: 10px;
}

.tqc-card-summary {
  margin-top: 3px;
  color: var(--tqc-muted);
  font-size: 11px;
  line-height: 1.35;
}

.tqc-more-content,
.tqc-more-section {
  display: grid;
  gap: 10px;
}

.tqc-more-section {
  padding-top: 10px;
  border-top: 1px solid var(--tqc-border);
}

.tqc-automation-toolbar {
  position: sticky;
  top: -3px;
  z-index: 6;
  margin: -3px -4px 0;
  padding: 7px 4px;
  background: var(--tqc-panel-solid);
  border-bottom: 1px solid var(--tqc-border);
}

.tqc-automation-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.tqc-label {
  display: block;
  font-size: 12px;
  font-weight: 650;
  margin-bottom: 7px;
}

.tqc-input,
.tqc-textarea,
.tqc-select {
  width: 100%;
  border-radius: 7px;
  border: 1px solid var(--tqc-control-border);
  background: var(--tqc-subtle);
  color: var(--tqc-text);
  outline: none;
  font: inherit;
  font-size: 13px;
  transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

.tqc-category-select,
.tqc-target-select,
.tqc-rule-select {
  position: relative;
  min-width: 0;
}

.tqc-rule-action-detail {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--tqc-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tqc-subtle) 72%, transparent);
}

.tqc-rule-action-detail .tqc-checkbox {
  margin-top: 7px;
}

.tqc-rule-command {
  min-height: 64px;
  resize: vertical;
}

.tqc-rule-pattern {
  margin-top: 8px;
  min-height: 36px;
  resize: vertical;
}

.tqc-rule-command-search {
  height: 30px;
  margin-bottom: 5px;
  padding: 0 8px;
  font-size: 12px;
}

.tqc-rule-menu-empty {
  padding: 7px 9px;
  color: var(--tqc-muted);
  font-size: 12px;
}

.tqc-category-select .tqc-select,
.tqc-target-select .tqc-select,
.tqc-rule-select .tqc-select {
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.tqc-target-select .tqc-select > span,
.tqc-rule-select .tqc-select > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tqc-category-select .tqc-select svg,
.tqc-target-select .tqc-select svg,
.tqc-rule-select .tqc-select svg {
  width: 15px;
  height: 15px;
  flex: none;
}

.tqc-category-menu,
.tqc-target-menu,
.tqc-rule-menu {
  position: absolute;
  z-index: 8;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 190px;
  overflow: auto;
  border: 1px solid var(--tqc-border);
  border-radius: 8px;
  background: var(--tqc-panel-solid);
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
  padding: 5px;
}

.tqc-category-option,
.tqc-target-option,
.tqc-rule-option {
  width: 100%;
  min-height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--tqc-text);
  text-align: left;
  padding: 0 9px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
}

.tqc-target-option,
.tqc-rule-option {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tqc-category-option:hover,
.tqc-category-option.tqc-active,
.tqc-target-option:hover,
.tqc-target-option.tqc-active,
.tqc-rule-option:hover,
.tqc-rule-option.tqc-active {
  background: var(--tqc-accent-soft);
  color: var(--tqc-accent);
}

.tqc-category-option:hover,
.tqc-target-option:hover,
.tqc-rule-option:hover {
  transform: translateX(2px);
}

.tqc-input,
.tqc-select {
  height: 34px;
  padding: 0 10px;
}

.tqc-textarea {
  min-height: 148px;
  resize: vertical;
  padding: 10px 12px;
  line-height: 1.48;
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
}

.tqc-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.tqc-field-grid > label {
  min-width: 0;
}

.tqc-field-grid.tqc-three {
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(116px, 0.75fr);
}

.tqc-field-grid.tqc-single {
  grid-template-columns: 1fr;
}

.tqc-shortcut-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  gap: 6px;
}

.tqc-field-hint {
  display: block;
  margin-top: 5px;
  color: var(--tqc-muted);
  font-size: 11px;
  line-height: 1.45;
}

.tqc-field-hint.tqc-field-hint-error {
  color: var(--tqc-danger);
}

.tqc-code {
  border: 1px solid var(--tqc-border);
  background: var(--tqc-code);
  border-radius: 7px;
  overflow: hidden;
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
}

.tqc-code-line {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 178px;
  align-items: stretch;
  transition: background-color 150ms ease, box-shadow 150ms ease;
}

.tqc-code-line.tqc-pause-after {
  background: color-mix(in srgb, var(--tqc-accent) 7%, transparent);
  box-shadow: inset -3px 0 var(--tqc-accent);
}

.tqc-code-line.tqc-pause-after .tqc-line-no {
  color: var(--tqc-accent);
  font-weight: 700;
}

.tqc-line-no {
  color: var(--tqc-muted);
  background: rgba(15, 23, 42, 0.04);
  text-align: right;
  padding: 7px 8px 7px 4px;
  user-select: none;
}

.tqc-line-text {
  min-width: 0;
  padding: 7px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}

.tqc-line-tools {
  justify-content: flex-end;
  padding: 4px 6px;
  border-left: 1px solid var(--tqc-border);
}

.tqc-line-delay {
  width: 56px;
  height: 26px;
  font-size: 11px;
  padding: 0 5px;
  appearance: textfield;
}

.tqc-line-delay::-webkit-inner-spin-button,
.tqc-line-delay::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.tqc-line-pause {
  width: 92px;
  height: 28px;
  min-width: 92px;
  border-radius: 6px;
  gap: 5px;
  padding: 0 7px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.tqc-line-pause svg {
  width: 13px;
  height: 13px;
}

.tqc-line-pause:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  transform: none;
}

.tqc-line-pause:not(.tqc-active) {
  color: var(--tqc-muted);
  background: var(--tqc-panel-solid);
}

.tqc-mode-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.tqc-mode {
  min-height: 56px;
  border-radius: 8px;
  padding: 8px;
  font-size: 12px;
  text-align: left;
}

.tqc-mode strong {
  display: block;
  font-size: 13px;
  margin-bottom: 3px;
}

.tqc-summary {
  display: grid;
  gap: 8px;
  font-size: 12px;
}

.tqc-summary-row {
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.tqc-summary-row span:first-child {
  color: var(--tqc-muted);
  white-space: nowrap;
}

.tqc-summary-row strong,
.tqc-summary-row span:last-child {
  text-align: right;
  overflow-wrap: anywhere;
}

.tqc-target-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
  max-width: 100%;
}

.tqc-risk {
  border-color: color-mix(in srgb, var(--tqc-danger) 42%, var(--tqc-border));
  background: color-mix(in srgb, var(--tqc-danger) 10%, var(--tqc-panel-solid));
}

.tqc-risk .tqc-label,
.tqc-risk strong {
  color: var(--tqc-danger);
}

.tqc-secondary,
.tqc-primary,
.tqc-mini {
  height: 36px;
  border-radius: 7px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
}

.tqc-mini {
  height: 28px;
  padding: 0 9px;
  font-size: 12px;
}

.tqc-primary {
  flex: 1;
  position: relative;
  border-color: var(--tqc-accent);
  background: var(--tqc-accent);
  color: white;
}

.tqc-primary .tqc-kbd {
  position: absolute;
  right: 10px;
  min-height: 18px;
  border-color: color-mix(in srgb, white 48%, transparent);
  border-bottom-color: color-mix(in srgb, white 72%, transparent);
  background: color-mix(in srgb, white 14%, transparent);
  color: white;
  font-size: 10px;
}

.tqc-primary:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--tqc-accent) 82%, white);
  background: color-mix(in srgb, var(--tqc-accent) 88%, white);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--tqc-accent) 25%, transparent);
  transform: translateY(-1px);
}

.tqc-primary:disabled,
.tqc-secondary:disabled,
.tqc-icon-button:disabled,
.tqc-mini:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .tqc-icon-button,
  .tqc-primary,
  .tqc-secondary,
  .tqc-chip,
  .tqc-mode,
  .tqc-command,
  .tqc-mini,
  .tqc-category-option,
  .tqc-target-option {
    transition: none;
  }

  .tqc-icon-button:hover,
  .tqc-primary:hover,
  .tqc-secondary:hover,
  .tqc-chip:hover,
  .tqc-mode:hover,
  .tqc-command:hover,
  .tqc-mini:hover,
  .tqc-category-option:hover,
  .tqc-target-option:hover {
    transform: none;
  }
}

.tqc-hint {
  margin-bottom: 10px;
  min-height: 18px;
  color: var(--tqc-muted);
  font-size: 12px;
  line-height: 1.45;
}

.tqc-hint.tqc-danger {
  color: var(--tqc-danger);
}

.tqc-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--tqc-muted);
  min-height: 28px;
}

.tqc-checkbox-control {
  display: grid;
  place-content: center;
  appearance: none;
  width: 16px;
  min-width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  background: var(--tqc-panel-solid);
  border: 1px solid color-mix(in srgb, var(--tqc-muted) 58%, var(--tqc-border));
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}

.tqc-checkbox-control::before {
  width: 8px;
  height: 5px;
  border-bottom: 2px solid #fff;
  border-left: 2px solid #fff;
  content: "";
  transform: translateY(-1px) rotate(-45deg) scale(0);
  transition: transform 100ms ease;
}

.tqc-checkbox-control:hover {
  border-color: var(--tqc-accent);
  box-shadow: 0 0 0 2px var(--tqc-accent-soft);
}

.tqc-checkbox-control:checked {
  background: var(--tqc-accent);
  border-color: var(--tqc-accent);
}

.tqc-checkbox-control:checked::before {
  transform: translateY(-1px) rotate(-45deg) scale(1);
}

.tqc-rule-list,
.tqc-log-list {
  display: grid;
  gap: 8px;
}

.tqc-rule {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--tqc-border);
  border-radius: 7px;
  background: var(--tqc-subtle);
}

.tqc-rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.tqc-rule-title,
.tqc-rule-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tqc-rule-title {
  flex-wrap: wrap;
}

.tqc-rule-title strong {
  font-size: 13px;
  color: var(--tqc-text);
  white-space: nowrap;
}

.tqc-rule-head-actions {
  flex: none;
}

.tqc-rule-disabled {
  opacity: 0.68;
}

.tqc-rule-warning {
  color: var(--tqc-danger);
  font-size: 12px;
}

.tqc-log {
  font-size: 12px;
  line-height: 1.45;
  color: var(--tqc-muted);
  overflow-wrap: anywhere;
}

.tqc-confirm-backdrop {
  position: fixed;
  inset: 0 0 0 auto;
  width: min(var(--tqc-width, 520px), 100vw);
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.tqc-tooltip {
  --tqc-accent: var(--bs-primary, #1677ff);
  --tqc-panel-solid: var(--bs-body-bg, #ffffff);
  --tqc-text: var(--bs-body-color, #1f2937);
  --tqc-border: var(--bs-border-color, rgba(15, 23, 42, 0.14));
  position: fixed;
  z-index: 10020;
  max-width: min(260px, calc(100vw - 20px));
  padding: 7px 10px;
  pointer-events: none;
  color: var(--tqc-text);
  background: color-mix(in srgb, var(--tqc-panel-solid) 94%, var(--tqc-accent) 6%);
  border: 1px solid color-mix(in srgb, var(--tqc-accent) 24%, var(--tqc-border));
  border-radius: 9px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  overflow-wrap: anywhere;
  opacity: 0;
  transform: translateY(-3px) scale(0.98);
  transform-origin: top center;
  transition: opacity 120ms ease, transform 120ms ease;
  backdrop-filter: blur(12px);
}

.tqc-tooltip::before {
  position: absolute;
  top: -5px;
  left: var(--tqc-tooltip-arrow, 50%);
  width: 8px;
  height: 8px;
  content: '';
  background: inherit;
  border-top: 1px solid color-mix(in srgb, var(--tqc-accent) 24%, var(--tqc-border));
  border-left: 1px solid color-mix(in srgb, var(--tqc-accent) 24%, var(--tqc-border));
  transform: translateX(-50%) rotate(45deg);
}

.tqc-tooltip.tqc-tooltip-above {
  transform-origin: bottom center;
}

.tqc-tooltip.tqc-tooltip-above::before {
  top: auto;
  bottom: -5px;
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--tqc-accent) 24%, var(--tqc-border));
  border-bottom: 1px solid color-mix(in srgb, var(--tqc-accent) 24%, var(--tqc-border));
}

.tqc-tooltip.tqc-tooltip-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.tqc-confirm {
  --tqc-confirm-bg: #eef2f7;
  --tqc-confirm-text: #172033;
  --tqc-confirm-muted: #475569;
  --tqc-confirm-border: rgba(71, 85, 105, 0.42);
  --tqc-confirm-input: #f8fafc;
  --tqc-confirm-primary: #1677ff;
  --tqc-confirm-primary-text: #ffffff;
  width: min(460px, calc(100% - 32px));
  max-height: calc(100vh - 32px);
  overflow: auto;
  border: 1px solid var(--tqc-confirm-border);
  border-radius: 8px;
  background: var(--tqc-confirm-bg);
  background-color: var(--tqc-confirm-bg);
  color: var(--tqc-confirm-text);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.34);
  padding: 14px;
}

.tqc-confirm .tqc-input,
.tqc-confirm .tqc-select {
  background: var(--tqc-confirm-input);
  border-color: var(--tqc-confirm-border);
  color: var(--tqc-confirm-text);
}

.tqc-confirm label {
  display: block;
}

.tqc-confirm .tqc-primary {
  background: var(--tqc-confirm-primary);
  border-color: var(--tqc-confirm-primary);
  color: var(--tqc-confirm-primary-text);
}

.tqc-confirm .tqc-primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--tqc-confirm-primary) 84%, #000000);
  border-color: color-mix(in srgb, var(--tqc-confirm-primary) 76%, #000000);
  color: var(--tqc-confirm-primary-text);
}

.tqc-confirm .tqc-secondary {
  background: var(--tqc-confirm-input);
  border-color: var(--tqc-confirm-border);
  color: var(--tqc-confirm-text);
}

.tqc-confirm .tqc-label,
.tqc-confirm strong {
  color: var(--tqc-confirm-text);
}

.tqc-confirm-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 5px;
  color: var(--tqc-confirm-text);
}

.tqc-confirm-desc {
  color: var(--tqc-confirm-muted);
  font-size: 12px;
  line-height: 1.45;
  margin-bottom: 12px;
}

.tqc-confirm-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.tqc-confirm-actions .tqc-secondary,
.tqc-confirm-actions .tqc-primary {
  flex: 1;
}

.tqc-move-select {
  position: relative;
}

.tqc-move-select-button {
  justify-content: space-between;
  text-align: left;
}

.tqc-move-select-button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tqc-move-select-button svg {
  width: 15px;
  height: 15px;
  flex: none;
  transition: transform 140ms ease;
}

.tqc-move-select.tqc-open .tqc-move-select-button svg {
  transform: rotate(180deg);
}

.tqc-move-select-menu {
  position: absolute;
  right: 0;
  left: 0;
  z-index: 30;
  max-height: 210px;
  margin-top: 6px;
  padding: 5px;
  overflow: auto;
  background: var(--tqc-confirm-bg);
  border: 1px solid var(--tqc-confirm-border);
  border-radius: 9px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
}

.tqc-move-select-option {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 6px 12px;
  color: var(--tqc-confirm-text);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;
  transition: background-color 120ms ease, color 120ms ease;
}

.tqc-move-confirm {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.tqc-move-confirm.tqc-selecting {
  min-height: min(520px, calc(100vh - 32px));
}

.tqc-move-confirm.tqc-selecting .tqc-move-follow {
  margin-top: auto;
}

.tqc-confirm label.tqc-move-follow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  color: var(--tqc-confirm-text);
  cursor: pointer;
}

.tqc-confirm .tqc-move-follow .tqc-checkbox-control {
  background: var(--tqc-confirm-input);
  border-color: var(--tqc-confirm-border);
}

.tqc-confirm .tqc-move-follow input.tqc-checkbox-control[type="checkbox"] {
  width: 18px;
  min-width: 18px;
  height: 18px;
}

.tqc-confirm .tqc-move-follow input.tqc-checkbox-control[type="checkbox"]:not(:checked) {
  background-color: var(--tqc-confirm-input) !important;
  border: 1px solid #94a3b8 !important;
  box-shadow: none;
}

.tqc-confirm .tqc-move-follow .tqc-checkbox-control:checked {
  background: var(--tqc-confirm-primary);
  border-color: var(--tqc-confirm-primary);
}

.tqc-move-select-option:hover {
  color: var(--tqc-confirm-text);
  background: color-mix(in srgb, var(--tqc-confirm-border) 18%, transparent);
}

.tqc-move-select-option.tqc-active {
  color: var(--tqc-confirm-primary);
  background: color-mix(in srgb, var(--tqc-confirm-primary) 12%, transparent);
  font-weight: 600;
}

.tqc-hidden-file {
  display: none;
}

@container (max-width: 480px) {
  .tqc-body {
    grid-template-columns: 138px minmax(0, 1fr);
    gap: 10px;
    padding: 12px;
  }

  .tqc-detail-head {
    grid-template-columns: minmax(0, 1fr);
  }

  .tqc-command-actions {
    justify-self: start;
  }

  .tqc-field-grid,
  .tqc-field-grid.tqc-three {
    grid-template-columns: 1fr;
  }

  .tqc-code-line {
    grid-template-columns: 28px minmax(0, 1fr) 96px;
  }

  .tqc-line-no {
    padding-right: 5px;
  }

  .tqc-line-text {
    min-width: 0;
    white-space: pre;
    overflow: hidden;
    overflow-wrap: normal;
    text-overflow: ellipsis;
  }

  .tqc-line-tools {
    gap: 4px;
    padding-inline: 4px;
  }

  .tqc-line-delay {
    width: 50px;
  }

  .tqc-line-pause {
    width: 30px;
    min-width: 30px;
    padding: 0;
  }

  .tqc-line-pause span {
    display: none;
  }

  .tqc-rule-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .tqc-rule-head-actions {
    width: 100%;
    flex-wrap: wrap;
  }
}

@container (max-width: 400px) {
  .tqc-header,
  .tqc-footer {
    padding-right: 10px;
    padding-left: 10px;
  }

  .tqc-title span,
  .tqc-primary .tqc-kbd {
    display: none;
  }

  .tqc-title {
    flex: none;
  }

  .tqc-header-menu-shell {
    margin-left: auto;
  }

  .tqc-header-menu-shell > .tqc-secondary {
    width: 34px;
    padding: 0;
    font-size: 0;
  }

  .tqc-header-menu-shell > .tqc-secondary svg {
    width: 15px;
    height: 15px;
  }

  .tqc-body {
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 8px;
    padding-inline: 10px;
  }

  .tqc-command-shell .tqc-command {
    padding: 9px 34px 9px 8px;
  }

  .tqc-command-run {
    top: 37px;
    right: 5px;
  }

  .tqc-command-edit {
    right: 5px;
  }

  .tqc-card {
    padding: 9px;
  }

  .tqc-card-head {
    gap: 6px;
    flex-wrap: wrap;
  }

  .tqc-footer-row .tqc-secondary {
    padding-inline: 9px;
  }

  .tqc-automation-actions .tqc-mini {
    padding-inline: 7px;
  }
}

@media (max-width: 680px) {
  .tqc-drawer {
    width: 100vw;
  }

  .tqc-body {
    grid-template-columns: 1fr;
  }

  .tqc-list {
    max-height: 186px;
  }

  .tqc-list-pane {
    grid-template-rows: auto auto;
  }

  .tqc-field-grid,
  .tqc-field-grid.tqc-three,
  .tqc-mode-row {
    grid-template-columns: 1fr;
  }
}

body.dark .tqc-drawer,
.theme-dark .tqc-drawer,
.platform-theme-dark .tqc-drawer,
[data-bs-theme="dark"] .tqc-drawer {
  --tqc-accent: color-mix(in srgb, var(--bs-primary, #3b82f6) 72%, #ffffff 28%);
  --tqc-panel-solid: var(--bs-body-bg, #111827);
  --tqc-text: color-mix(in srgb, var(--bs-body-color, #e5e7eb) 72%, #ffffff 28%);
  --tqc-muted: color-mix(in srgb, var(--tqc-text) 72%, transparent);
  --tqc-border: var(--bs-border-color, rgba(148, 163, 184, 0.22));
}

body.dark .tqc-confirm,
.theme-dark .tqc-confirm,
.platform-theme-dark .tqc-confirm,
[data-bs-theme="dark"] .tqc-confirm {
  --tqc-confirm-bg: #1f2937;
  --tqc-confirm-text: #f8fafc;
  --tqc-confirm-muted: #cbd5e1;
  --tqc-confirm-border: rgba(226, 232, 240, 0.34);
  --tqc-confirm-input: #111827;
  --tqc-confirm-primary: #3b82f6;
  --tqc-confirm-primary-text: #ffffff;
}

@media (prefers-color-scheme: dark) {
  .tqc-drawer {
    --tqc-accent: color-mix(in srgb, var(--bs-primary, #3b82f6) 72%, #ffffff 28%);
    --tqc-panel-solid: var(--bs-body-bg, #111827);
    --tqc-text: color-mix(in srgb, var(--bs-body-color, #e5e7eb) 72%, #ffffff 28%);
    --tqc-muted: color-mix(in srgb, var(--tqc-text) 72%, transparent);
    --tqc-border: var(--bs-border-color, rgba(148, 163, 184, 0.22));
  }

  .tqc-confirm {
    --tqc-confirm-bg: #1f2937;
    --tqc-confirm-text: #f8fafc;
    --tqc-confirm-muted: #cbd5e1;
    --tqc-confirm-border: rgba(226, 232, 240, 0.34);
    --tqc-confirm-input: #111827;
    --tqc-confirm-primary: #3b82f6;
    --tqc-confirm-primary-text: #ffffff;
  }
}
`

const icons = {
    bolt: '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M781.01 104.89H422.56c-69.47 0-125.99 56.52-125.99 125.99v33.53h-57.92c-71.72 0-130.06 58.34-130.06 130.06v393.14c0 71.72 58.34 130.06 130.06 130.06h371.41c71.72 0 130.06-58.34 130.06-130.06v-57.1H781c69.47 0 125.99-56.52 125.99-125.99V230.88c0.01-69.47-56.51-125.99-125.98-125.99zM672.27 787.62c0 34.3-27.9 62.2-62.2 62.2H238.66c-34.3 0-62.2-27.9-62.2-62.2V394.47c0-34.3 27.9-62.2 62.2-62.2h57.92v272.24c0 69.47 56.52 125.99 125.99 125.99h249.7v57.12z m0-124.97h-249.7c-32.05 0-58.13-26.08-58.13-58.13V332.28h245.63c34.3 0 62.2 27.9 62.2 62.2v268.17z m166.87-58.13c0 32.05-26.07 58.13-58.13 58.13h-40.88V394.47c0-71.72-58.34-130.06-130.06-130.06H364.44v-33.53c0-32.05 26.07-58.13 58.13-58.13h358.45c32.05 0 58.13 26.08 58.13 58.13v373.64z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M8 8h11v11H8z"/><path d="M5 16H4V5h11v1"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/><path d="M5 5v14"/></svg>',
    run: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.3 5.35c-.93-.58-2.13.09-2.13 1.19v10.92c0 1.1 1.2 1.77 2.13 1.19l8.72-5.46c.88-.55.88-1.83 0-2.38L8.3 5.35z"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.67 3.42 10.3 2h3.4l.63 1.42a2 2 0 0 0 2.5 1.06l1.44-.55 2.4 2.4-.55 1.44a2 2 0 0 0 1.06 2.5L22.6 10.9v3.4l-1.42.63a2 2 0 0 0-1.06 2.5l.55 1.44-2.4 2.4-1.44-.55a2 2 0 0 0-2.5 1.06l-.63 1.42h-3.4l-.63-1.42a2 2 0 0 0-2.5-1.06l-1.44.55-2.4-2.4.55-1.44a2 2 0 0 0-1.06-2.5L1.4 14.3v-3.4l1.42-.63a2 2 0 0 0 1.06-2.5l-.55-1.44 2.4-2.4 1.44.55a2 2 0 0 0 2.5-1.06z"/><circle cx="12" cy="12" r="3"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.47 6.04.88-4.37 4.26 1.03 6.01L12 16.78l-5.4 2.84 1.03-6.01-4.37-4.26 6.04-.88L12 3z"/></svg>',
    starFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.47 6.04.88-4.37 4.26 1.03 6.01L12 16.78l-5.4 2.84 1.03-6.01-4.37-4.26 6.04-.88L12 3z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m15 4 5 5-4 4v5l-2 2-5-5-4 4-1-1 4-4-5-5 2-2h5l5-3z"/></svg>',
    pinFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m15 4 5 5-4 4v5l-2 2-5-5-4 4-1-1 4-4-5-5 2-2h5l5-3z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
}

/** @hidden */
@Injectable({ providedIn: 'root' })
export class QuickCommandsService {
    private root?: HTMLElement
    private style?: HTMLStyleElement
    private visible = false
    private running = false
    private filter = ''
    private searchReturnCategory: string | null = null
    private searchReturnCommandId: string | null = null
    private message = ''
    private pendingExecutionId: string | null = null
    private pendingDeleteId: string | null = null
    private pendingRuleDeleteId: string | null = null
    private addingCommand = false
    private newCommandName = '新命令'
    private newCommandDescription = ''
    private movingCommandId: string | null = null
    private moveTargetCategory = ''
    private moveCategoryMenuOpen = false
    private moveNavigateAfterMove = false
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
    private runState?: RunState
    private outputSubscriptions: OutputSubscription[] = []
    private recentOutput = new Map<string, OutputBuffer>()
    private outputBufferKeys: string[] = []
    private targetKeys = new WeakMap<TerminalTabLike, string>()
    private nextTargetKey = 0
    private renderedCommandId: string | null = null
    private pendingAutomationRuleScrollId: string | null = null
    private runtimeStore: QuickCommandsRuntimeStore
    private pluginConfigStore: QuickCommandsPluginConfigStore
    private state: QuickCommandsConfig
    private logger: Logger

    constructor (
        private app: AppService,
        private config: ConfigService,
        platform: PlatformService,
        log: LogService,
        private i18n: QuickCommandsI18n,
    ) {
        this.logger = log.create('quick-commands')
        this.runtimeStore = new QuickCommandsRuntimeStore(platform.getConfigPath())
        this.pluginConfigStore = new QuickCommandsPluginConfigStore(platform.getConfigPath())
        this.state = this.readConfig()

        this.config.ready$.subscribe(() => {
            this.state = this.readConfig()
            this.render()
        })
        window.addEventListener(pluginConfigChangedEvent, () => {
            this.state = this.readConfig(true)
            this.render()
        })
        document.addEventListener('keydown', event => this.handleDocumentKeyDown(event), true)
        document.addEventListener('click', event => this.handleDocumentClick(event))
        this.i18n.localeChanged$.subscribe(() => this.render())
    }

    toggle (): void {
        if (this.visible) {
            this.close()
        } else {
            this.open()
        }
    }

    open (): void {
        this.visible = true
        this.ensureRoot()
        this.render()
    }

    close (): void {
        this.visible = false
        this.pendingExecutionId = null
        this.pendingDeleteId = null
        this.pendingRuleDeleteId = null
        this.addingCommand = false
        this.newCommandName = '新命令'
        this.newCommandDescription = ''
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
    }

    private ensureRoot (): void {
        if (!this.style) {
            this.style = document.createElement('style')
            this.style.textContent = css
            document.head.appendChild(this.style)
        }

        if (!this.root) {
            this.root = document.createElement('div')
            this.root.className = 'tqc-root'
            document.body.appendChild(this.root)
        }
    }

    private render (): void {
        if (!this.root) {
            return
        }

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

        this.root.className = `tqc-root${this.visible ? ' tqc-open' : ''}`
        this.root.style.setProperty('--tqc-width', `${this.clampWidth(this.state.drawerWidth)}px`)
        this.root.innerHTML = `
          <aside class="tqc-drawer" aria-label="快速命令">
            <div class="tqc-resize-handle" data-role="resize-handle" title="调整宽度"></div>
            <header class="tqc-header">
              <div class="tqc-top-row">
                <button class="tqc-icon-button" type="button" data-action="collapse" title="收起">${icons.collapse}</button>
              </div>
              <div class="tqc-titlebar">
                <div class="tqc-title">${icons.bolt}<span>快速命令</span></div>
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
                    <button class="tqc-chip${this.state.selectedCategory === category ? ' tqc-active' : ''}" type="button" data-category="${this.escapeAttr(category)}" ${this.canDragCategory(category) ? 'draggable="true"' : ''}>
                      ${this.escape(category)}
                    </button>
                  `).join('')}
                </div>
                <div class="tqc-category-actions">
                  <button class="tqc-icon-button${this.categoryOverflowOpen ? ' tqc-active' : ''}" type="button" data-action="toggle-category-overflow" data-role="category-overflow-toggle" ${this.categoryOverflowOpen ? 'aria-label="更多分类"' : 'title="更多分类"'} aria-haspopup="menu" aria-expanded="${this.categoryOverflowOpen}">${icons.chevron}</button>
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
                        <button class="tqc-category-overflow-option${this.state.selectedCategory === category ? ' tqc-active' : ''}" type="button" role="menuitem" data-category="${this.escapeAttr(category)}" data-category-overflow-option ${this.canDragCategory(category) ? 'draggable="true"' : ''}>
                          ${this.escape(category)}
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
          </aside>
          ${this.renderOverlays(selected)}
          <div class="tqc-tooltip" data-role="tooltip" role="tooltip"></div>
        `

        this.i18n.localizeElement(this.root)
        this.layoutCategories()
        this.bindEvents()
        this.restoreScroll(detailScrollTop, listScrollTop)
        this.scrollToPendingAutomationRule()
    }

    private renderCommandListItem (command: QuickCommand, selected: boolean): string {
        const badges = [
            this.state.selectedCategory === '全部' ? `<span class="tqc-pill">${this.escape(command.category)}</span>` : '',
            command.shortcut ? `<span class="tqc-kbd">${this.escape(command.shortcut)}</span>` : '',
            command.pinned ? '<span class="tqc-pill">置顶</span>' : '',
            command.favorite ? '<span class="tqc-pill">收藏</span>' : '',
        ].filter(Boolean)
        return `
          <div class="tqc-command-shell">
            <button class="tqc-command${selected ? ' tqc-selected' : ''}" type="button" draggable="true" data-command-id="${this.escapeAttr(command.id)}">
              <div class="tqc-command-top">
                <div class="tqc-command-name" title="${this.escapeAttr(command.name)}">${this.escape(command.name)}</div>
              </div>
              ${command.description ? `<div class="tqc-command-desc">${this.escape(command.description)}</div>` : ''}
              ${badges.length ? `<div class="tqc-command-meta">${badges.join('')}</div>` : ''}
            </button>
            <button class="tqc-icon-button tqc-command-edit" type="button" data-action="edit-command" data-command-edit-id="${this.escapeAttr(command.id)}" data-tooltip="编辑名称和说明" aria-label="编辑名称和说明">${icons.edit}</button>
            <button class="tqc-icon-button tqc-command-run" type="button" data-action="execute-command" data-command-execute-id="${this.escapeAttr(command.id)}" data-tooltip="执行命令" aria-label="执行命令">${icons.run}</button>
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
              <label style="margin-top:10px">
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
              <textarea class="tqc-textarea tqc-command-editor" data-field="command" data-role="command-editor" rows="1" style="--tqc-command-height:${Math.max(lineCount, 1) * 1.48}em" spellcheck="false">${this.escape(command.command)}</textarea>
            </label>
            ${this.state.executionMode === 'line' ? this.renderLineDelayEditor(command) : ''}
          </div>
        `
    }


    private renderLineDelayEditor (command: QuickCommand): string {
        const lines = command.command.split(/\r?\n/)
        return `
          <div data-role="line-settings" style="margin-top:12px">
            <div class="tqc-card-head">
              <span class="tqc-label">逐行执行设置</span>
              <span class="tqc-card-summary">延迟 / 执行后状态</span>
            </div>
            <div class="tqc-code" aria-label="逐行设置">
              ${lines.map((line, index) => {
                  const executable = Boolean(line.trim() && !line.trim().startsWith('#'))
                  const pauseAfter = executable && command.linePauses?.[index] === true
                  return `
                <div class="tqc-code-line${pauseAfter ? ' tqc-pause-after' : ''}">
                  <div class="tqc-line-no">${index + 1}</div>
                  <div class="tqc-line-text" title="${this.escapeAttr(line || ' ')}">${this.escape(line || ' ')}</div>
                  <div class="tqc-line-tools">
                    <input class="tqc-input tqc-line-delay" type="number" min="0" step="100" data-line-delay="${index}" title="该行延迟" value="${this.escapeAttr(String(command.lineDelays?.[index] ?? command.lineDelay))}"${executable ? '' : ' disabled'}>
                    <button class="tqc-icon-button tqc-line-pause${pauseAfter ? ' tqc-active' : ''}" type="button" data-line-pause="${index}" data-tooltip="${pauseAfter ? '点击改为执行后继续' : '点击改为执行后暂停'}" aria-label="${pauseAfter ? '当前为执行后暂停，点击改为执行后继续' : '当前为执行后继续，点击改为执行后暂停'}" aria-pressed="${pauseAfter}"${executable ? '' : ' disabled'}>${pauseAfter ? `${icons.play}<span>执行后暂停</span>` : `${icons.pause}<span>执行后继续</span>`}</button>
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
                    <input class="tqc-input" data-field="shortcut" data-role="shortcut-input" placeholder="点击录入" readonly value="${this.escapeAttr(command.shortcut || '')}">
                    <button class="tqc-icon-button" type="button" data-action="clear-shortcut" title="清空快捷键">${icons.clear}</button>
                  </span>
                  <span class="tqc-field-hint" data-role="shortcut-hint">点击输入框后按组合键。在终端中按下即可执行；高风险命令仍需确认。</span>
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
                    ${command.automationRules.length ? command.automationRules.map((rule, index) => this.renderAutomationRule(rule, index)).join('') : '<div class="tqc-muted">暂无规则</div>'}
                  </div>
                </div>
              </div>
            `}
          </div>
        `
    }

    private renderAutomationRule (rule: QuickAutomationRule, index: number): string {
        const invalidWaitPattern = !isValidOutputPattern(rule.waitFor, rule.matchMode, rule.waitForLogic)
        const invalidErrorPattern = !isValidOutputPattern(rule.errorPattern, rule.matchMode, rule.errorPatternLogic)
        return `
          <div class="tqc-rule${rule.enabled ? '' : ' tqc-rule-disabled'}" data-rule-id="${this.escapeAttr(rule.id)}">
            <div class="tqc-rule-head">
              <div class="tqc-rule-title">
                <strong>规则 ${index + 1}</strong>
                <label class="tqc-checkbox">
                  <input class="tqc-checkbox-control" type="checkbox" data-rule-field="enabled" ${rule.enabled ? 'checked' : ''}>
                  <span>启用规则</span>
                </label>
              </div>
              <div class="tqc-rule-head-actions">
                <button class="tqc-mini" type="button" data-action="remove-rule" data-rule-action-id="${this.escapeAttr(rule.id)}">${icons.trash} 删除规则</button>
                <button class="tqc-mini" type="button" data-action="toggle-rule-collapsed" data-rule-action-id="${this.escapeAttr(rule.id)}">${icons.chevron} ${rule.collapsed ? '展开' : '折叠'}</button>
              </div>
            </div>
            ${rule.collapsed ? '' : `
            <div class="tqc-field-grid">
              <label>
                <span class="tqc-label">规则名</span>
                <input class="tqc-input" data-rule-field="name" value="${this.escapeAttr(rule.name)}">
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
                { value: 'stop', label: '停止该会话自动化' },
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
            { value: 'custom', label: '发送自定义命令' },
            { value: 'command', label: '执行已有命令' },
          ])}
          ${this.renderAutomationActionDetail(rule, outcome, actionValue)}
        `
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
        const selectedTitle = open ? '' : ` title="${this.escapeAttr(selectedLabel)}"`
        return `
          <div class="tqc-rule-select" data-rule-menu-key="${this.escapeAttr(menuKey)}">
            <button class="tqc-select" type="button" data-action="rule-menu-toggle" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(field)}" aria-haspopup="listbox" aria-expanded="${open}">
              <span${selectedTitle}>${this.escape(selectedLabel)}</span>
              ${icons.chevron}
            </button>
            ${open ? `
              <div class="tqc-rule-menu" role="listbox">
                <input class="tqc-input tqc-rule-command-search" data-role="automation-command-search" placeholder="搜索命令">
                ${options.map(option => `
                  <button class="tqc-rule-option${option.value === selectedId ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${option.value === selectedId}" data-action="rule-option-select" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(field)}" data-rule-value="${this.escapeAttr(option.value)}" data-command-search-text="${this.escapeAttr(option.label.toLowerCase())}" title="${this.escapeAttr(option.label)}">${this.escape(option.label)}</button>
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
            <button class="tqc-select" type="button" data-action="rule-menu-toggle" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(String(field))}" aria-haspopup="listbox" aria-expanded="${open}">
              <span${selectedTitle}>${this.escape(selectedLabel)}</span>
              ${icons.chevron}
            </button>
            ${open ? `
              <div class="tqc-rule-menu" role="listbox">
                ${options.map(option => `
                  <button class="tqc-rule-option${option.value === selectedValue ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${option.value === selectedValue}" data-action="rule-option-select" data-rule-action-id="${this.escapeAttr(rule.id)}" data-rule-menu-field="${this.escapeAttr(String(field))}" data-rule-value="${this.escapeAttr(option.value)}">${this.escape(option.label)}</button>
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
              <span>${this.escape(currentCategory || '未分类')}</span>
              ${icons.chevron}
            </button>
            ${this.categoryMenuOpen ? `
              <div class="tqc-category-menu">
                ${categories.map(category => `
                  <button class="tqc-category-option${category === currentCategory ? ' tqc-active' : ''}" type="button" data-action="category-select" data-category-value="${this.escapeAttr(category)}">
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
              <span>执行 (${targetCount || 0})</span><span class="tqc-kbd">Enter</span>
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
              <div class="tqc-confirm-desc">将“${this.escape(command?.name || '未命名命令')}”移动到指定分类。</div>
              <label>
                <span class="tqc-label">目标分类</span>
                <div class="tqc-move-select${this.moveCategoryMenuOpen ? ' tqc-open' : ''}">
                  <button class="tqc-select tqc-move-select-button" type="button" data-action="toggle-move-category-menu" aria-haspopup="listbox" aria-expanded="${this.moveCategoryMenuOpen}">
                    <span>${this.escape(this.moveTargetCategory || '请选择')}</span>${icons.chevron}
                  </button>
                  ${this.moveCategoryMenuOpen ? `<div class="tqc-move-select-menu" role="listbox">
                    ${categories.map(category => `<button class="tqc-move-select-option${category === this.moveTargetCategory ? ' tqc-active' : ''}" type="button" role="option" aria-selected="${category === this.moveTargetCategory}" data-action="select-move-category" data-move-category="${this.escapeAttr(category)}">${this.escape(category)}</button>`).join('')}
                  </div>` : ''}
                </div>
              </label>
              <label class="tqc-checkbox tqc-move-follow">
                <input class="tqc-checkbox-control" type="checkbox" data-role="move-follow-category" ${this.moveNavigateAfterMove ? 'checked' : ''}>
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
              <div class="tqc-confirm-desc">请确认目标会话和执行方式。所有会话、多会话、生产会话和高风险命令不会静默执行。</div>
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
        return `
          <div class="tqc-confirm-backdrop" data-action="import-cancel">
            <div class="tqc-confirm" role="dialog" aria-modal="true" aria-label="导入预览" data-role="confirm-dialog">
              <div class="tqc-confirm-title">导入预览</div>
              <div class="tqc-confirm-desc">命令库版本 v${preview.sourceVersion}。合并会跳过全部冲突；替换会忽略与现有库的冲突，但跳过文件内部冲突。</div>
              <div class="tqc-summary">
                <div class="tqc-summary-row"><span>新增</span><strong>${preview.added.length}</strong></div>
                <div class="tqc-summary-row"><span>覆盖</span><strong>${preview.overwritten.length}</strong></div>
                <div class="tqc-summary-row"><span>现有库冲突</span><strong>${existingConflicts}</strong></div>
                <div class="tqc-summary-row"><span>文件内部冲突</span><strong>${fileConflicts}</strong></div>
              </div>
              ${preview.conflicts.length ? `<div class="tqc-card tqc-risk" style="margin-top:10px"><span class="tqc-label">冲突</span>${preview.conflicts.slice(0, 5).map(conflict => `<div class="tqc-log">[${conflict.scope === 'file' ? '文件' : '现有库'}] ${this.escape(conflict.command.name)}：${this.escape(conflict.reason)}</div>`).join('')}</div>` : ''}
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
                <button class="tqc-primary" type="button" data-action="rule-delete-confirm">删除</button>
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
              <div class="tqc-confirm-desc">确认删除“${this.escape(command?.name || '未命名命令')}”？</div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="delete-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="delete-confirm">删除</button>
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
              <div class="tqc-confirm-title">删除分类：${this.escape(category)}</div>
              <div class="tqc-confirm-desc">
                ${count
                    ? `该分类中有 ${count} 条命令。确认后将同时删除这些命令，此操作无法撤销。`
                    : '该分类中没有命令，确认删除该分类？'}
              </div>
              <div class="tqc-confirm-actions">
                <button class="tqc-secondary" type="button" data-action="category-delete-cancel">取消</button>
                <button class="tqc-primary" type="button" data-action="category-delete-confirm">${count ? '删除分类和命令' : '删除分类'}</button>
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

        this.root.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
            element.addEventListener('click', event => {
                event.preventDefault()
                event.stopPropagation()
                const action = element.dataset.action || ''
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
                void this.handleAction(action, element)
            })
        })

        this.root.querySelectorAll<HTMLElement>('[data-role="confirm-dialog"]').forEach(element => {
            element.addEventListener('click', event => event.stopPropagation())
        })

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

        this.root.querySelectorAll<HTMLElement>('[data-command-id]').forEach(element => {
            element.addEventListener('click', () => {
                const id = element.dataset.commandId
                if (id) {
                    this.commandMenuOpen = false
                    this.updateConfig({ selectedCommandId: id })
                }
            })
            element.addEventListener('dragstart', event => {
                this.draggedCommandId = element.dataset.commandId || null
                element.classList.add('tqc-dragging')
                event.dataTransfer?.setData('text/plain', this.draggedCommandId || '')
            })
            element.addEventListener('dragover', event => event.preventDefault())
            element.addEventListener('drop', event => {
                event.preventDefault()
                const targetId = element.dataset.commandId
                if (targetId && this.draggedCommandId) {
                    this.reorderCommand(this.draggedCommandId, targetId)
                }
            })
            element.addEventListener('dragend', () => {
                this.draggedCommandId = null
                element.classList.remove('tqc-dragging')
            })
        })

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
            this.moveNavigateAfterMove = moveFollowCategory.checked
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
            window.requestAnimationFrame(() => categoryInput.focus())
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
            element.addEventListener('keydown', event => {
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Escape') {
                    element.value = ''
                    this.updateSelectedField(element)
                    return
                }
                const shortcut = shortcutFromKeyboardEvent(event)
                if (!shortcut) {
                    const modifierOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)
                    this.showShortcutHint(element, modifierOnly
                        ? '请继续按下字母、数字或功能键。'
                        : '快捷键需包含 Ctrl、Alt 或 Meta；也可以直接使用功能键。')
                    return
                }
                element.value = shortcut
                this.updateSelectedField(element)
            })
        })

        this.bindLineSettings(this.root)

        this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-rule-field]').forEach(element => {
            element.addEventListener('change', () => this.updateAutomationRule(element))
        })

        const commandEditor = this.root.querySelector<HTMLTextAreaElement>('[data-role="command-editor"]')
        commandEditor?.addEventListener('input', () => {
            const lineCount = Math.max(commandEditor.value.split(/\r?\n/).length, 1)
            commandEditor.style.setProperty('--tqc-command-height', `${lineCount * 1.48}em`)
            const lineCountElement = this.root?.querySelector<HTMLElement>('[data-role="command-line-count"]')
            if (lineCountElement) {
                lineCountElement.textContent = `${lineCount} 行`
            }
            this.updateSelectedCommand({ command: normalizeCommandText(commandEditor.value) }, false, false, false)
            this.refreshLineSettings(commandEditor.value)
        })
        commandEditor?.addEventListener('change', () => this.updateSelectedField(commandEditor, false))

        const autoEnter = this.root.querySelector<HTMLInputElement>('[data-role="auto-enter"]')
        autoEnter?.addEventListener('change', () => {
            this.updateSelectedCommand({ autoEnter: autoEnter.checked })
        })

        this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]').forEach(element => {
            if (element === commandEditor) {
                return
            }
            element.addEventListener('change', () => this.updateSelectedField(element))
        })

        this.bindTooltips()
        this.bindResizeHandle()
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
            element.removeAttribute('title')
            if (!element.hasAttribute('aria-label')) {
                element.setAttribute('aria-label', text)
            }
            const show = () => this.showTooltip(tooltip, element, text)
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
        const scroll = this.root?.querySelector<HTMLElement>('.tqc-category-scroll')
        const toggle = this.root?.querySelector<HTMLElement>('[data-role="category-overflow-toggle"]')
        if (!scroll || !toggle) {
            return
        }

        const chips = Array.from(scroll.querySelectorAll<HTMLElement>('[data-category]'))
        const widths = new Map(chips.map(chip => [chip, chip.getBoundingClientRect().width]))
        const style = window.getComputedStyle(scroll)
        const available = Math.max(0, scroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0))
        const gap = parseFloat(style.columnGap || style.gap) || 8
        const chipByCategory = new Map(chips.map(chip => [chip.dataset.category || '', chip]))
        const priority = Array.from(new Set([
            '全部',
            this.state.selectedCategory,
            '常用',
            '收藏',
            ...chips.map(chip => chip.dataset.category || ''),
        ].filter(Boolean)))
        const visible = new Set<string>()
        let used = 0

        priority.forEach(category => {
            const chip = chipByCategory.get(category)
            if (!chip) {
                return
            }
            const width = widths.get(chip) || 0
            const nextUsed = used + (visible.size ? gap : 0) + width
            if (nextUsed <= available) {
                visible.add(category)
                used = nextUsed
            }
        })

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
                this.updateConfig({ drawerWidth: nextWidth }, false)
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

    private async handleAction (action: string, element?: HTMLElement): Promise<void> {
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
                this.moveNavigateAfterMove = false
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
                    await this.executeSelectedCommand()
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
                await this.executeSelectedCommand()
                return
            case 'execute-confirm':
                await this.executeSelectedCommand(true)
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
        this.app.openNewTabRaw({
            type: SettingsTabComponent,
            inputs: { activeTab: 'windy-quick-commands' },
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
                this.showMessage(conflict.kind === 'tabby'
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
        if (!previousFilter && nextFilter) {
            this.searchReturnCategory = this.state.selectedCategory
            this.searchReturnCommandId = this.state.selectedCommandId
        }
        this.filter = search.value
        if (previousFilter && !nextFilter) {
            this.restoreSearchContext()
        } else if (nextFilter && this.state.selectedCategory !== '全部') {
            this.updateConfig({ selectedCategory: '全部' }, false)
        } else {
            this.render()
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
            element.addEventListener('wheel', event => {
                if (document.activeElement !== element) {
                    return
                }
                event.preventDefault()
                const step = event.shiftKey ? 500 : 100
                const direction = event.deltaY < 0 ? 1 : -1
                element.value = String(Math.max(0, (Number(element.value) || 0) + direction * step))
                this.updateLineDelay(element)
            }, { passive: false })
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
            field === 'onMatchAction' || field === 'onErrorAction' || field === 'timeoutAction'
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
        const automationRules = selected.automationRules.map(rule => (
            rule.id === ruleId ? { ...rule, [field]: value } : rule
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
        this.updateSelectedCommand({ [field]: !selected[field] } as Partial<QuickCommand>)
    }

    private openAddCommand (): void {
        this.addingCommand = true
        this.newCommandName = '新命令'
        this.newCommandDescription = ''
        this.render()
    }

    private closeAddCommand (): void {
        this.addingCommand = false
        this.newCommandName = '新命令'
        this.newCommandDescription = ''
        this.render()
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
        this.newCommandName = '新命令'
        this.newCommandDescription = ''
        this.clearSearchState()
        this.updateConfig({
            commands: [...this.state.commands, command],
            selectedCommandId: command.id,
            selectedCategory: category,
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
    }

    private openMoveCommand (): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        this.movingCommandId = selected.id
        this.moveTargetCategory = ''
        this.moveCategoryMenuOpen = false
        this.moveNavigateAfterMove = false
        this.render()
    }

    private confirmMoveCommand (): void {
        const commandId = this.movingCommandId
        const category = this.moveTargetCategory
        if (!commandId || !category || this.isSystemCategory(category)) {
            return
        }
        const commands = this.state.commands.map(command => (
            command.id === commandId ? { ...command, category } : command
        ))
        const navigateAfterMove = this.moveNavigateAfterMove
        const currentCategory = this.state.selectedCategory
        this.movingCommandId = null
        this.moveTargetCategory = ''
        this.moveCategoryMenuOpen = false
        this.moveNavigateAfterMove = false
        if (navigateAfterMove) {
            this.clearSearchState()
        }
        this.updateConfig({
            commands,
            selectedCommandId: commandId,
            selectedCategory: navigateAfterMove ? category : currentCategory,
        })
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
    }

    private deleteSelectedCommand (): void {
        const id = this.pendingDeleteId || this.getSelectedCommand()?.id
        if (!id) {
            return
        }
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
        const commands = this.state.commands.map(command => (
            command.id === commandId
                ? { ...command, name, description: this.editCommandDescription.trim() }
                : command
        ))
        this.editingCommandId = null
        this.editCommandName = ''
        this.editCommandDescription = ''
        this.updateConfig({ commands, selectedCommandId: commandId })
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

    private addAutomationRule (): void {
        const selected = this.getSelectedCommand()
        if (!selected) {
            return
        }
        const rule: QuickAutomationRule = {
            id: this.createId(),
            name: '输出匹配规则',
            enabled: true,
            collapsed: false,
            matchMode: 'literal',
            waitFor: '',
            waitForLogic: 'single',
            timeoutMs: 10000,
            errorPattern: '',
            errorPatternLogic: 'single',
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
        this.updateSelectedCommand({ automationRules: [...selected.automationRules, rule] })
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
            format: 'tabby-windy-quick-commands',
            version: 3,
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
    }

    private renderExportFileName (): string {
        const date = new Date().toISOString().slice(0, 10)
        const rendered = (this.state.exportFileName || 'tabby-windy-quick-commands-{date}.json')
            .replace(/\{date\}/g, date)
        const name = rendered.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || `tabby-windy-quick-commands-${date}.json`
        return /\.json$/i.test(name) ? name : `${name}.json`
    }

    private async importCommandsFromFile (file: File): Promise<void> {
        try {
            if (file.size > 5 * 1024 * 1024) {
                throw new Error('导入文件不能超过 5MB。')
            }
            await this.importCommandsText(await file.text())
        } catch (error) {
            this.logger.warn('Command import failed', error)
            const reason = error instanceof Error ? error.message : '请确认 JSON 文件格式。'
            this.showMessage(`导入失败：${reason}`)
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
        this.visible = true
        this.ensureRoot()
        this.render()
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
        const referenceMessage = sanitized.clearedReferences
            ? `，并清理 ${sanitized.clearedReferences} 个失效触发器引用`
            : ''
        this.showMessage(`${mode === 'merge' ? '命令库已合并导入' : '命令库已替换导入'}${referenceMessage}。`)
    }

    private async executeSelectedCommand (confirmed = false): Promise<void> {
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

        const summary = this.buildExecutionSummary(selected, targets)
        if (!confirmed && summary.requiresConfirm) {
            this.pendingExecutionId = selected.id
            this.confirmInput = ''
            this.visible = true
            this.ensureRoot()
            this.render()
            return
        }
        if (confirmed && summary.requiresTypedConfirm && this.confirmInput !== summary.requiredText) {
            this.showMessage(`请输入 ${summary.requiredText} 后再确认。`)
            return
        }

        this.running = true
        this.pendingExecutionId = null
        this.confirmInput = ''
        this.message = ''
        this.runState = {
            commandId: selected.id,
            startedAt: new Date().toISOString(),
            currentStep: 0,
            totalSteps: this.state.executionMode === 'line' ? Math.max(parseScriptSteps(selected).length, 1) : 1,
            sourceLine: 0,
            paused: false,
            stopped: false,
            waitingManual: false,
        }
        this.updateUsage(selected.id)
        this.addLog('info', '开始执行', selected.id, undefined, {
            mode: summary.modeLabel,
            targetNames: summary.targetNames,
        })
        this.attachOutputBuffers(targets)
        this.render()

        try {
            if (this.state.executionMode === 'line') {
                await this.executeLineByLine(selected, targets)
            } else {
                this.executeBlock(selected, targets)
            }
            await this.runAutomationRules(selected, targets)
            this.addLog('info', '执行完成', selected.id, undefined, {
                mode: summary.modeLabel,
                targetNames: summary.targetNames,
                durationMs: this.getRunDuration(),
            })
            this.showMessage(`已发送到 ${targets.length} 个会话。`)
        } catch (error) {
            this.logger.error('Failed to execute command', error)
            this.addLog('error', '执行失败，请查看 Tabby 日志。', selected.id, undefined, {
                mode: summary.modeLabel,
                targetNames: summary.targetNames,
                durationMs: this.getRunDuration(),
            })
            this.showMessage('执行失败，请查看 Tabby 日志。')
        } finally {
            this.detachOutputBuffers()
            this.running = false
            this.runState = undefined
            this.pendingFailureMessage = ''
            this.render()
        }
    }

    private executeBlock (command: QuickCommand, targets: TerminalTabLike[]): void {
        const payload = this.normalizeCommand(command.command, command.autoEnter)
        targets.forEach(target => target.sendInput(payload))
    }

    private async executeLineByLine (command: QuickCommand, targets: TerminalTabLike[]): Promise<void> {
        const steps = parseScriptSteps(command)
        if (this.runState) {
            this.runState.totalSteps = Math.max(steps.length, 1)
        }

        for (let index = 0; index < steps.length; index++) {
            const step = steps[index]
            if (this.runState?.stopped) {
                this.addLog('warn', '执行已停止。', command.id)
                return
            }
            await this.waitWhilePaused()
            if (this.runState) {
                this.runState.currentStep = index + 1
                this.runState.sourceLine = step.sourceLine
            }
            this.render()
            await this.executeStep(command, targets, step)
        }
    }

    private async executeStep (command: QuickCommand, targets: TerminalTabLike[], step: ScriptStep): Promise<void> {
        if (step.type !== 'command') {
            return
        }

        try {
            const payload = this.normalizeCommand(step.text, command.autoEnter)
            targets.forEach(target => target.sendInput(payload))
            this.addLog('info', `已发送第 ${step.sourceLine} 行。`, command.id, step.sourceLine)
            await this.delayWithControl(step.delay)
            if (step.pauseAfter && !this.runState?.stopped) {
                this.pauseExecution()
                this.addLog('info', `第 ${step.sourceLine} 行执行后暂停，等待继续。`, command.id, step.sourceLine)
                await this.waitWhilePaused()
            }
        } catch (error) {
            await this.handleStepFailure(command, step, error)
        }
    }

    private async handleStepFailure (command: QuickCommand, step: ScriptStep, error: unknown): Promise<void> {
        this.logger.warn('Line execution failed', error)
        this.addLog('error', `第 ${step.sourceLine} 行发送失败。`, command.id, step.sourceLine)
        if (this.state.failureStrategy === 'continue') {
            return
        }
        if (this.state.failureStrategy === 'stop') {
            throw error
        }

        this.pendingFailureMessage = `第 ${step.sourceLine} 行发送失败，需要手动确认后继续。`
        if (this.runState) {
            this.runState.waitingManual = true
            this.runState.paused = true
        }
        this.render()
        await new Promise<void>(resolve => {
            if (this.runState) {
                this.runState.manualResolver = resolve
            } else {
                resolve()
            }
        })
        if (this.runState?.stopped) {
            throw error
        }
    }

    private pauseExecution (): void {
        if (!this.runState) {
            return
        }
        this.runState.paused = true
        this.render()
    }

    private resumeExecution (): void {
        if (!this.runState) {
            return
        }
        this.runState.paused = false
        this.runState.waitingManual = false
        this.pendingFailureMessage = ''
        this.render()
    }

    private stopExecution (): void {
        if (!this.runState) {
            return
        }
        this.runState.stopped = true
        this.runState.paused = false
        this.runState.waitingManual = false
        if (this.runState.manualResolver) {
            this.runState.manualResolver()
        }
        this.pendingFailureMessage = ''
        this.render()
    }

    private resolveManualFailure (stop: boolean): void {
        if (!this.runState) {
            return
        }
        this.runState.stopped = stop
        this.runState.paused = false
        this.runState.waitingManual = false
        this.pendingFailureMessage = ''
        if (this.runState.manualResolver) {
            this.runState.manualResolver()
            this.runState.manualResolver = undefined
        }
        this.render()
    }

    private async waitWhilePaused (): Promise<void> {
        while (this.runState?.paused && !this.runState.stopped) {
            await this.delay(120)
        }
    }

    private async delayWithControl (ms: number): Promise<void> {
        const started = Date.now()
        while (Date.now() - started < ms) {
            if (this.runState?.stopped) {
                return
            }
            await this.waitWhilePaused()
            await this.delay(Math.min(120, ms - (Date.now() - started)))
        }
    }

    private async runAutomationRules (command: QuickCommand, targets: TerminalTabLike[]): Promise<void> {
        const rules = command.automationRules.filter(rule => rule.enabled && (rule.waitFor || rule.errorPattern))
        if (!rules.length || this.runState?.stopped) {
            return
        }
        const availableTargets = targets.filter(target => {
            const available = this.recentOutput.has(this.getTargetKey(target))
            if (!available) {
                this.addLog('warn', '当前会话不支持输出监听，已跳过输出触发器。', command.id, undefined, {
                    targetNames: [this.getTabTitle(target)],
                })
            }
            return available
        })
        await Promise.all(availableTargets.map(target => this.runAutomationRulesForTarget(command, rules, target)))
    }

    private async runAutomationRulesForTarget (
        command: QuickCommand,
        rules: QuickAutomationRule[],
        target: TerminalTabLike,
    ): Promise<void> {
        const key = this.getTargetKey(target)
        let cursor = this.recentOutput.get(key)?.startOffset || 0

        for (const rule of rules) {
            if (this.runState?.stopped) {
                return
            }
            if (!isValidOutputPattern(rule.waitFor, rule.matchMode, rule.waitForLogic) ||
                !isValidOutputPattern(rule.errorPattern, rule.matchMode, rule.errorPatternLogic)) {
                this.addLog('warn', `规则正则表达式无效，已跳过：${rule.name}`, command.id, undefined, {
                    targetNames: [this.getTabTitle(target)],
                })
                continue
            }

            const result = await this.waitForRule(rule, target, cursor, command.id)
            cursor = this.recentOutput.get(key)?.endOffset || cursor
            if (result.outcome === 'stopped') {
                return
            }

            const shouldStop = this.executeAutomationRuleAction(rule, result.outcome, target, command.id)
            if (shouldStop) {
                this.addLog('warn', `会话自动化已在超时后停止：${rule.name}`, command.id, undefined, {
                    targetNames: [this.getTabTitle(target)],
                })
                return
            }
        }
    }

    private async waitForRule (
        rule: QuickAutomationRule,
        target: TerminalTabLike,
        cursor: number,
        commandId: string,
    ): Promise<AutomationRuleResult> {
        const timeout = Math.max(100, Number(rule.timeoutMs) || 10000)
        const started = Date.now()
        const targetName = this.getTabTitle(target)
        this.addLog('info', `等待输出触发器：${rule.name}`, commandId, undefined, {
            targetNames: [targetName],
        })
        while (Date.now() - started < timeout) {
            if (this.runState?.stopped) {
                return { outcome: 'stopped', matchedText: '' }
            }
            const output = this.getOutputSince(target, cursor)
            const errorMatch = findOutputMatch(output, rule.errorPattern, rule.matchMode, rule.errorPatternLogic)
            if (errorMatch.matched) {
                this.addRuleMatchLog('warn', '命中错误输出', rule, errorMatch.text, commandId, targetName)
                return { outcome: 'error', matchedText: errorMatch.text }
            }
            const successMatch = findOutputMatch(output, rule.waitFor, rule.matchMode, rule.waitForLogic)
            if (successMatch.matched) {
                this.addRuleMatchLog('info', '命中成功输出', rule, successMatch.text, commandId, targetName)
                return { outcome: 'match', matchedText: successMatch.text }
            }
            await this.delay(150)
        }
        this.addLog('warn', `输出触发器超时：${rule.name}（${timeout}ms）`, commandId, undefined, {
            targetNames: [targetName],
        })
        return { outcome: 'timeout', matchedText: '' }
    }

    private addRuleMatchLog (
        level: AutomationLogEntry['level'],
        result: string,
        rule: QuickAutomationRule,
        matchedText: string,
        commandId: string,
        targetName: string,
    ): void {
        const snippet = matchedText.replace(/\s+/g, ' ').trim().slice(0, 120)
        const suffix = snippet ? `：${snippet}` : ''
        this.addLog(level, `${result}：${rule.name}${suffix}`, commandId, undefined, {
            targetNames: [targetName],
        })
    }

    private executeAutomationRuleAction (
        rule: QuickAutomationRule,
        outcome: AutomationRuleResult['outcome'],
        target: TerminalTabLike,
        parentCommandId: string,
    ): boolean {
        if (outcome === 'stopped') {
            return true
        }
        if (outcome === 'timeout' && rule.timeoutAction === 'stop') {
            return true
        }
        const action = outcome === 'match'
            ? rule.onMatchAction
            : outcome === 'error'
                ? rule.onErrorAction
                : rule.timeoutAction
        if (action === 'command') {
            const commandId = outcome === 'match'
                ? rule.onMatchCommandId
                : outcome === 'error'
                    ? rule.onErrorCommandId
                    : rule.onTimeoutCommandId
            this.executeAutomationCommand(commandId, [target], parentCommandId)
        } else if (action === 'custom') {
            const command = outcome === 'match'
                ? rule.onMatchCommand
                : outcome === 'error'
                    ? rule.onErrorCommand
                    : rule.onTimeoutCommand
            const autoEnter = outcome === 'match'
                ? rule.onMatchAutoEnter
                : outcome === 'error'
                    ? rule.onErrorAutoEnter
                    : rule.onTimeoutAutoEnter
            this.executeAutomationCustomCommand(command, autoEnter, target, parentCommandId, rule.name)
        }
        return false
    }

    private executeAutomationCommand (commandId: string, targets: TerminalTabLike[], parentCommandId: string): void {
        if (!commandId) {
            return
        }
        const command = this.state.commands.find(item => item.id === commandId)
        if (!command) {
            this.addLog('warn', `自动化目标命令不存在：${commandId}`, parentCommandId)
            return
        }
        const danger = this.getDanger(command.command)
        if (danger.dangerous) {
            this.addLog('warn', `自动化跳过高风险命令：${command.name}`, parentCommandId)
            return
        }
        targets.forEach(target => target.sendInput(this.normalizeCommand(command.command, command.autoEnter)))
        this.addLog('info', `自动化已执行：${command.name}`, parentCommandId, undefined, {
            targetNames: targets.map(target => this.getTabTitle(target)),
        })
    }

    private executeAutomationCustomCommand (
        command: string,
        autoEnter: boolean,
        target: TerminalTabLike,
        parentCommandId: string,
        ruleName: string,
    ): void {
        const normalized = normalizeCommandText(command)
        if (!normalized.trim()) {
            return
        }
        const danger = this.getDanger(normalized)
        if (danger.dangerous) {
            this.addLog('warn', `自动化跳过高风险自定义命令：${ruleName}`, parentCommandId, undefined, {
                targetNames: [this.getTabTitle(target)],
            })
            return
        }
        target.sendInput(this.normalizeCommand(normalized, autoEnter))
        this.addLog('info', `自动化已发送自定义命令：${ruleName}`, parentCommandId, undefined, {
            targetNames: [this.getTabTitle(target)],
        })
    }

    private attachOutputBuffers (targets: TerminalTabLike[]): void {
        this.detachOutputBuffers()
        targets.forEach(target => {
            const stream = target.output$ || target.session?.output$
            if (!stream) {
                return
            }
            const key = this.getTargetKey(target)
            this.recentOutput.set(key, { text: '', startOffset: 0, endOffset: 0 })
            this.outputBufferKeys.push(key)
            this.outputSubscriptions.push(stream.subscribe(data => {
                const current = this.recentOutput.get(key) || { text: '', startOffset: 0, endOffset: 0 }
                const endOffset = current.endOffset + data.length
                const text = `${current.text}${data}`.slice(-this.state.recentOutputLimit)
                this.recentOutput.set(key, {
                    text,
                    startOffset: endOffset - text.length,
                    endOffset,
                })
            }))
        })
    }

    private getOutputSince (target: TerminalTabLike, cursor: number): string {
        const buffer = this.recentOutput.get(this.getTargetKey(target))
        if (!buffer) {
            return ''
        }
        return buffer.text.slice(Math.max(0, cursor - buffer.startOffset))
    }

    private detachOutputBuffers (): void {
        this.outputSubscriptions.forEach(subscription => subscription.unsubscribe())
        this.outputSubscriptions = []
        this.outputBufferKeys.forEach(key => this.recentOutput.delete(key))
        this.outputBufferKeys = []
    }

    private handleDocumentKeyDown (event: KeyboardEvent): void {
        if (event.repeat || event.isComposing) {
            return
        }

        if (this.visible && event.key === 'Enter' && !this.isEditableElement(event.target) && !this.running) {
            const selected = this.getSelectedCommand()
            if (selected) {
                event.preventDefault()
                event.stopPropagation()
                void this.executeSelectedCommand()
            }
            return
        }

        const shortcut = shortcutFromKeyboardEvent(event)
        if (!shortcut) {
            return
        }
        if (this.getDrawerShortcuts().includes(shortcut)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.toggle()
            return
        }
        if (this.isEditableElement(event.target) && !this.isTerminalInput(event.target)) {
            return
        }

        const command = this.state.commands.find(item => normalizeShortcut(item.shortcut) === shortcut)
        if (!command || this.findShortcutConflict(shortcut, command.id)?.kind === 'tabby') {
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

    private getDrawerShortcuts (): string[] {
        const configured = this.config.store?.hotkeys?.['windy-command-center-toggle']
        const values = typeof configured === 'string' ? [configured] : Array.isArray(configured) ? configured : []
        return values
            .map(value => Array.isArray(value) && value.length === 1 ? value[0] : value)
            .filter((value): value is string => typeof value === 'string')
            .map(value => normalizeShortcut(value))
            .filter(Boolean)
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

    private getFilteredCommands (): QuickCommand[] {
        const tokens = this.filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const filtered = this.state.commands.filter(command => {
            const categoryMatches = this.state.selectedCategory === '全部' ||
                (this.state.selectedCategory === '收藏'
                    ? command.favorite
                    : this.state.selectedCategory === '常用'
                        ? command.usageCount > 0
                        : command.category === this.state.selectedCategory)
            if (!categoryMatches) {
                return false
            }
            if (!tokens.length) {
                return true
            }
            return tokens.every(token => this.commandMatchesToken(command, token))
        })
        if (this.state.selectedCategory === '常用') {
            return filtered.sort((a, b) => (
                b.usageCount - a.usageCount ||
                this.getTimeValue(b.lastUsedAt) - this.getTimeValue(a.lastUsedAt)
            ))
        }
        return filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned))
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

    private canDragCategory (category: string): boolean {
        return !!category
    }

    private getHint (command: QuickCommand | null, targetCount: number, danger: boolean): string {
        if (!command) {
            return '先选择或新建一条命令。'
        }
        if (danger) {
            return '命令包含删除、重启、清理或数据库高风险关键字，执行前会二次确认。'
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
        const requiresTypedConfirm = danger.requiresTypedConfirm
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
                danger.dangerous ||
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

    private normalizeCommand (command: string, autoEnter: boolean): string {
        return buildTerminalPayload(command, autoEnter)
    }

    private findShortcutConflict (shortcut: string, currentCommandId: string) {
        return findShortcutConflict(
            shortcut,
            this.state.commands.map(command => ({
                id: command.id,
                name: command.name,
                shortcut: command.shortcut,
            })),
            currentCommandId,
            flattenHotkeysConfig(this.config.store?.hotkeys),
        )
    }

    private updateUsage (commandId: string): void {
        const commands = this.state.commands.map(command => (
            command.id === commandId
                ? { ...command, usageCount: command.usageCount + 1, lastUsedAt: new Date().toISOString() }
                : command
        ))
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
        context: Pick<AutomationLogEntry, 'mode' | 'targetNames' | 'durationMs'> = {},
    ): void {
        const command = commandId ? this.state.commands.find(item => item.id === commandId) : undefined
        const log: AutomationLogEntry = {
            id: this.createId(),
            time: new Date().toISOString(),
            level,
            message,
            commandId,
            commandName: command?.name,
            commandText: command?.command,
            line,
            ...context,
        }
        const logs = [...this.state.automationLogs, log].slice(-this.state.logLimit)
        this.runtimeStore.setLogs(logs)
        this.updateConfig({ automationLogs: logs }, false)
    }

    private getRunDuration (): number | undefined {
        if (!this.runState?.startedAt) {
            return undefined
        }
        const startedAt = new Date(this.runState.startedAt).getTime()
        return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined
    }

    private readConfig (reload = false): QuickCommandsConfig {
        const root = this.pluginConfigStore.load(defaultQuickCommandsConfig, reload) as any
        const storedCommands = Array.isArray(root.commands)
            ? root.commands.map((command: Partial<QuickCommand>) => this.normalizeStoredCommand(command))
            : defaultCommands.map(command => this.normalizeStoredCommand(command))
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
            requireConfirmBeforeExecute: root.requireConfirmBeforeExecute ?? false,
            confirmBroadcast: root.confirmBroadcast ?? true,
            exportFileName: root.exportFileName || 'tabby-windy-quick-commands-{date}.json',
            basicInfoCollapsed: root.basicInfoCollapsed ?? true,
            moreSettingsCollapsed: root.moreSettingsCollapsed ?? true,
            previewCollapsed: root.previewCollapsed ?? false,
            recentOutputLimit: Math.max(1000, Number(root.recentOutputLimit) || 8000),
            logLimit: Math.max(20, Number(root.logLimit) || 200),
            automationLogs: this.runtimeStore.getLogs(),
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
        if (patch.commands) {
            this.runtimeStore.setStats(this.buildUsageStats(next.commands))
        }
        const root = this.pluginConfigStore.load(defaultQuickCommandsConfig)
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
        root.requireConfirmBeforeExecute = next.requireConfirmBeforeExecute
        root.confirmBroadcast = next.confirmBroadcast
        root.exportFileName = next.exportFileName
        root.basicInfoCollapsed = next.basicInfoCollapsed
        root.moreSettingsCollapsed = next.moreSettingsCollapsed
        root.previewCollapsed = next.previewCollapsed
        delete root.safetyWhitelist
        delete root.safetyBlacklist
        delete root.productionNamePatterns
        delete root.highRiskConfirmText
        root.recentOutputLimit = next.recentOutputLimit
        root.logLimit = next.logLimit
        this.pluginConfigStore.set(root, save)
        this.state = this.readConfig()
        if (shouldRender) {
            this.render()
        }
    }

    private persistPluginConfig (): void {
        this.pluginConfigStore.set(this.pluginConfigStore.load(defaultQuickCommandsConfig))
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

    private showShortcutHint (input: HTMLElement, message: string): void {
        const hint = input.closest('label')?.querySelector<HTMLElement>('[data-role="shortcut-hint"]')
        if (!hint) {
            return
        }
        const defaultText = '点击输入框后按组合键。在终端中按下即可执行；高风险命令仍需确认。'
        hint.textContent = message
        hint.classList.add('tqc-field-hint-error')
        window.setTimeout(() => {
            if (hint.textContent === message) {
                hint.textContent = defaultText
                hint.classList.remove('tqc-field-hint-error')
            }
        }, 2600)
    }

    private createId (): string {
        return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    private delay (ms: number): Promise<void> {
        return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)))
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
