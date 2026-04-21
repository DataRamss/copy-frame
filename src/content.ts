/// <reference types="chrome" />
export {};

import {
  DEFAULT_TOGGLE_SHORTCUT,
  TOGGLE_SHORTCUT_STORAGE_KEY,
  matchesShortcut,
  parseShortcut,
  shortcutFromKeyboardEvent,
  type ShortcutConfig
} from "./shortcut";

type InspectState = "idle" | "inspecting" | "locked";

type HintEntry = {
  label: string;
  value: string;
};

type SelectionDescriptor = {
  friendlyName: string;
  elementHints: string[];
  ancestorHints: string[];
  selector: string;
  textSnippet: string;
  pageContext: string;
  output: string;
};

type SelectionSource = "click" | "ancestor" | "descendant" | "sibling" | "undo";

declare global {
  interface Window {
    __copyFrameInspector?: CopyFrameInspector;
  }
}

const TOGGLE_INSPECT_MODE = "toggleInspectMode";
const ROOT_ID = "copy-frame-root";
const LOGO_URL = chrome.runtime.getURL("logo.png");
const SETTINGS_SHORTCUT = parseShortcut("Alt+K")!;
const MAX_TEXT_LENGTH = 80;
const MAX_HINTS = 4;
const TOAST_TOTAL_MS = 2400;
const TOAST_ENTER_MS = 360;
const TOAST_LEAVE_MS = 160;
const TOAST_TEXT_DELAY_MS = 145;
const TOAST_CHAR_STAGGER_MS = 16;
const TOAST_CHAR_STAGGER_CAP_MS = 180;
const GENERIC_CLASS_NAMES = new Set([
  "active",
  "body",
  "card",
  "col",
  "container",
  "content",
  "dialog",
  "icon",
  "input",
  "item",
  "label",
  "main",
  "page",
  "panel",
  "row",
  "section",
  "selected",
  "title",
  "value",
  "wrapper"
]);

class CopyFrameInspector {
  private state: InspectState = "idle";
  private readonly host: HTMLDivElement;
  private readonly shadowRootRef: ShadowRoot;
  private readonly borderEl: HTMLDivElement;
  private readonly hoverBorderEl: HTMLDivElement;
  private readonly labelEl: HTMLDivElement;
  private readonly copyButtonEl: HTMLButtonElement;
  private readonly toastEl: HTMLDivElement;
  private readonly toastTextEl: HTMLDivElement;
  private readonly settingsPanelEl: HTMLDivElement;
  private readonly settingsInputEl: HTMLInputElement;
  private readonly settingsStatusEl: HTMLDivElement;
  private readonly settingsCloseButtonEl: HTMLButtonElement;
  private readonly settingsFormEl: HTMLFormElement;
  private currentElement: Element | null = null;
  private hoverElement: Element | null = null;
  private currentDescriptor: SelectionDescriptor | null = null;
  private toastTimer: number | null = null;
  private toastCleanupTimer: number | null = null;
  private refreshFrame: number | null = null;
  private pointerClientX: number | null = null;
  private pointerClientY: number | null = null;
  private readonly drillStack: Element[] = [];
  private readonly selectionHistory: Element[] = [];
  private historyIndex = -1;
  private toggleShortcut: ShortcutConfig = parseShortcut(DEFAULT_TOGGLE_SHORTCUT)!;
  private settingsVisible = false;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = ROOT_ID;
    this.host.style.display = "none";
    document.addEventListener("keydown", this.handleGlobalKeydown, true);
    chrome.storage.onChanged.addListener(this.handleStorageChange);
    void this.loadToggleShortcut();

    this.shadowRootRef = this.host.attachShadow({ mode: "open" });
    this.shadowRootRef.innerHTML = `
      <style>
        :host {
          all: initial;
        }

        .cf-layer {
          --cf-accent: #EE46BC;
          --cf-fill: rgba(238, 70, 188, 0.1);
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          font-family: "Satoshi Variable", "Satoshi", "Avenir Next", "Segoe UI", sans-serif;
        }

        .cf-border {
          position: fixed;
          display: none;
          overflow: visible;
          border: 1px solid var(--cf-accent);
          background: var(--cf-fill);
          border-radius: 0;
          box-sizing: border-box;
        }

        .cf-hover-border {
          position: fixed;
          display: none;
          overflow: visible;
          border: 1px solid rgba(238, 70, 188, 0.85);
          background: rgba(238, 70, 188, 0.04);
          border-radius: 0;
          box-sizing: border-box;
        }

        .cf-badge {
          position: absolute;
          top: -21px;
          left: -1px;
          width: fit-content;
          max-width: min(420px, calc(100vw - 96px));
          display: none;
          align-items: center;
          height: 20px;
          padding: 0 8px;
          border-radius: 0;
          background: var(--cf-accent);
          color: #ffffff;
          font-size: 10px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          box-sizing: border-box;
        }

        .cf-copy {
          position: absolute;
          top: -21px;
          right: -1px;
          display: none;
          align-items: center;
          justify-content: center;
          height: 20px;
          padding: 0 8px;
          border: 0;
          border-radius: 0;
          background: var(--cf-accent);
          color: #ffffff;
          cursor: pointer;
          font-size: 10px;
          font-weight: 500;
          line-height: 1;
          pointer-events: auto;
          font-family: inherit;
          white-space: nowrap;
          box-sizing: border-box;
        }

        .cf-copy:hover {
          background: var(--cf-accent);
        }

        .cf-border.cf-chip-bottom .cf-badge,
        .cf-border.cf-chip-bottom .cf-copy {
          top: calc(100% + 1px);
        }

        .cf-toast {
          position: fixed;
          z-index: 1;
          right: 20px;
          bottom: 20px;
          max-width: min(360px, calc(100vw - 40px));
          display: none;
          overflow: hidden;
          pointer-events: none;
          clip-path: inset(0 0 0 0);
          will-change: clip-path;
          transition: clip-path ${TOAST_LEAVE_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
          --cf-toast-enter-ms: ${TOAST_ENTER_MS}ms;
          --cf-toast-text-delay: ${TOAST_TEXT_DELAY_MS}ms;
        }

        .cf-toast.is-leaving {
          clip-path: inset(0 0 0 100%);
        }

        .cf-toast__surface {
          position: absolute;
          inset: 0;
          background: #000000;
          transform-origin: left center;
          transform: scaleX(0.04);
          opacity: 0;
          will-change: transform, opacity;
          transition:
            transform var(--cf-toast-enter-ms) cubic-bezier(0.16, 1, 0.3, 1),
            opacity 140ms ease-out;
        }

        .cf-toast.is-entering .cf-toast__surface,
        .cf-toast.is-visible .cf-toast__surface,
        .cf-toast.is-leaving .cf-toast__surface {
          transform: scaleX(1);
          opacity: 1;
        }

        .cf-toast__content {
          position: relative;
          padding: 10px 14px;
          color: #ffffff;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .cf-toast-char {
          display: inline-block;
          opacity: 0;
          transform: translateX(6px);
          filter: blur(6px);
          will-change: transform, opacity, filter;
          transition:
            opacity 110ms ease-out,
            transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
            filter 180ms ease-out;
          transition-delay: calc(var(--cf-toast-text-delay) + var(--cf-char-delay, 0ms));
        }

        .cf-toast.is-entering .cf-toast-char,
        .cf-toast.is-visible .cf-toast-char,
        .cf-toast.is-leaving .cf-toast-char {
          opacity: 1;
          transform: translateX(0);
          filter: blur(0);
        }

        .cf-settings {
          position: fixed;
          top: 20px;
          right: 20px;
          width: min(320px, calc(100vw - 32px));
          display: none;
          flex-direction: column;
          gap: 14px;
          padding: 16px;
          border: 1px solid rgba(17, 24, 39, 0.08);
          background: #fafafa;
          color: #111827;
          pointer-events: auto;
          box-sizing: border-box;
        }

        .cf-settings__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .cf-settings__brand {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .cf-settings__logo {
          width: 32px;
          height: 32px;
          flex: 0 0 32px;
          object-fit: contain;
        }

        .cf-settings__title {
          display: flex;
          align-items: center;
          gap: 0;
          font-size: 14px;
          font-weight: 600;
        }

        .cf-settings__chip {
          padding: 2px 6px;
          border: 1px solid #d1d5db;
          background: #ffffff;
          font-size: 11px;
          line-height: 1.2;
          white-space: nowrap;
        }

        .cf-settings__close {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border: 0;
          background: transparent;
          color: #6b7280;
          line-height: 1;
          cursor: pointer;
          padding: 0;
          margin: 0;
          pointer-events: auto;
        }

        .cf-settings__close::before,
        .cf-settings__close::after {
          content: "";
          position: absolute;
          width: 12px;
          height: 1px;
          background: currentColor;
        }

        .cf-settings__close::before {
          transform: rotate(45deg);
        }

        .cf-settings__close::after {
          transform: rotate(-45deg);
        }

        .cf-settings__text,
        .cf-settings__status {
          font-size: 12px;
          line-height: 1.5;
          color: #6b7280;
        }

        .cf-settings__field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .cf-settings__label,
        .cf-settings__section {
          font-size: 12px;
          font-weight: 600;
          color: #111827;
        }

        .cf-settings__row {
          display: flex;
          gap: 0;
        }

        .cf-settings__input {
          flex: 1;
          min-width: 0;
          padding: 9px 10px;
          border: 1px solid #d1d5db;
          background: #fafafa;
          color: #111827;
          font: inherit;
          font-size: 13px;
          box-sizing: border-box;
        }

        .cf-settings__input:focus {
          outline: none;
          border: 1px solid #111827;
          border-radius: 0;
          box-shadow: none;
        }

        .cf-settings__save {
          border: 0;
          background: #111827;
          color: #ffffff;
          padding: 9px 12px;
          font: inherit;
          font-size: 12px;
          white-space: nowrap;
          cursor: pointer;
          pointer-events: auto;
        }

        .cf-settings__list {
          display: grid;
          gap: 4px;
        }

        .cf-settings__item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 8px;
          background: #ffffff;
          font-size: 12px;
          line-height: 1.4;
        }

        .cf-settings__kbd {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 4px;
          background: #f9f9f9;
          color: #000000;
          line-height: 1.4;
          white-space: nowrap;
        }

        @media (prefers-reduced-motion: reduce) {
          .cf-toast,
          .cf-toast__surface,
          .cf-toast-char {
            transition: none !important;
          }

          .cf-toast__surface,
          .cf-toast-char {
            transform: none !important;
            filter: none !important;
          }
        }
      </style>
      <div class="cf-layer">
        <div class="cf-hover-border"></div>
        <div class="cf-border">
          <div class="cf-badge"></div>
          <button class="cf-copy" type="button">Copy</button>
        </div>
        <div class="cf-toast" role="status" aria-live="polite" aria-atomic="true">
          <div class="cf-toast__surface"></div>
          <div class="cf-toast__content" aria-hidden="true"></div>
        </div>
        <div class="cf-settings" aria-hidden="true">
          <div class="cf-settings__header">
            <div class="cf-settings__brand">
              <img class="cf-settings__logo" src="${LOGO_URL}" alt="Copy Frame logo" />
              <div>
                <div class="cf-settings__title">
                  <span>Copy Frame</span>
                </div>
                <div class="cf-settings__text">Point. Copy. For AI.</div>
              </div>
            </div>
            <button class="cf-settings__close" type="button" aria-label="关闭"></button>
          </div>
          <form class="cf-settings__field">
            <div class="cf-settings__label">启动快捷键</div>
            <div class="cf-settings__row">
              <input class="cf-settings__input" id="cf-toggle-shortcut" type="text" autocomplete="off" placeholder="${DEFAULT_TOGGLE_SHORTCUT}" readonly />
              <button class="cf-settings__save" type="submit">保存</button>
            </div>
          </form>
          <div class="cf-settings__status" aria-live="polite"></div>
          <div class="cf-settings__field">
            <div class="cf-settings__section">其他快捷键</div>
            <div class="cf-settings__list">
              <div class="cf-settings__item"><span>复制</span><span class="cf-settings__kbd">Ctrl+C / Ctrl+左键</span></div>
              <div class="cf-settings__item"><span>同级切换</span><span class="cf-settings__kbd">Tab</span></div>
              <div class="cf-settings__item"><span>层级切换</span><span class="cf-settings__kbd">Enter</span></div>
              <div class="cf-settings__item"><span>快捷键设置</span><span class="cf-settings__kbd">${SETTINGS_SHORTCUT.label}</span></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const borderEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-border");
    const hoverBorderEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-hover-border");
    const labelEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-badge");
    const copyButtonEl = this.shadowRootRef.querySelector<HTMLButtonElement>(".cf-copy");
    const toastEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-toast");
    const toastTextEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-toast__content");
    const settingsPanelEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-settings");
    const settingsInputEl = this.shadowRootRef.querySelector<HTMLInputElement>(".cf-settings__input");
    const settingsStatusEl = this.shadowRootRef.querySelector<HTMLDivElement>(".cf-settings__status");
    const settingsCloseButtonEl = this.shadowRootRef.querySelector<HTMLButtonElement>(".cf-settings__close");
    const settingsFormEl = this.shadowRootRef.querySelector<HTMLFormElement>("form.cf-settings__field");

    if (
      !borderEl ||
      !hoverBorderEl ||
      !labelEl ||
      !copyButtonEl ||
      !toastEl ||
      !toastTextEl ||
      !settingsPanelEl ||
      !settingsInputEl ||
      !settingsStatusEl ||
      !settingsCloseButtonEl ||
      !settingsFormEl
    ) {
      throw new Error("Copy Frame UI failed to initialize.");
    }

    this.borderEl = borderEl;
    this.hoverBorderEl = hoverBorderEl;
    this.labelEl = labelEl;
    this.copyButtonEl = copyButtonEl;
    this.toastEl = toastEl;
    this.toastTextEl = toastTextEl;
    this.settingsPanelEl = settingsPanelEl;
    this.settingsInputEl = settingsInputEl;
    this.settingsStatusEl = settingsStatusEl;
    this.settingsCloseButtonEl = settingsCloseButtonEl;
    this.settingsFormEl = settingsFormEl;

    this.copyButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copyCurrentSelection();
    });

    this.copyButtonEl.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    this.settingsCloseButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hideSettingsPanel();
    });

    this.settingsInputEl.addEventListener("keydown", (event) => {
      this.handleSettingsShortcutInput(event);
    });

    this.settingsFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveToggleShortcut();
    });
  }

  toggle(): void {
    if (this.state === "idle") {
      this.enterInspectMode();
      return;
    }

    this.exitInspectMode();
  }

  private toggleByShortcut(): void {
    if (this.state === "idle") {
      this.enterInspectMode();
      return;
    }

    this.exitInspectMode();
  }

  private ensureHostConnected(): void {
    if (!this.host.isConnected) {
      document.documentElement.appendChild(this.host);
    }
  }

  private renderHostVisibility(): void {
    this.host.style.display = this.state === "idle" && !this.settingsVisible ? "none" : "block";
  }

  private showSettingsPanel(): void {
    this.ensureHostConnected();
    this.settingsVisible = true;
    this.settingsPanelEl.style.display = "flex";
    this.settingsPanelEl.setAttribute("aria-hidden", "false");
    this.settingsInputEl.value = this.toggleShortcut.label;
    this.settingsStatusEl.textContent = "";
    this.renderHostVisibility();
  }

  private hideSettingsPanel(): void {
    this.settingsVisible = false;
    this.settingsPanelEl.style.display = "none";
    this.settingsPanelEl.setAttribute("aria-hidden", "true");
    this.settingsStatusEl.textContent = "";
    this.renderHostVisibility();
  }

  private handleSettingsShortcutInput(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (event.key === "Tab") {
      return;
    }

    if (event.key === "Escape") {
      this.hideSettingsPanel();
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      this.settingsInputEl.value = "";
      this.settingsStatusEl.textContent = "请重新按一个组合键";
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) {
      return;
    }

    this.settingsInputEl.value = shortcut.label;
    this.settingsStatusEl.textContent = "";
  }

  private async saveToggleShortcut(): Promise<void> {
    const value = this.settingsInputEl.value.trim();
    const parsed = parseShortcut(value);
    if (!parsed) {
      this.settingsStatusEl.textContent = "快捷键格式不对";
      return;
    }

    if (parsed.label === SETTINGS_SHORTCUT.label) {
      this.settingsStatusEl.textContent = `Alt+K 已用于快捷键设置`;
      return;
    }

    await chrome.storage.local.set({ [TOGGLE_SHORTCUT_STORAGE_KEY]: parsed.label });
    this.toggleShortcut = parsed;
    this.settingsInputEl.value = parsed.label;
    this.settingsStatusEl.textContent = "已保存";
  }

  private async loadToggleShortcut(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(TOGGLE_SHORTCUT_STORAGE_KEY);
      this.applyToggleShortcut(stored[TOGGLE_SHORTCUT_STORAGE_KEY]);
    } catch {
      this.toggleShortcut = parseShortcut(DEFAULT_TOGGLE_SHORTCUT)!;
    }
  }

  private applyToggleShortcut(value: unknown): void {
    if (typeof value === "string") {
      const parsed = parseShortcut(value);
      if (parsed) {
        this.toggleShortcut = parsed;
        if (this.settingsVisible) {
          this.settingsInputEl.value = parsed.label;
        }
        return;
      }
    }

    this.toggleShortcut = parseShortcut(DEFAULT_TOGGLE_SHORTCUT)!;
    if (this.settingsVisible) {
      this.settingsInputEl.value = this.toggleShortcut.label;
    }
  }

  private enterInspectMode(): void {
    this.ensureHostConnected();
    this.state = "inspecting";
    this.currentElement = null;
    this.hoverElement = null;
    this.currentDescriptor = null;
    this.setCopyButtonVisible(false);
    this.renderSelection(null);
    this.renderHoverSelection(null);

    document.addEventListener("mousemove", this.handleMouseMove, true);
    document.addEventListener("click", this.handleDocumentClick, true);
    document.addEventListener("keydown", this.handleKeydown, true);
    window.addEventListener("scroll", this.handleViewportChange, true);
    window.addEventListener("resize", this.handleViewportChange, true);
    this.renderHostVisibility();

    this.showToast("Copy Frame 已启动，移动鼠标即可查看并复制区域名称。");
  }

  private exitInspectMode(): void {
    this.state = "idle";
    this.settingsVisible = false;
    this.settingsPanelEl.style.display = "none";
    this.settingsPanelEl.setAttribute("aria-hidden", "true");
    this.currentElement = null;
    this.hoverElement = null;
    this.currentDescriptor = null;
    this.pointerClientX = null;
    this.pointerClientY = null;
    this.drillStack.length = 0;
    this.selectionHistory.length = 0;
    this.historyIndex = -1;
    if (this.refreshFrame !== null) {
      window.cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }
    this.setCopyButtonVisible(false);
    this.renderSelection(null);
    this.renderHoverSelection(null);
    this.renderHostVisibility();

    document.removeEventListener("mousemove", this.handleMouseMove, true);
    document.removeEventListener("click", this.handleDocumentClick, true);
    document.removeEventListener("keydown", this.handleKeydown, true);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    window.removeEventListener("resize", this.handleViewportChange, true);
  }

  private clearLockedSelection(): void {
    this.state = "inspecting";
    this.currentElement = null;
    this.hoverElement = null;
    this.currentDescriptor = null;
    this.setCopyButtonVisible(false);
    this.renderSelection(null);
    this.renderHoverSelection(null);
  }

  private lockSelection(
    element: Element,
    source: SelectionSource,
    options?: { resetDrillStack?: boolean; recordHistory?: boolean; followViewport?: boolean }
  ): boolean {
    if (!this.isSelectableElement(element)) {
      return false;
    }

    if (options?.resetDrillStack) {
      this.drillStack.length = 0;
    }

    this.currentElement = element;
    this.hoverElement = null;
    this.currentDescriptor = this.describeElement(element);
    this.state = "locked";
    if (options?.followViewport) {
      this.ensureSelectionInViewport(element);
    }
    const isVisible = this.renderSelection(element, this.currentDescriptor.friendlyName);
    this.setCopyButtonVisible(isVisible);
    this.renderHoverSelection(null);

    if (options?.recordHistory ?? true) {
      this.recordHistory(element);
    }

    if (source === "click" || source === "sibling" || source === "undo") {
      this.drillStack.length = 0;
    }

    return true;
  }

  private recordHistory(element: Element): void {
    if (this.historyIndex >= 0 && this.selectionHistory[this.historyIndex] === element) {
      return;
    }

    this.selectionHistory.splice(this.historyIndex + 1);
    this.selectionHistory.push(element);
    this.historyIndex = this.selectionHistory.length - 1;
  }

  private findSelectableAncestor(element: Element | null): Element | null {
    let current = element;

    while (current) {
      if (this.isSelectableElement(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  private findSelectableDescendant(element: Element | null): Element | null {
    if (!element) {
      return null;
    }

    let currentLevel = Array.from(element.children);
    while (currentLevel.length > 0) {
      const nextLevel: Element[] = [];

      for (const child of currentLevel) {
        if (this.isSelectableElement(child)) {
          return child;
        }

        nextLevel.push(...Array.from(child.children));
      }

      currentLevel = nextLevel;
    }

    return null;
  }

  private findSelectableSibling(step: 1 | -1): Element | null {
    if (!this.currentElement?.parentElement) {
      return null;
    }

    const siblings = Array.from(this.currentElement.parentElement.children).filter((child) =>
      this.isSelectableElement(child)
    );

    if (siblings.length <= 1) {
      return null;
    }

    const currentIndex = siblings.indexOf(this.currentElement);
    if (currentIndex < 0) {
      return null;
    }

    const nextIndex = (currentIndex + step + siblings.length) % siblings.length;
    return siblings[nextIndex] ?? null;
  }

  private undoSelection(): void {
    if (this.state !== "locked") {
      return;
    }

    let nextIndex = this.historyIndex - 1;
    while (nextIndex >= 0) {
      const candidate = this.selectionHistory[nextIndex];
      if (candidate?.isConnected && this.isSelectableElement(candidate)) {
        this.historyIndex = nextIndex;
        this.lockSelection(candidate, "undo", { resetDrillStack: true, recordHistory: false, followViewport: true });
        return;
      }

      nextIndex -= 1;
    }

    this.showToast("已经回到最早一次选中。");
  }

  private readonly handleViewportChange = (): void => {
    if (this.state === "idle") {
      return;
    }

    if (this.refreshFrame !== null) {
      return;
    }

    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = null;
      if (this.state === "locked") {
        this.refreshLockedSelection();
      }
      this.syncPointerTarget();
    });
  };

  private refreshLockedSelection(): void {
    if (this.state !== "locked" || !this.currentElement) {
      return;
    }

    if (!this.currentElement.isConnected || !this.isSelectableElement(this.currentElement)) {
      this.clearLockedSelection();
      this.showToast("当前选中内容已不可用。");
      return;
    }

    const label = this.currentDescriptor?.friendlyName ?? this.describeElement(this.currentElement).friendlyName;
    const isVisible = this.renderSelection(this.currentElement, label);
    this.setCopyButtonVisible(isVisible);
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (this.state === "idle") {
      return;
    }

    if (this.isEventInsideUi(event)) {
      return;
    }

    this.pointerClientX = event.clientX;
    this.pointerClientY = event.clientY;
    this.syncPointerTarget();
  };

  private readonly handleDocumentClick = (event: MouseEvent): void => {
    if (this.state === "idle") {
      return;
    }

    if (this.isEventInsideUi(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const element = this.pickElement(event.clientX, event.clientY);
    if (!element) {
      return;
    }

    if (!this.isSupportedTarget(element)) {
      this.showToast(this.getUnsupportedReason(element));
      this.state = "inspecting";
      this.setCopyButtonVisible(false);
      return;
    }

    this.lockSelection(element, "click", { resetDrillStack: true, recordHistory: true });

    if (event.button === 0 && hasPrimaryModifier(event)) {
      void this.copyCurrentSelection();
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    const normalizedKey = event.key.toLowerCase();
    const isUndoShortcut =
      this.state === "locked" &&
      !event.shiftKey &&
      !event.altKey &&
      normalizedKey === "z" &&
      hasPrimaryModifier(event);
    if (isUndoShortcut) {
      event.preventDefault();
      event.stopPropagation();
      this.undoSelection();
      return;
    }

    const isCopyShortcut =
      this.state === "locked" &&
      !event.shiftKey &&
      !event.altKey &&
      normalizedKey === "c" &&
      hasPrimaryModifier(event);
    if (isCopyShortcut) {
      event.preventDefault();
      event.stopPropagation();
      void this.copyCurrentSelection();
      return;
    }

    if (this.state === "locked" && event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const sibling = this.findSelectableSibling(event.shiftKey ? -1 : 1);

      if (!sibling) {
        this.showToast("当前没有其他平行层可切换。");
        return;
      }

      this.lockSelection(sibling, "sibling", { resetDrillStack: true, recordHistory: true, followViewport: true });
      return;
    }

    if (this.state === "locked" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();

      const ancestor = this.findSelectableAncestor(this.currentElement?.parentElement ?? null);
      if (!ancestor) {
        this.showToast("已经是最外层可选框架。");
        return;
      }

      this.lockSelection(ancestor, "ancestor", { resetDrillStack: true, recordHistory: true, followViewport: true });
      return;
    }

    if (this.state === "locked" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();

      const child = this.findSelectableDescendant(this.currentElement);
      if (!child) {
        this.showToast("当前没有更细一层。");
        return;
      }

      this.lockSelection(child, "descendant", { resetDrillStack: true, recordHistory: true, followViewport: true });
      return;
    }

    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (this.state === "locked") {
      this.clearLockedSelection();
      this.showToast("已退出选中状态，再按一次 Esc 可退出插件。");
      return;
    }

    this.exitInspectMode();
  };

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    const isTyping = isTypingTarget(event.target);
    if (this.state !== "idle" && !isTyping && matchesShortcut(event, SETTINGS_SHORTCUT)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (this.settingsVisible) {
        this.hideSettingsPanel();
      } else {
        this.showSettingsPanel();
      }
      return;
    }

    if (isTyping || !matchesShortcut(event, this.toggleShortcut)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.toggleByShortcut();
  };

  private readonly handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: "sync" | "local" | "managed" | "session"
  ): void => {
    if (areaName !== "local" || !(TOGGLE_SHORTCUT_STORAGE_KEY in changes)) {
      return;
    }

    this.applyToggleShortcut(changes[TOGGLE_SHORTCUT_STORAGE_KEY]?.newValue);
  };

  private isEventInsideUi(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private pickElement(clientX: number, clientY: number): Element | null {
    const candidate = document.elementFromPoint(clientX, clientY);
    if (!candidate) {
      return null;
    }

    return this.findSelectableElement(candidate);
  }

  private findSelectableElement(start: Element): Element | null {
    let current: Element | null = start;

    while (current) {
      if (current === this.host || this.host.contains(current)) {
        return null;
      }

      const tagName = current.tagName.toLowerCase();
      if (tagName === "html" || tagName === "body") {
        return null;
      }

      if (this.isMeaningfulElement(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  private isMeaningfulElement(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number.parseFloat(style.opacity || "1") === 0
    ) {
      return false;
    }

    return true;
  }

  private isSupportedTarget(element: Element): boolean {
    return element.tagName.toLowerCase() !== "canvas";
  }

  private isSelectableElement(element: Element): boolean {
    if (element === this.host || this.host.contains(element)) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "html" || tagName === "body") {
      return false;
    }

    return this.isMeaningfulElement(element) && this.isSupportedTarget(element);
  }

  private getUnsupportedReason(element: Element): string {
    if (element.tagName.toLowerCase() === "canvas") {
      return "当前区域是 canvas 画布，第一版只能复制 DOM 元素命名。";
    }

    return "当前区域暂时无法提取稳定命名。";
  }

  private syncPointerTarget(): void {
    if (this.pointerClientX === null || this.pointerClientY === null) {
      if (this.state === "locked") {
        this.hoverElement = null;
        this.renderHoverSelection(null);
      }
      return;
    }

    const element = this.pickElement(this.pointerClientX, this.pointerClientY);
    if (!element) {
      if (this.state === "locked") {
        this.hoverElement = null;
        this.renderHoverSelection(null);
        return;
      }

      this.currentElement = null;
      this.currentDescriptor = null;
      this.setCopyButtonVisible(false);
      this.renderSelection(null);
      return;
    }

    if (this.state === "locked") {
      if (element === this.currentElement) {
        this.hoverElement = null;
        this.renderHoverSelection(null);
        return;
      }

      this.hoverElement = element;
      this.renderHoverSelection(element);
      return;
    }

    this.currentElement = element;
    this.currentDescriptor = this.describeElement(element);
    const isVisible = this.renderSelection(element, this.currentDescriptor.friendlyName);
    this.setCopyButtonVisible(isVisible);
  }

  private getRenderableRect(element: Element): DOMRect | null {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const isInViewport =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;

    return isInViewport ? rect : null;
  }

  private ensureSelectionInViewport(element: Element): void {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const isAboveViewport = rect.top < 0;
    const isBelowViewport = rect.bottom > window.innerHeight;
    if (!isAboveViewport && !isBelowViewport) {
      return;
    }

    element.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "auto"
    });
  }

  private renderHoverSelection(element: Element | null): boolean {
    if (!element) {
      this.hoverBorderEl.style.display = "none";
      return false;
    }

    const rect = this.getRenderableRect(element);
    if (!rect) {
      this.hoverBorderEl.style.display = "none";
      return false;
    }

    this.hoverBorderEl.style.display = "block";
    this.hoverBorderEl.style.left = `${rect.left}px`;
    this.hoverBorderEl.style.top = `${rect.top}px`;
    this.hoverBorderEl.style.width = `${rect.width}px`;
    this.hoverBorderEl.style.height = `${rect.height}px`;
    return true;
  }

  private renderSelection(element: Element | null, label = ""): boolean {
    if (!element) {
      this.borderEl.classList.remove("cf-chip-bottom");
      this.borderEl.style.display = "none";
      this.labelEl.style.display = "none";
      this.setCopyButtonVisible(false);
      return false;
    }

    const rect = this.getRenderableRect(element);
    if (!rect) {
      this.borderEl.classList.remove("cf-chip-bottom");
      this.borderEl.style.display = "none";
      this.labelEl.style.display = "none";
      this.setCopyButtonVisible(false);
      return false;
    }

    const chipHeight = 21;
    const shouldFlipChips = rect.top < chipHeight + 8;
    this.borderEl.classList.toggle("cf-chip-bottom", shouldFlipChips);

    this.borderEl.style.display = "block";
    this.borderEl.style.left = `${rect.left}px`;
    this.borderEl.style.top = `${rect.top}px`;
    this.borderEl.style.width = `${rect.width}px`;
    this.borderEl.style.height = `${rect.height}px`;
    this.labelEl.style.maxWidth = `${Math.max(48, Math.min(420, window.innerWidth - rect.left - 72))}px`;

    if (label) {
      this.labelEl.textContent = label;
      this.labelEl.style.display = "flex";
    } else {
      this.labelEl.style.display = "none";
    }

    return true;
  }

  private setCopyButtonVisible(visible: boolean): void {
    this.copyButtonEl.style.display = visible ? "inline-flex" : "none";
  }

  private async copyCurrentSelection(): Promise<void> {
    if (!this.currentDescriptor) {
      this.showToast("请先悬停或点击目标区域。");
      return;
    }

    const text = this.currentDescriptor.output;
    const copied = await copyText(text);

    if (!copied) {
      this.showToast("复制失败，请重试。");
      return;
    }

    this.showToast("已复制区域描述，可以直接贴给 AI。");
  }

  private showToast(message: string): void {
    this.clearToastTimers();
    this.renderToastMessage(message);
    this.toastEl.setAttribute("aria-label", message);
    this.toastEl.classList.remove("is-entering", "is-visible", "is-leaving");
    this.toastEl.style.display = "block";
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add("is-entering");

    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove("is-entering");
      this.toastEl.classList.add("is-visible");
      this.toastTimer = null;
    }, TOAST_ENTER_MS);

    const leaveDelay = Math.max(TOAST_ENTER_MS, TOAST_TOTAL_MS - TOAST_LEAVE_MS);
    this.toastCleanupTimer = window.setTimeout(() => {
      this.toastEl.classList.remove("is-entering", "is-visible");
      this.toastEl.classList.add("is-leaving");
      this.toastCleanupTimer = window.setTimeout(() => {
        this.toastEl.classList.remove("is-leaving");
        this.toastEl.style.display = "none";
        this.toastEl.removeAttribute("aria-label");
        this.toastCleanupTimer = null;
      }, TOAST_LEAVE_MS);
    }, leaveDelay);
  }

  private clearToastTimers(): void {
    if (this.toastTimer) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    if (this.toastCleanupTimer) {
      window.clearTimeout(this.toastCleanupTimer);
      this.toastCleanupTimer = null;
    }
  }

  private renderToastMessage(message: string): void {
    const fragment = document.createDocumentFragment();

    Array.from(message).forEach((char, index) => {
      const span = document.createElement("span");
      span.className = "cf-toast-char";
      span.textContent = char;
      span.style.setProperty(
        "--cf-char-delay",
        `${Math.min(index * TOAST_CHAR_STAGGER_MS, TOAST_CHAR_STAGGER_CAP_MS)}ms`
      );
      fragment.appendChild(span);
    });

    this.toastTextEl.replaceChildren(fragment);
  }

  private describeElement(element: Element): SelectionDescriptor {
    const friendlyName = buildFriendlyName(element);
    const elementHints = collectElementHints(element).slice(0, MAX_HINTS);
    const ancestorHints = collectAncestorHints(element).slice(0, 3);
    const selector = buildReadableSelector(element);
    const textSnippet = getTextSnippet(element);
    const pageContext = buildPageContext();
    const contextHint = buildDisambiguationContext(element, ancestorHints);
    const target = shouldIncludeContext(element, friendlyName, selector, contextHint)
      ? `${contextHint} > ${friendlyName}`
      : friendlyName;
    const output = selector
      ? `[${pageContext}] ${target} :: ${selector}`
      : `[${pageContext}] ${target}`;

    return {
      friendlyName,
      elementHints,
      ancestorHints,
      selector,
      textSnippet,
      pageContext,
      output
    };
  }
}

function ensureInspector(): CopyFrameInspector {
  if (!window.__copyFrameInspector) {
    window.__copyFrameInspector = new CopyFrameInspector();
  }

  return window.__copyFrameInspector;
}

ensureInspector();

function buildFriendlyName(element: Element): string {
  const preferredName =
    readAttribute(element, ["data-testid", "data-test-id", "data-qa", "data-cy"]) ||
    element.getAttribute("name") ||
    element.getAttribute("aria-label") ||
    getAssociatedLabel(element) ||
    element.getAttribute("id");

  if (preferredName) {
    return sanitizeText(preferredName);
  }

  const role = element.getAttribute("role");
  if (role) {
    return `${role}-${element.tagName.toLowerCase()}`;
  }

  const stableClass = getStableClassName(element);
  if (stableClass) {
    return stableClass;
  }

  const textSnippet = getTextSnippet(element);
  if (textSnippet) {
    return `${element.tagName.toLowerCase()}-${textSnippet.slice(0, 24)}`;
  }

  return `${element.tagName.toLowerCase()}-region`;
}

function collectElementHints(element: Element): string[] {
  const hints: HintEntry[] = [];

  const namedAttrs = ["data-testid", "data-test-id", "data-qa", "data-cy", "name", "aria-label", "id"];
  namedAttrs.forEach((attr) => {
    const value = element.getAttribute(attr);
    if (value) {
      hints.push({ label: attr, value });
    }
  });

  const role = element.getAttribute("role");
  if (role) {
    hints.push({ label: "role", value: role });
  }

  const stableClass = getStableClassName(element);
  if (stableClass) {
    hints.push({ label: "class", value: stableClass });
  }

  const textSnippet = getTextSnippet(element);
  if (textSnippet) {
    hints.push({ label: "text", value: textSnippet });
  }

  return uniq(
    hints.map((entry) => `${entry.label}=${entry.value}`).filter((value) => value.length <= 100)
  );
}

function collectAncestorHints(element: Element): string[] {
  const hints: string[] = [];
  let current = element.parentElement;

  while (current && hints.length < 4) {
    const tag = current.tagName.toLowerCase();
    if (tag === "body" || tag === "html") {
      break;
    }

    const stableClass = getStableClassName(current);
    if (stableClass) {
      hints.push(`.${stableClass}`);
      current = current.parentElement;
      continue;
    }

    if (current.id) {
      hints.push(`#${sanitizeText(current.id)}`);
      current = current.parentElement;
      continue;
    }

    const testAttribute = readNamedAttribute(current, ["data-testid", "data-test-id", "data-qa", "data-cy"]);
    if (testAttribute) {
      hints.push(`${testAttribute.name}=${sanitizeText(testAttribute.value)}`);
      current = current.parentElement;
      continue;
    }

    const ariaLabel = current.getAttribute("aria-label");
    if (ariaLabel) {
      hints.push(`aria-label="${sanitizeText(ariaLabel)}"`);
      current = current.parentElement;
      continue;
    }

    const heading = getContainedHeading(current);
    if (heading) {
      hints.push(`“${heading}”区域`);
      current = current.parentElement;
      continue;
    }

    current = current.parentElement;
  }

  return uniq(hints);
}

function buildReadableSelector(element: Element): string {
  if (element.id) {
    return `${element.tagName.toLowerCase()}#${escapeSelector(element.id)}`;
  }

  const directSelector = buildDirectSelector(element);
  if (isUniqueSelector(directSelector, element)) {
    return directSelector;
  }

  const parts: string[] = [];
  let current: Element | null = element;

  while (current && parts.length < 4) {
    const selector = buildDirectSelector(current);
    parts.unshift(selector);
    const combined = parts.join(" > ");
    if (isUniqueSelector(combined, element)) {
      return combined;
    }

    current = current.parentElement;
    if (!current || current.tagName.toLowerCase() === "body") {
      break;
    }
  }

  return parts.join(" > ") || element.tagName.toLowerCase();
}

function buildDirectSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const selectors: string[] = [tag];

  const testAttribute = readNamedAttribute(element, ["data-testid", "data-test-id", "data-qa", "data-cy"]);
  if (testAttribute) {
    selectors.push(`[${testAttribute.name}="${escapeSelector(testAttribute.value)}"]`);
    return selectors.join("");
  }

  if (element.getAttribute("name")) {
    selectors.push(`[name="${escapeSelector(element.getAttribute("name") || "")}"]`);
  } else if (element.getAttribute("aria-label")) {
    selectors.push(`[aria-label="${escapeSelector(element.getAttribute("aria-label") || "")}"]`);
  } else {
    const stableClass = getStableClassName(element);
    if (stableClass) {
      selectors.push(`.${escapeSelector(stableClass)}`);
    }
  }

  const nth = getNthOfType(element);
  if (nth > 1) {
    selectors.push(`:nth-of-type(${nth})`);
  }

  return selectors.join("");
}

function getSiblingIndexHint(element: Element): string {
  const parent = element.parentElement;
  if (!parent) {
    return "";
  }

  const sameTagSiblings = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName
  );

  if (sameTagSiblings.length <= 1) {
    return "";
  }

  const index = sameTagSiblings.indexOf(element) + 1;
  return `同级第 ${index} 个 ${element.tagName.toLowerCase()} 元素`;
}

function buildDisambiguationContext(element: Element, ancestorHints: string[]): string {
  if (ancestorHints[0]) {
    return ancestorHints[0];
  }

  return getSiblingIndexHint(element);
}

function shouldIncludeContext(
  element: Element,
  friendlyName: string,
  selector: string,
  contextHint: string
): boolean {
  if (!contextHint) {
    return false;
  }

  if (/:(nth-of-type|nth-child)\(/.test(selector)) {
    return true;
  }

  if (isGenericFriendlyName(friendlyName)) {
    return true;
  }

  const parent = element.parentElement;
  if (!parent) {
    return false;
  }

  const sameTagSiblings = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName
  );

  return sameTagSiblings.length > 1 && !hasStrongOwnIdentifier(element);
}

function isGenericFriendlyName(friendlyName: string): boolean {
  const normalized = friendlyName.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return (
    normalized.endsWith("-region") ||
    normalized === "button" ||
    normalized === "link" ||
    normalized === "input" ||
    normalized === "section" ||
    normalized === "container" ||
    normalized === "dialog"
  );
}

function hasStrongOwnIdentifier(element: Element): boolean {
  return Boolean(
    element.id ||
      element.getAttribute("name") ||
      element.getAttribute("aria-label") ||
      readAttribute(element, ["data-testid", "data-test-id", "data-qa", "data-cy"])
  );
}

function getAssociatedLabel(element: Element): string | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  if (element.id) {
    const label = document.querySelector(`label[for="${escapeSelector(element.id)}"]`);
    if (label?.textContent) {
      return sanitizeText(label.textContent);
    }
  }

  const parentLabel = element.closest("label");
  if (parentLabel?.textContent) {
    return sanitizeText(parentLabel.textContent);
  }

  return null;
}

function getContainedHeading(element: Element): string | null {
  const heading = element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
  if (!heading?.textContent) {
    return null;
  }

  return sanitizeText(heading.textContent);
}

function describeContainer(element: Element): string {
  const role = element.getAttribute("role");
  if (role) {
    return role === "dialog" ? "弹窗" : `${role} 容器`;
  }

  switch (element.tagName.toLowerCase()) {
    case "form":
      return "表单";
    case "nav":
      return "导航";
    case "aside":
      return "侧栏";
    case "section":
      return "区域";
    case "header":
      return "顶部区域";
    default:
      return "容器";
  }
}

function getStableClassName(element: Element): string | null {
  for (const className of Array.from(element.classList)) {
    if (
      className.length >= 3 &&
      !GENERIC_CLASS_NAMES.has(className.toLowerCase()) &&
      /^[A-Za-z][A-Za-z0-9_-]+$/.test(className) &&
      !/\d{4,}/.test(className)
    ) {
      return className;
    }
  }

  return null;
}

function getTextSnippet(element: Element): string {
  const text = sanitizeText(element.textContent || "");
  if (!text) {
    return "";
  }

  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

function buildPageContext(): string {
  const title = sanitizeText(document.title || "");
  const path = `${window.location.host}${window.location.pathname}`;

  if (title && window.location.pathname && window.location.pathname !== "/") {
    return `${title} / ${path}`;
  }

  return title || path;
}

function sanitizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readAttribute(element: Element, attrs: string[]): string | null {
  for (const attr of attrs) {
    const value = element.getAttribute(attr);
    if (value) {
      return value;
    }
  }

  return null;
}

function readNamedAttribute(
  element: Element,
  attrs: string[]
): { name: string; value: string } | null {
  for (const attr of attrs) {
    const value = element.getAttribute(attr);
    if (value) {
      return { name: attr, value };
    }
  }

  return null;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function getNthOfType(element: Element): number {
  const parent = element.parentElement;
  if (!parent) {
    return 1;
  }

  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  return siblings.indexOf(element) + 1;
}

function isUniqueSelector(selector: string, element: Element): boolean {
  if (!selector) {
    return false;
  }

  try {
    return document.querySelectorAll(selector).length === 1 && document.querySelector(selector) === element;
  } catch {
    return false;
  }
}

function escapeSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function hasPrimaryModifier(event: MouseEvent | KeyboardEvent): boolean {
  return (event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  return editable !== null;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    fallback.style.pointerEvents = "none";
    document.body.appendChild(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    return copied;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== TOGGLE_INSPECT_MODE) {
    return;
  }

  ensureInspector().toggle();
  sendResponse({ ok: true });
});
