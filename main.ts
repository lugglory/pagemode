import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  type Editor,
  type EditorPosition,
  type Menu,
  type WorkspaceLeaf,
} from "obsidian";

const SCROLL_EDGE_TOLERANCE_PX = 8;
const LINE_BOUNDARY_EPSILON_PX = 1;
const MIN_PAGE_ADVANCE_PX = 4;
const INLINE_TITLE_AREA_PADDING_PX = 8;
const FILE_POSITION_CONTAINER_CLASS = "pagemode-has-file-position-bar";
const FILE_POSITION_BAR_CLASS = "pagemode-file-position-bar";
const FILE_POSITION_THUMB_CLASS = "pagemode-file-position-thumb";
const FILE_POSITION_BAR_VERTICAL_PADDING_PX = 0;
const FILE_POSITION_THUMB_MIN_HEIGHT_PX = 2;
const FILE_POSITION_BAR_MIN_WIDTH_PX = 12;
const FILE_POSITION_BAR_MAX_WIDTH_PX = 64;
const FILE_POSITION_BAR_MARGIN_GAP_PX = 4;
const FILE_POSITION_BAR_ACTIVE_CLASS = "is-active";
const FILE_POSITION_THUMB_LEFT_PX = 1;
const FILE_POSITION_THUMB_MAX_WIDTH_PX = 19;
const DOCUMENT_CONTROL_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "a",
  "[role='button']",
  ".clickable-icon",
  ".collapse-indicator",
  ".heading-collapse-indicator",
  ".list-collapse-indicator",
  ".cm-fold-indicator",
].join(", ");

type RightDocumentLocation = "right-split" | "right-sidebar";

const RIGHT_DOCUMENT_LOCATION_OPTIONS: Record<RightDocumentLocation, string> = {
  "right-split": "Right split",
  "right-sidebar": "Right sidebar",
};

interface PageModeSettings {
  pageUnitScroll: boolean;
  archiveFolder: string;
  showArchiveFolder: boolean;
  rightDocumentLocation: RightDocumentLocation;
}

type LoadedPageModeSettings = {
  pageUnitScroll?: boolean;
  archiveFolder?: unknown;
  showArchiveFolder?: boolean;
  rightDocumentLocation?: RightDocumentLocation;
};

const DEFAULT_SETTINGS: PageModeSettings = {
  pageUnitScroll: false,
  archiveFolder: "archive",
  showArchiveFolder: false,
  rightDocumentLocation: "right-split",
};

type ContentLineRect = {
  top: number;
  bottom: number;
};

type ScrollBand = {
  top: number;
  bottom: number;
};

type PageScrollContext = {
  scrollEl: HTMLElement;
  contentEl: HTMLElement;
};

type FileNavigationPosition = {
  index: number;
  total: number;
};

type FileExplorerPluginInstance = {
  revealInFolder?: (file: TAbstractFile) => unknown;
};

type InternalPluginEntry = {
  instance?: FileExplorerPluginInstance;
};

type InternalPlugins = {
  plugins?: Record<string, InternalPluginEntry>;
  getPluginById?: (id: string) => InternalPluginEntry | null;
};

type AppWithInternalPlugins = App & {
  internalPlugins?: InternalPlugins;
};

type SelectedEditorRange = {
  from: EditorPosition;
  to: EditorPosition;
  text: string;
};

type DraggedEditorSelection = {
  editor: Editor;
  sourceFile: TFile;
  ranges: SelectedEditorRange[];
};

type MarkdownViewTarget = {
  file: TFile;
  displayName: string;
  distance: number;
};

type MarkdownLeafTarget = {
  leaf: WorkspaceLeaf;
  detachOnFailure: boolean;
};

type PendingWheelNavigation = {
  leaf: WorkspaceLeaf;
  offset: -1 | 1;
  showNotice: boolean;
};

export default class PageModePlugin extends Plugin {
  settings: PageModeSettings = { ...DEFAULT_SETTINGS };

  private openingFile = false;
  private openingFileNavigationOffset: -1 | 1 | null = null;
  private pendingWheelNavigation: PendingWheelNavigation | null = null;
  private unloaded = false;
  private draggedEditorSelection: DraggedEditorSelection | null = null;
  private markdownActionViews = new WeakSet<MarkdownView>();
  private markdownActionEls = new Set<HTMLElement>();
  private archiveFolderStyleEl: HTMLStyleElement | null = null;
  private filePositionStyleEl: HTMLStyleElement | null = null;
  private filePositionBarEls = new WeakMap<MarkdownView, HTMLDivElement>();
  private activeFilePositionBarEl: HTMLElement | null = null;
  private filePositionUpdateFrame: number | null = null;
  private collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  async onload(): Promise<void> {
    this.unloaded = false;
    await this.loadSettings();
    this.addSettingTab(new PageModeSettingTab(this.app, this));
    this.updateArchiveFolderStyles();

    this.addCommand({
      id: "open-next-file-in-folder",
      name: "Open next Markdown file",
      callback: () => {
        void this.openNextMarkdownFile(true);
      },
    });

    this.addCommand({
      id: "open-previous-file-in-folder",
      name: "Open previous Markdown file",
      callback: () => {
        void this.openPreviousMarkdownFile(true);
      },
    });

    this.addCommand({
      id: "send-selection-or-file-to-nearest-right-document",
      name: "Send selection or file to nearest right document",
      editorCheckCallback: (checking, editor, info) => {
        if (!this.canSendToRightDocument(info.file)) {
          return false;
        }

        if (!checking) {
          void this.extractSelectionToRightDocumentCommand(editor, info.file);
        }

        return true;
      },
    });

    this.addCommand({
      id: "archive-current-file",
      name: "Archive current file",
      checkCallback: (checking) => {
        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile || this.isArchivePath(currentFile.path)) {
          return false;
        }

        if (!checking) {
          void this.archiveAbstractFile(currentFile);
        }

        return true;
      },
    });

    this.addCommand({
      id: "unarchive-current-file",
      name: "Unarchive current file",
      checkCallback: (checking) => {
        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile || !this.isArchivePath(currentFile.path)) {
          return false;
        }

        if (!checking) {
          void this.unarchiveAbstractFile(currentFile);
        }

        return true;
      },
    });

    this.registerDomEvent(
      activeDocument,
      "wheel",
      (event: WheelEvent) => {
        void this.handleWheel(event);
      },
      { capture: true, passive: false },
    );

    this.registerDomEvent(
      activeDocument,
      "mousemove",
      (event: MouseEvent) => {
        this.handleMouseMove(event);
      },
      { capture: true },
    );

    this.registerDomEvent(activeWindow, "blur", () => {
      this.setActiveFilePositionBar(null);
    });

    this.registerDomEvent(
      activeDocument,
      "dragstart",
      (event: DragEvent) => {
        this.handleDragStart(event);
      },
      { capture: true },
    );

    this.registerDomEvent(
      activeDocument,
      "dragend",
      () => {
        this.draggedEditorSelection = null;
      },
      { capture: true },
    );

    this.register(() => {
      this.unloaded = true;
      if (this.filePositionUpdateFrame !== null) {
        activeWindow.cancelAnimationFrame(this.filePositionUpdateFrame);
        this.filePositionUpdateFrame = null;
      }
      this.markdownActionEls.forEach((element) => element.remove());
      this.markdownActionEls.clear();
      this.archiveFolderStyleEl?.remove();
      this.archiveFolderStyleEl = null;
      this.filePositionStyleEl?.remove();
      this.filePositionStyleEl = null;
      activeDocument.querySelectorAll(`[data-pagemode-file-position-bar]`).forEach((element) => element.remove());
      activeDocument
        .querySelectorAll(`.${FILE_POSITION_CONTAINER_CLASS}`)
        .forEach((element) => element.removeClass(FILE_POSITION_CONTAINER_CLASS));
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("Move active file here")
              .setIcon("folder-input")
              .setSection("open")
              .onClick(() => {
                void this.moveCurrentFileToFolder(file);
              });
          });
        }

        this.addArchiveMenuItem(menu, file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        this.addSendToRightDocumentMenuItem(menu, editor, info.file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-drop", (event, editor, info) => {
        if (event.defaultPrevented) {
          return;
        }

        this.handleEditorDrop(event, editor, info.file);
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) {
        return;
      }

      this.addMarkdownViewActions();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.addMarkdownViewActions();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("resize", () => {
        this.scheduleFilePositionBarUpdate();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.addMarkdownViewActions();
      }),
    );
  }

  private static isMarkdownFile(file: TFile): boolean {
    return file.extension.toLowerCase() === "md";
  }

  private isHTMLElement(target: Node | null): target is HTMLElement {
    return target?.instanceOf(HTMLElement) === true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private isRightDocumentLocation(value: unknown): value is RightDocumentLocation {
    return value === "right-split" || value === "right-sidebar";
  }

  private parseLoadedSettings(value: unknown): LoadedPageModeSettings {
    if (!this.isRecord(value)) {
      return {};
    }

    return {
      pageUnitScroll: typeof value.pageUnitScroll === "boolean" ? value.pageUnitScroll : undefined,
      archiveFolder: value.archiveFolder,
      showArchiveFolder:
        typeof value.showArchiveFolder === "boolean" ? value.showArchiveFolder : undefined,
      rightDocumentLocation: this.isRightDocumentLocation(value.rightDocumentLocation)
        ? value.rightDocumentLocation
        : undefined,
    };
  }

  async loadSettings(): Promise<void> {
    const loadedData = this.parseLoadedSettings(await this.loadData());
    this.settings = {
      ...DEFAULT_SETTINGS,
      pageUnitScroll: loadedData.pageUnitScroll ?? DEFAULT_SETTINGS.pageUnitScroll,
      archiveFolder: this.normalizeArchiveFolder(loadedData.archiveFolder),
      showArchiveFolder: loadedData.showArchiveFolder ?? DEFAULT_SETTINGS.showArchiveFolder,
      rightDocumentLocation: loadedData.rightDocumentLocation ?? DEFAULT_SETTINGS.rightDocumentLocation,
    };
  }

  async saveSettings(): Promise<void> {
    this.settings.archiveFolder = this.normalizeArchiveFolder(this.settings.archiveFolder);
    this.settings.rightDocumentLocation = this.isRightDocumentLocation(this.settings.rightDocumentLocation)
      ? this.settings.rightDocumentLocation
      : DEFAULT_SETTINGS.rightDocumentLocation;
    await this.saveData(this.settings);
    this.updateArchiveFolderStyles();
  }

  private addArchiveMenuItem(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile || file instanceof TFolder) || file.path === "/") {
      return;
    }

    const isArchived = this.isArchivePath(file.path);
    if (file.path === this.getArchiveFolderPath()) {
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle(isArchived ? "PageMode: Unarchive" : "PageMode: Archive")
        .setIcon(isArchived ? "archive-restore" : "archive")
        .setSection("open")
        .onClick(() => {
          void (isArchived ? this.unarchiveAbstractFile(file) : this.archiveAbstractFile(file));
        });
    });
  }

  private normalizeArchiveFolder(value: unknown): string {
    const rawValue = typeof value === "string" ? value.trim() : DEFAULT_SETTINGS.archiveFolder;
    const normalizedPath = normalizePath(rawValue).replace(/^\/+|\/+$/g, "");

    if (!normalizedPath || normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) {
      return DEFAULT_SETTINGS.archiveFolder;
    }

    return normalizedPath;
  }

  private updateArchiveFolderStyles(): void {
    if (!this.archiveFolderStyleEl) {
      this.archiveFolderStyleEl = activeDocument.createElement("style");
      this.archiveFolderStyleEl.setAttr("data-pagemode-archive-folder", "");
      activeDocument.head.appendChild(this.archiveFolderStyleEl);
    }

    if (this.settings.showArchiveFolder) {
      this.archiveFolderStyleEl.textContent = "";
      return;
    }

    const archiveFolderPath = this.getArchiveFolderPath();
    const dataPath = this.getCssString(archiveFolderPath);
    this.archiveFolderStyleEl.textContent = `.workspace-leaf-content[data-type="file-explorer"] .nav-folder:has(> .nav-folder-title[data-path=${dataPath}]) {
  display: none !important;
}
`;
  }

  private getCssString(value: string): string {
    return JSON.stringify(value);
  }

  private handleDragStart(event: DragEvent): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const target = event.targetNode;
    if (!view?.file || view.getMode() !== "source" || !target || !view.containerEl.contains(target)) {
      this.draggedEditorSelection = null;
      return;
    }

    const ranges = this.getSelectedEditorRanges(view.editor);
    if (ranges.length === 0) {
      this.draggedEditorSelection = null;
      return;
    }

    this.draggedEditorSelection = {
      editor: view.editor,
      sourceFile: view.file,
      ranges,
    };
  }

  private handleEditorDrop(event: DragEvent, targetEditor: Editor, targetFile: TFile | null): void {
    const draggedSelection = this.draggedEditorSelection;
    this.draggedEditorSelection = null;

    if (
      !draggedSelection ||
      event.ctrlKey ||
      event.metaKey ||
      !targetFile ||
      !PageModePlugin.isMarkdownFile(targetFile) ||
      targetFile.path === draggedSelection.sourceFile.path ||
      targetEditor === draggedSelection.editor
    ) {
      return;
    }

    const targetValueBeforeDrop = targetEditor.getValue();

    window.setTimeout(() => {
      if (targetEditor.getValue() === targetValueBeforeDrop) {
        return;
      }

      if (!this.areEditorRangesUnchanged(draggedSelection.editor, draggedSelection.ranges)) {
        return;
      }

      this.deleteEditorRanges(draggedSelection.editor, draggedSelection.ranges);
    }, 0);
  }

  private addSendToRightDocumentMenuItem(menu: Menu, editor: Editor, sourceFile: TFile | null): void {
    const sourceView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!(sourceView instanceof MarkdownView) || sourceView.getMode() !== "source" || !sourceFile) {
      return;
    }

    const ranges = this.getSelectedEditorRanges(editor);
    if (!PageModePlugin.isMarkdownFile(sourceFile)) {
      return;
    }

    const title =
      ranges.length > 0
        ? "Send selection to right document"
        : "Send current file to right document";

    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle(title).setIcon("panel-left-open").onClick(() => {
        void this.extractSelectionToRightDocument(editor, sourceFile, sourceView);
      });
    });
  }

  private addMarkdownViewActions(): void {
    if (this.unloaded) {
      return;
    }

    const navigationFiles = this.getMarkdownFilesInNavigationOrder();

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        return;
      }

      this.addFilePositionBarToMarkdownView(view, navigationFiles);

      if (!this.markdownActionViews.has(view)) {
        const actionEl = view.addAction("panel-left-open", "Send selection or file to right document", () => {
          void this.extractSelectionToRightDocumentFromView(view);
        });
        actionEl.setAttr("data-pagemode-markdown-action", "");
        this.markdownActionEls.add(actionEl);
        this.markdownActionViews.add(view);
      }
    });
  }

  private scheduleFilePositionBarUpdate(): void {
    if (this.filePositionUpdateFrame !== null) {
      return;
    }

    this.filePositionUpdateFrame = activeWindow.requestAnimationFrame(() => {
      this.filePositionUpdateFrame = null;
      this.updateFilePositionBars();
    });
  }

  private updateFilePositionBars(): void {
    const navigationFiles = this.getMarkdownFilesInNavigationOrder();

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        this.updateFilePositionBar(view, navigationFiles);
      }
    });
  }

  private getNavigationPathText(file: TFile): string {
    return file.path.replace(/\.md$/i, "").split("/").join(" / ");
  }

  private addFilePositionBarToMarkdownView(view: MarkdownView, navigationFiles: TFile[]): void {
    this.ensureFilePositionStyles();

    let barEl = this.filePositionBarEls.get(view);
    let thumbEl = barEl?.querySelector<HTMLElement>(`.${FILE_POSITION_THUMB_CLASS}`) ?? null;
    if (!barEl || !thumbEl || !view.contentEl.contains(barEl)) {
      barEl = activeDocument.createElement("div");
      barEl.addClass(FILE_POSITION_BAR_CLASS);
      barEl.setAttr("data-pagemode-file-position-bar", "");

      thumbEl = activeDocument.createElement("div");
      thumbEl.addClass(FILE_POSITION_THUMB_CLASS);
      barEl.appendChild(thumbEl);

      view.contentEl.appendChild(barEl);
      this.filePositionBarEls.set(view, barEl);
    }

    view.contentEl.addClass(FILE_POSITION_CONTAINER_CLASS);
    this.updateFilePositionBar(view, navigationFiles);
  }

  private updateFilePositionBar(view: MarkdownView, navigationFiles: TFile[]): void {
    const barEl = this.filePositionBarEls.get(view);
    const thumbEl = barEl?.querySelector<HTMLElement>(`.${FILE_POSITION_THUMB_CLASS}`) ?? null;
    const scrollContext = this.getPageScrollContext(view);
    if (!barEl || !thumbEl || !view.file || !scrollContext) {
      barEl?.addClass("is-hidden");
      return;
    }

    const position = view.file ? this.getMarkdownFileNavigationPosition(view.file, navigationFiles) : null;
    barEl.toggleClass("is-hidden", position === null);
    if (!position) {
      return;
    }

    this.alignFilePositionBarToScrollArea(view, barEl, scrollContext);
    const thumbHeight = this.getFilePositionThumbHeightPx(barEl, position.total);
    const top = this.getFilePositionThumbTopPx(barEl, position, thumbHeight);
    thumbEl.style.height = `${thumbHeight}px`;
    thumbEl.style.top = `${top}px`;
    barEl.setAttr("title", `${position.index + 1} / ${position.total} ${this.getNavigationPathText(view.file)}`);
  }

  private alignFilePositionBarToScrollArea(
    view: MarkdownView,
    barEl: HTMLElement,
    scrollContext: PageScrollContext,
  ): void {
    const contentRect = view.contentEl.getBoundingClientRect();
    const scrollRect = scrollContext.scrollEl.getBoundingClientRect();
    const barWidth = this.getFilePositionBarWidthPx(scrollContext);
    barEl.style.top = `${Math.max(0, Math.round(scrollRect.top - contentRect.top))}px`;
    barEl.style.height = `${Math.max(0, Math.round(scrollRect.height))}px`;
    barEl.style.width = `${barWidth}px`;
  }

  private getFilePositionBarWidthPx(scrollContext: PageScrollContext): number {
    const scrollRect = scrollContext.scrollEl.getBoundingClientRect();
    const contentRect = scrollContext.contentEl.getBoundingClientRect();
    const leftMargin = Math.max(0, Math.round(contentRect.left - scrollRect.left));
    return this.clampNumber(
      leftMargin - FILE_POSITION_BAR_MARGIN_GAP_PX,
      FILE_POSITION_BAR_MIN_WIDTH_PX,
      FILE_POSITION_BAR_MAX_WIDTH_PX,
    );
  }

  private handleMouseMove(event: MouseEvent): void {
    const target = activeDocument.elementFromPoint(event.clientX, event.clientY);
    if (!target) {
      this.setActiveFilePositionBar(null);
      return;
    }

    const view = this.getMarkdownViewForWheelTarget(target);
    if (
      !view ||
      !this.isMainWorkspaceView(view) ||
      !this.isTargetInWorkspaceTab(target, view) ||
      !this.isFilePositionBarPoint(event, view) ||
      this.isDocumentControlTarget(target, view)
    ) {
      this.setActiveFilePositionBar(null);
      return;
    }

    this.setActiveFilePositionBar(this.filePositionBarEls.get(view) ?? null);
  }

  private setActiveFilePositionBar(barEl: HTMLElement | null): void {
    if (this.activeFilePositionBarEl === barEl) {
      return;
    }

    this.activeFilePositionBarEl?.removeClass(FILE_POSITION_BAR_ACTIVE_CLASS);
    this.activeFilePositionBarEl = barEl;
    this.activeFilePositionBarEl?.addClass(FILE_POSITION_BAR_ACTIVE_CLASS);
  }

  private isFilePositionBarArea(event: MouseEvent, target: Node, view: MarkdownView): boolean {
    return this.isFilePositionBarPoint(event, view) && !this.isDocumentControlTarget(target, view);
  }

  private isFilePositionBarPoint(event: MouseEvent, view: MarkdownView): boolean {
    const barEl = this.filePositionBarEls.get(view);
    if (!barEl || barEl.hasClass("is-hidden")) {
      return false;
    }

    const rect = barEl.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }

  private isDocumentControlTarget(target: Node, view: MarkdownView): boolean {
    if (!target.instanceOf(Element)) {
      return false;
    }

    const controlEl = target.closest(DOCUMENT_CONTROL_SELECTOR);
    return controlEl !== null && view.containerEl.contains(controlEl);
  }

  private getFilePositionThumbHeightPx(barEl: HTMLElement, total: number): number {
    const availableHeight = this.getFilePositionTrackHeightPx(barEl);
    if (availableHeight <= 0 || total <= 0) {
      return FILE_POSITION_THUMB_MIN_HEIGHT_PX;
    }

    return Math.max(FILE_POSITION_THUMB_MIN_HEIGHT_PX, Math.round(availableHeight / total));
  }

  private getFilePositionThumbTopPx(
    barEl: HTMLElement,
    position: FileNavigationPosition,
    thumbHeight: number,
  ): number {
    const height = barEl.clientHeight;
    if (height <= 0) {
      return FILE_POSITION_BAR_VERTICAL_PADDING_PX;
    }

    const ratio = position.total <= 1 ? 0.5 : position.index / (position.total - 1);
    const minTop = FILE_POSITION_BAR_VERTICAL_PADDING_PX;
    const maxTop = Math.max(minTop, height - FILE_POSITION_BAR_VERTICAL_PADDING_PX - thumbHeight);
    return Math.round(minTop + (maxTop - minTop) * ratio);
  }

  private getFilePositionTrackHeightPx(barEl: HTMLElement): number {
    return Math.max(0, barEl.clientHeight - FILE_POSITION_BAR_VERTICAL_PADDING_PX * 2);
  }

  private clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getMarkdownFileNavigationPosition(file: TFile, navigationFiles: TFile[]): FileNavigationPosition | null {
    const index = navigationFiles.findIndex((candidate) => candidate.path === file.path);
    return index >= 0 ? { index, total: navigationFiles.length } : null;
  }

  private ensureFilePositionStyles(): void {
    if (!this.filePositionStyleEl) {
      this.filePositionStyleEl = activeDocument.createElement("style");
      this.filePositionStyleEl.setAttr("data-pagemode-file-position-styles", "");
      activeDocument.head.appendChild(this.filePositionStyleEl);
    }

    this.filePositionStyleEl.textContent = `
.${FILE_POSITION_CONTAINER_CLASS} {
  position: relative;
}

.${FILE_POSITION_BAR_CLASS} {
  background: transparent;
  box-sizing: border-box;
  cursor: default;
  left: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  width: ${FILE_POSITION_BAR_MAX_WIDTH_PX}px;
  z-index: 5;
}

.${FILE_POSITION_BAR_CLASS}::before {
  display: none;
}

.${FILE_POSITION_THUMB_CLASS} {
  background: var(--interactive-accent);
  height: ${FILE_POSITION_THUMB_MIN_HEIGHT_PX}px;
  left: ${FILE_POSITION_THUMB_LEFT_PX}px;
  position: absolute;
  width: min(${FILE_POSITION_THUMB_MAX_WIDTH_PX}px, calc(100% - ${FILE_POSITION_THUMB_LEFT_PX}px));
}

.${FILE_POSITION_BAR_CLASS}:not(.${FILE_POSITION_BAR_ACTIVE_CLASS}) .${FILE_POSITION_THUMB_CLASS} {
  opacity: 0;
}

.${FILE_POSITION_BAR_CLASS}.is-hidden {
  display: none;
}
`;
  }

  private canSendToRightDocument(sourceFile: TFile | null): sourceFile is TFile {
    const sourceView = this.app.workspace.getActiveViewOfType(MarkdownView);
    return (
      sourceView instanceof MarkdownView &&
      sourceView.getMode() === "source" &&
      sourceFile !== null &&
      PageModePlugin.isMarkdownFile(sourceFile)
    );
  }

  private async extractSelectionToRightDocumentCommand(editor: Editor, sourceFile: TFile | null): Promise<void> {
    const sourceView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!(sourceView instanceof MarkdownView) || sourceView.getMode() !== "source") {
      new Notice("Switch to editing view to extract selected text.");
      return;
    }

    if (!sourceFile || !PageModePlugin.isMarkdownFile(sourceFile)) {
      new Notice("No active Markdown file.");
      return;
    }

    await this.extractSelectionToRightDocument(editor, sourceFile, sourceView);
  }

  private async extractSelectionToRightDocumentFromView(sourceView: MarkdownView): Promise<void> {
    if (sourceView.getMode() !== "source") {
      new Notice("Switch to editing view to extract selected text.");
      return;
    }

    if (!sourceView.file || !PageModePlugin.isMarkdownFile(sourceView.file)) {
      new Notice("No active Markdown file.");
      return;
    }

    await this.extractSelectionToRightDocument(sourceView.editor, sourceView.file, sourceView);
  }

  private async extractSelectionToRightDocument(
    editor: Editor,
    sourceFile: TFile,
    sourceView: MarkdownView,
  ): Promise<void> {
    const ranges = this.getSelectedEditorRanges(editor);
    const targetFile = await this.getOrCreateRightMarkdownTarget(sourceView, sourceFile);
    if (!targetFile) {
      new Notice("No Markdown document available on the right.");
      return;
    }

    if (ranges.length === 0) {
      await this.moveWholeFileToRightDocument(sourceView.leaf, sourceFile, editor.getValue(), targetFile);
      return;
    }

    await this.extractSelectionToMarkdownFile(editor, ranges, targetFile);
  }

  private async getOrCreateRightMarkdownTarget(
    sourceView: MarkdownView,
    sourceFile: TFile,
  ): Promise<TFile | null> {
    const existingTarget = this.getNearestRightMarkdownTarget(sourceView, sourceFile);
    if (existingTarget) {
      return existingTarget.file;
    }

    let file: TFile | null = null;
    let target: MarkdownLeafTarget | null = null;
    try {
      target = this.getOrCreateRightMarkdownLeafTarget(sourceView);
      file = await this.createRootMarkdownFile();
      await target.leaf.openFile(file, { active: false });
      return file;
    } catch (error) {
      if (target?.detachOnFailure) {
        target.leaf.detach();
      }
      if (file) {
        try {
          await this.app.fileManager.trashFile(file);
        } catch (cleanupError) {
          console.error("Failed to clean up right Markdown document", cleanupError);
        }
      }
      console.error("Failed to create right Markdown document", error);
      new Notice("Failed to create a right document.");
      return null;
    }
  }

  private getOrCreateRightMarkdownLeafTarget(sourceView: MarkdownView): MarkdownLeafTarget {
    const emptyTarget = this.getNearestRightEmptyMarkdownLeafTarget(sourceView);
    if (emptyTarget) {
      return emptyTarget;
    }

    if (this.settings.rightDocumentLocation === "right-sidebar") {
      return this.getOrCreateRightSidebarMarkdownLeafTarget();
    }

    return {
      leaf: this.app.workspace.createLeafBySplit(sourceView.leaf, "vertical", false),
      detachOnFailure: true,
    };
  }

  private getOrCreateRightSidebarMarkdownLeafTarget(): MarkdownLeafTarget {
    const existingLeaf = this.app.workspace.getRightLeaf(false);
    if (existingLeaf?.view.getViewType() === "empty") {
      return {
        leaf: existingLeaf,
        detachOnFailure: false,
      };
    }

    const leaf = this.app.workspace.getRightLeaf(true) ?? existingLeaf;
    if (!leaf) {
      throw new Error("No right sidebar leaf available.");
    }

    return {
      leaf,
      detachOnFailure: leaf !== existingLeaf,
    };
  }

  private getNearestRightEmptyMarkdownLeafTarget(sourceView: MarkdownView): MarkdownLeafTarget | null {
    const sourceRect = this.getVisibleViewRect(sourceView);
    if (!sourceRect) {
      return null;
    }

    const sourceCenterX = this.getRectCenterX(sourceRect);
    const candidates: Array<{ leaf: WorkspaceLeaf; distance: number }> = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === sourceView.leaf || leaf.view.getViewType() !== "empty") {
        return;
      }

      const containerEl = leaf.view.containerEl;
      if (!this.isMainWorkspaceTarget(containerEl)) {
        return;
      }

      const targetRect = containerEl.getBoundingClientRect();
      if (targetRect.width === 0 || targetRect.height === 0 || this.getRectCenterX(targetRect) <= sourceCenterX + LINE_BOUNDARY_EPSILON_PX) {
        return;
      }

      const horizontalGap = Math.max(0, targetRect.left - sourceRect.right);
      const verticalGap = this.getVerticalGap(sourceRect, targetRect);
      candidates.push({
        leaf,
        distance: horizontalGap * horizontalGap + verticalGap * verticalGap,
      });
    });

    const target = candidates.sort((a, b) => a.distance - b.distance)[0];
    return target ? { leaf: target.leaf, detachOnFailure: false } : null;
  }

  private async createRootMarkdownFile(): Promise<TFile> {
    const root = this.app.vault.getRoot();
    const path = this.getAvailableFilePath(root, "Untitled.md");
    return this.app.vault.create(path, "");
  }

  private async moveWholeFileToRightDocument(
    sourceLeaf: WorkspaceLeaf,
    sourceFile: TFile,
    sourceContent: string,
    targetFile: TFile,
  ): Promise<void> {
    try {
      await this.appendTextToFile(targetFile, this.getWholeFileExtractedText(sourceFile, sourceContent));
    } catch (error) {
      console.error("Failed to append whole file to right document", error);
      new Notice("Failed to copy file content to right document.");
      return;
    }

    await this.clearAndFocusSourceLeaf(sourceLeaf);

    try {
      await this.app.fileManager.trashFile(sourceFile);
    } catch (error) {
      console.error("Failed to trash source file after copying to right document", error);
      new Notice("Copied to right document, but failed to delete the source file.");
      this.focusWorkspaceLeaf(sourceLeaf);
      return;
    }

    this.focusWorkspaceLeaf(sourceLeaf);
    new Notice(`Moved ${sourceFile.basename} to ${targetFile.basename}.`);
  }

  private async clearAndFocusSourceLeaf(sourceLeaf: WorkspaceLeaf): Promise<void> {
    try {
      await sourceLeaf.setViewState({ type: "empty", active: true });
    } catch (error) {
      console.error("Failed to clear source tab after moving file", error);
    }

    this.focusWorkspaceLeaf(sourceLeaf);
  }

  private focusWorkspaceLeaf(leaf: WorkspaceLeaf): void {
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    activeWindow.requestAnimationFrame(() => {
      if (!this.unloaded) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
    });
  }

  private getWholeFileExtractedText(file: TFile, content: string): string {
    const body = this.trimBoundaryNewlines(content);
    if (!body) {
      return `# ${file.basename}`;
    }

    return `# ${file.basename}\n\n${body}`;
  }

  private async extractSelectionToMarkdownFile(editor: Editor, ranges: SelectedEditorRange[], targetFile: TFile): Promise<void> {
    if (!this.areEditorRangesUnchanged(editor, ranges)) {
      new Notice("Selection changed before extraction.");
      return;
    }

    const extractedText = this.getExtractedText(ranges);
    if (!extractedText) {
      new Notice("No selected text to extract.");
      return;
    }

    try {
      await this.appendTextToFile(targetFile, extractedText);
      this.deleteEditorRanges(editor, ranges);
      new Notice(`Extracted to ${targetFile.basename}.`);
    } catch (error) {
      console.error("Failed to extract selection", error);
      new Notice("Failed to extract selection.");
    }
  }

  private getNearestRightMarkdownTarget(sourceView: MarkdownView, sourceFile: TFile): MarkdownViewTarget | null {
    const sourceRect = this.getVisibleViewRect(sourceView);
    if (!sourceRect) {
      return null;
    }

    const sourceCenterX = this.getRectCenterX(sourceRect);
    const targets: MarkdownViewTarget[] = [];

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (
        !(view instanceof MarkdownView) ||
        view === sourceView ||
        !view.file ||
        !PageModePlugin.isMarkdownFile(view.file) ||
        view.file.path === sourceFile.path
      ) {
        return;
      }

      const targetRect = this.getVisibleViewRect(view);
      if (!targetRect || this.getRectCenterX(targetRect) <= sourceCenterX + LINE_BOUNDARY_EPSILON_PX) {
        return;
      }

      const horizontalGap = Math.max(0, targetRect.left - sourceRect.right);
      const verticalGap = this.getVerticalGap(sourceRect, targetRect);
      targets.push({
        file: view.file,
        displayName: view.file.basename,
        distance: horizontalGap * horizontalGap + verticalGap * verticalGap,
      });
    });

    return targets.sort((a, b) => a.distance - b.distance || this.collator.compare(a.displayName, b.displayName))[0] ?? null;
  }

  private getVisibleViewRect(view: MarkdownView): DOMRect | null {
    const rect = view.containerEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    return rect;
  }

  private getRectCenterX(rect: DOMRect): number {
    return rect.left + rect.width / 2;
  }

  private getVerticalGap(a: DOMRect, b: DOMRect): number {
    if (b.bottom < a.top) {
      return a.top - b.bottom;
    }

    if (b.top > a.bottom) {
      return b.top - a.bottom;
    }

    return 0;
  }

  private getSelectedEditorRanges(editor: Editor): SelectedEditorRange[] {
    return editor
      .listSelections()
      .map((selection) => this.normalizeSelectedEditorRange(editor, selection.anchor, selection.head))
      .filter((range): range is SelectedEditorRange => range !== null)
      .sort((a, b) => this.compareEditorPositions(a.from, b.from));
  }

  private normalizeSelectedEditorRange(
    editor: Editor,
    anchor: EditorPosition,
    head: EditorPosition,
  ): SelectedEditorRange | null {
    if (this.compareEditorPositions(anchor, head) === 0) {
      return null;
    }

    const from = this.compareEditorPositions(anchor, head) < 0 ? anchor : head;
    const to = from === anchor ? head : anchor;
    const text = editor.getRange(from, to);

    if (text.length === 0) {
      return null;
    }

    return { from, to, text };
  }

  private compareEditorPositions(a: EditorPosition, b: EditorPosition): number {
    return a.line - b.line || a.ch - b.ch;
  }

  private areEditorRangesUnchanged(editor: Editor, ranges: SelectedEditorRange[]): boolean {
    return ranges.every((range) => editor.getRange(range.from, range.to) === range.text);
  }

  private deleteEditorRanges(editor: Editor, ranges: SelectedEditorRange[]): void {
    const changes = [...ranges]
      .sort((a, b) => this.compareEditorPositions(b.from, a.from))
      .map((range) => ({
        from: range.from,
        to: range.to,
        text: "",
      }));

    editor.transaction({ changes }, "pagemode-extract-selection");
  }

  private getExtractedText(ranges: SelectedEditorRange[]): string {
    return ranges.map((range) => this.trimBoundaryNewlines(range.text)).filter(Boolean).join("\n\n");
  }

  private trimBoundaryNewlines(text: string): string {
    return text.replace(/^\n+|\n+$/g, "");
  }

  private async appendTextToFile(file: TFile, text: string): Promise<void> {
    await this.app.vault.process(file, (content) => {
      if (content.length === 0) {
        return text;
      }

      if (content.endsWith("\n\n")) {
        return `${content}${text}`;
      }

      if (content.endsWith("\n")) {
        return `${content}\n${text}`;
      }

      return `${content}\n\n${text}`;
    });
  }

  private async handleWheel(event: WheelEvent): Promise<void> {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }

    const direction = Math.sign(event.deltaY);
    if (direction === 0) {
      return;
    }

    const target = this.getWheelEventTarget(event);
    if (!target) {
      return;
    }

    const view = this.getMarkdownViewForWheelTarget(target);
    if (!view) {
      await this.handleWheelWithoutActiveFile(event, target, direction);
      return;
    }

    const mode = view.getMode();
    if (mode !== "preview" && mode !== "source") {
      return;
    }

    if (!this.isMainWorkspaceView(view)) {
      return;
    }

    if (!this.isTargetInWorkspaceTab(target, view)) {
      return;
    }

    if (this.isFilePositionBarArea(event, target, view)) {
      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForWheel(view, direction > 0 ? 1 : -1);
      return;
    }

    if (this.isAdjacentFileNavigationTarget(target, view)) {
      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForWheel(view, direction > 0 ? 1 : -1);
      return;
    }

    const scrollContext = this.getPageScrollContext(view);
    if (!scrollContext) {
      return;
    }

    if (!scrollContext.scrollEl.contains(target)) {
      return;
    }

    if (this.isInlineTitleArea(event, view, scrollContext)) {
      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForWheel(view, direction > 0 ? 1 : -1);
      return;
    }

    if (!this.settings.pageUnitScroll) {
      return;
    }

    const { scrollEl, contentEl } = scrollContext;
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const shouldOpenNextFile = direction > 0 && this.isNearScrollBottom(scrollEl);
    const shouldOpenPreviousFile = direction < 0 && this.isNearScrollTop(scrollEl);

    if (shouldOpenNextFile) {
      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForWheel(view, 1);
      return;
    }

    if (shouldOpenPreviousFile) {
      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForWheel(view, -1);
      return;
    }

    this.consumeWheelEvent(event);

    const nextTop = this.getNextPageTop(scrollEl, contentEl, direction, maxScrollTop);
    scrollEl.scrollTo({
      top: nextTop,
      behavior: "auto",
    });
  }

  private isMainWorkspaceView(view: MarkdownView): boolean {
    return this.isMainWorkspaceTarget(view.containerEl);
  }

  private getWheelEventTarget(event: WheelEvent): Node | null {
    return event.doc.elementFromPoint(event.clientX, event.clientY) ?? event.targetNode;
  }

  private consumeWheelEvent(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private getMarkdownViewForWheelTarget(target: Node): MarkdownView | null {
    const leaf = this.getWorkspaceLeafForTarget(target);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  private getWorkspaceLeafForTarget(target: Node): WorkspaceLeaf | null {
    const targetEl = target.instanceOf(Element) ? target : target.parentElement;
    const targetTabsEl = targetEl?.closest(".workspace-tabs") ?? null;
    let matchedLeaf: WorkspaceLeaf | null = null;
    let fallbackLeaf: WorkspaceLeaf | null = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (matchedLeaf) {
        return;
      }

      const { containerEl } = leaf.view;
      if (containerEl.contains(target)) {
        matchedLeaf = leaf;
        return;
      }

      if (targetTabsEl && containerEl.closest(".workspace-tabs") === targetTabsEl) {
        const leafEl = containerEl.closest(".workspace-leaf");
        if (this.isVisibleWorkspaceLeafContainer(containerEl) || leafEl?.hasClass("mod-active")) {
          matchedLeaf = leaf;
          return;
        }

        fallbackLeaf ??= leaf;
      }
    });

    return matchedLeaf ?? fallbackLeaf;
  }

  private isVisibleWorkspaceLeafContainer(containerEl: HTMLElement): boolean {
    const rect = containerEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private isTargetInWorkspaceTab(target: Node, view: MarkdownView): boolean {
    if (!target.instanceOf(Element)) {
      return view.containerEl.contains(target);
    }

    const viewTabsEl = view.containerEl.closest(".workspace-tabs");
    return viewTabsEl !== null && target.closest(".workspace-tabs") === viewTabsEl;
  }

  private isAdjacentFileNavigationTarget(target: Node, view: MarkdownView): boolean {
    if (!target.instanceOf(Element)) {
      return false;
    }

    if (this.isInlineTitleTarget(target)) {
      return true;
    }

    if (this.isFilePositionBarTarget(target)) {
      return true;
    }

    if (!this.isTargetInWorkspaceTab(target, view)) {
      return false;
    }

    const tabHeaderEl = target.closest(".workspace-tab-header");
    if (tabHeaderEl) {
      return tabHeaderEl.hasClass("is-active");
    }

    return target.closest(".workspace-tab-header-container, .view-header") !== null;
  }

  private isInlineTitleArea(event: WheelEvent, view: MarkdownView, scrollContext: PageScrollContext): boolean {
    const inlineTitleEl = view.containerEl.querySelector<HTMLElement>(".inline-title");
    if (!inlineTitleEl) {
      return false;
    }

    const scrollRect = scrollContext.scrollEl.getBoundingClientRect();
    const titleRect = inlineTitleEl.getBoundingClientRect();
    return (
      event.clientY >= scrollRect.top &&
      event.clientY <= titleRect.bottom + INLINE_TITLE_AREA_PADDING_PX &&
      event.clientX >= scrollRect.left &&
      event.clientX <= scrollRect.right
    );
  }

  private getPageScrollContext(view: MarkdownView): PageScrollContext | null {
    if (view.getMode() === "preview") {
      const previewEl = view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
      return previewEl ? { scrollEl: previewEl, contentEl: previewEl } : null;
    }

    const sourceScrollEl = view.containerEl.querySelector<HTMLElement>(".cm-scroller");
    if (!sourceScrollEl) {
      return null;
    }

    return {
      scrollEl: sourceScrollEl,
      contentEl: sourceScrollEl.querySelector<HTMLElement>(".cm-content") ?? sourceScrollEl,
    };
  }

  private isInlineTitleTarget(target: Node): boolean {
    return target.instanceOf(Element) && target.closest(".inline-title") !== null;
  }

  private isFilePositionBarTarget(target: Node): boolean {
    return target.instanceOf(Element) && target.closest("[data-pagemode-file-position-bar]") !== null;
  }

  private isNearScrollTop(scrollEl: HTMLElement): boolean {
    return scrollEl.scrollTop <= SCROLL_EDGE_TOLERANCE_PX;
  }

  private isNearScrollBottom(scrollEl: HTMLElement): boolean {
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    return scrollEl.scrollTop + SCROLL_EDGE_TOLERANCE_PX >= maxScrollTop;
  }

  private async handleWheelWithoutActiveFile(event: WheelEvent, target: Node, direction: number): Promise<void> {
    if (!this.isHTMLElement(target) || !this.isMainWorkspaceTarget(target)) {
      return;
    }

    const leaf = this.getWorkspaceLeafForTarget(target);
    if (!leaf || leaf.view.getViewType() !== "empty") {
      return;
    }

    this.consumeWheelEvent(event);
    if (!this.openingFile) {
      await this.openBoundaryMarkdownFileInLeaf(leaf, direction > 0 ? 1 : -1, false);
    }
  }

  private isMainWorkspaceTarget(target: HTMLElement): boolean {
    return target.closest(".workspace-split.mod-root") !== null && target.closest(".workspace-sidedock") === null;
  }

  private getNextPageTop(
    scrollEl: HTMLElement,
    contentEl: HTMLElement,
    direction: number,
    maxScrollTop: number,
  ): number {
    const currentTop = scrollEl.scrollTop;
    const pageHeight = scrollEl.clientHeight;
    const fallbackTop =
      direction > 0 ? Math.min(maxScrollTop, currentTop + pageHeight) : Math.max(0, currentTop - pageHeight);
    const targetBoundary = direction > 0 ? currentTop + pageHeight : currentTop - pageHeight;
    const searchBand =
      direction > 0
        ? {
            top: targetBoundary - LINE_BOUNDARY_EPSILON_PX,
            bottom: Math.min(scrollEl.scrollHeight, targetBoundary + pageHeight),
          }
        : {
            top: Math.max(0, targetBoundary),
            bottom: currentTop - MIN_PAGE_ADVANCE_PX,
          };
    const lineRects = this.getContentLineRects(scrollEl, contentEl, searchBand);

    if (lineRects.length === 0) {
      return fallbackTop;
    }

    const targetLine =
      direction > 0
        ? lineRects.find((lineRect) => lineRect.bottom > targetBoundary + LINE_BOUNDARY_EPSILON_PX)
        : lineRects.find(
            (lineRect) =>
              lineRect.bottom > targetBoundary + LINE_BOUNDARY_EPSILON_PX &&
              lineRect.top < currentTop - MIN_PAGE_ADVANCE_PX,
          );

    if (!targetLine) {
      return fallbackTop;
    }

    const nextTop = this.clampScrollTop(targetLine.top, maxScrollTop);

    if (direction > 0 && nextTop <= currentTop + MIN_PAGE_ADVANCE_PX) {
      return fallbackTop;
    }

    if (direction < 0 && nextTop >= currentTop - MIN_PAGE_ADVANCE_PX) {
      return fallbackTop;
    }

    return nextTop;
  }

  private getContentLineRects(
    scrollEl: HTMLElement,
    contentEl: HTMLElement,
    searchBand: ScrollBand,
  ): ContentLineRect[] {
    const scrollRect = scrollEl.getBoundingClientRect();
    const lineRects: ContentLineRect[] = [];
    const range = scrollEl.doc.createRange();

    try {
      this.collectContentLineRects(scrollEl, contentEl, searchBand, scrollRect, range, lineRects);
    } finally {
      range.detach();
    }

    return this.mergeLineRects(lineRects);
  }

  private collectContentLineRects(
    scrollEl: HTMLElement,
    node: Node,
    searchBand: ScrollBand,
    scrollRect: DOMRect,
    range: Range,
    lineRects: ContentLineRect[],
  ): void {
    if (node.instanceOf(HTMLElement)) {
      if (node !== scrollEl) {
        if (node.closest("style, script")) {
          return;
        }

        const nodeRect = this.getScrollRelativeRect(scrollEl, scrollRect, node.getBoundingClientRect());
        if (!this.intersectsScrollBand(nodeRect, searchBand)) {
          return;
        }
      }

      for (const childNode of Array.from(node.childNodes)) {
        this.collectContentLineRects(scrollEl, childNode, searchBand, scrollRect, range, lineRects);
      }

      return;
    }

    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) {
      return;
    }

    range.selectNodeContents(node);

    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      const lineRect = this.getScrollRelativeRect(scrollEl, scrollRect, rect);
      if (!this.intersectsScrollBand(lineRect, searchBand)) {
        continue;
      }

      lineRects.push(lineRect);
    }
  }

  private mergeLineRects(lineRects: ContentLineRect[]): ContentLineRect[] {
    const mergedLineRects: ContentLineRect[] = [];

    lineRects.sort((a, b) => a.top - b.top || a.bottom - b.bottom);

    for (const lineRect of lineRects) {
      const previousLineRect = mergedLineRects[mergedLineRects.length - 1];
      if (previousLineRect && Math.abs(previousLineRect.top - lineRect.top) <= LINE_BOUNDARY_EPSILON_PX) {
        previousLineRect.top = Math.min(previousLineRect.top, lineRect.top);
        previousLineRect.bottom = Math.max(previousLineRect.bottom, lineRect.bottom);
        continue;
      }

      mergedLineRects.push({ ...lineRect });
    }

    return mergedLineRects;
  }

  private getScrollRelativeRect(scrollEl: HTMLElement, scrollRect: DOMRect, rect: DOMRect): ContentLineRect {
    return {
      top: scrollEl.scrollTop + rect.top - scrollRect.top,
      bottom: scrollEl.scrollTop + rect.bottom - scrollRect.top,
    };
  }

  private intersectsScrollBand(rect: ContentLineRect, searchBand: ScrollBand): boolean {
    return (
      rect.bottom > searchBand.top + LINE_BOUNDARY_EPSILON_PX &&
      rect.top < searchBand.bottom - LINE_BOUNDARY_EPSILON_PX
    );
  }

  private clampScrollTop(scrollTop: number, maxScrollTop: number): number {
    return Math.max(0, Math.min(maxScrollTop, scrollTop));
  }

  private async openNextMarkdownFile(showNotice: boolean): Promise<void> {
    await this.openAdjacentMarkdownFile(1, showNotice);
  }

  private async openPreviousMarkdownFile(showNotice: boolean): Promise<void> {
    await this.openAdjacentMarkdownFile(-1, showNotice);
  }

  private async openBoundaryMarkdownFileInLeaf(
    leaf: WorkspaceLeaf,
    direction: -1 | 1,
    showNotice: boolean,
  ): Promise<void> {
    const files = this.getMarkdownFilesInNavigationOrder();
    const file = direction > 0 ? files[0] : files[files.length - 1];
    if (!file) {
      if (showNotice) {
        new Notice("No Markdown files in the vault.");
      }
      return;
    }

    await this.openMarkdownFileInLeaf(leaf, file, "Failed to open Markdown file");
  }

  private async openAdjacentMarkdownFile(offset: -1 | 1, showNotice: boolean): Promise<void> {
    await this.openAdjacentMarkdownFileInLeaf(
      this.app.workspace.getActiveFile(),
      this.app.workspace.getLeaf(false),
      offset,
      showNotice,
    );
  }

  private async openAdjacentMarkdownFileForView(
    view: MarkdownView,
    offset: -1 | 1,
    showNotice: boolean,
  ): Promise<void> {
    await this.openAdjacentMarkdownFileInLeaf(view.file, view.leaf, offset, showNotice);
  }

  private async openAdjacentMarkdownFileForWheel(view: MarkdownView, offset: -1 | 1): Promise<void> {
    if (this.queuePendingWheelNavigation(view.leaf, offset, false)) {
      return;
    }

    await this.openAdjacentMarkdownFileForView(view, offset, false);
  }

  private queuePendingWheelNavigation(leaf: WorkspaceLeaf, offset: -1 | 1, showNotice: boolean): boolean {
    if (!this.openingFile) {
      return false;
    }

    if (this.openingFileNavigationOffset !== null && offset !== this.openingFileNavigationOffset) {
      this.pendingWheelNavigation = { leaf, offset, showNotice };
    } else {
      this.pendingWheelNavigation = null;
    }

    return true;
  }

  private async flushPendingWheelNavigation(): Promise<void> {
    const pendingNavigation = this.pendingWheelNavigation;
    this.pendingWheelNavigation = null;
    if (!pendingNavigation) {
      return;
    }

    const currentFile = this.getMarkdownFileInLeaf(pendingNavigation.leaf);
    await this.openAdjacentMarkdownFileInLeaf(
      currentFile,
      pendingNavigation.leaf,
      pendingNavigation.offset,
      pendingNavigation.showNotice,
    );
  }

  private getMarkdownFileInLeaf(leaf: WorkspaceLeaf): TFile | null {
    const view = leaf.view;
    return view instanceof MarkdownView ? view.file : null;
  }

  private async openAdjacentMarkdownFileInLeaf(
    currentFile: TFile | null,
    leaf: WorkspaceLeaf,
    offset: -1 | 1,
    showNotice: boolean,
  ): Promise<void> {
    if (!currentFile) {
      if (showNotice) {
        new Notice("No active file.");
      }
      return;
    }

    const adjacentFile = this.getAdjacentMarkdownFile(currentFile, offset);
    if (!adjacentFile) {
      if (showNotice) {
        new Notice(offset > 0 ? "No next Markdown file in the vault." : "No previous Markdown file in the vault.");
      }
      return;
    }

    await this.openMarkdownFileInLeaf(leaf, adjacentFile, "Failed to open adjacent Markdown file", offset);
  }

  private async openMarkdownFileInLeaf(
    leaf: WorkspaceLeaf,
    file: TFile,
    consoleMessage: string,
    navigationOffset: -1 | 1 | null = null,
  ): Promise<void> {
    if (this.openingFile) {
      return;
    }

    this.openingFile = true;
    this.openingFileNavigationOffset = navigationOffset;
    try {
      await leaf.openFile(file, { active: true });
      this.revealFileInFileExplorer(file);
    } catch (error) {
      console.error(consoleMessage, error);
      new Notice("Failed to open Markdown file.");
    } finally {
      this.openingFile = false;
      this.openingFileNavigationOffset = null;
      await this.flushPendingWheelNavigation();
    }
  }

  private getAdjacentMarkdownFile(currentFile: TFile, offset: -1 | 1): TFile | null {
    const files = this.getMarkdownFilesInNavigationOrder();

    const index = files.findIndex((file) => file.path === currentFile.path);
    const adjacentIndex = index + offset;
    if (index < 0 || adjacentIndex < 0 || adjacentIndex >= files.length) {
      return null;
    }

    return files[adjacentIndex];
  }

  private revealFileInFileExplorer(file: TFile): void {
    if (this.syncFileExplorerSelection(file)) {
      return;
    }

    try {
      const result = this.getFileExplorerPluginInstance()?.revealInFolder?.(file);
      if (this.isPromiseLike(result)) {
        void Promise.resolve(result).finally(() => {
          this.scheduleFileExplorerSelectionSync(file);
        });
      }
    } catch (error) {
      console.debug("Failed to reveal file in file explorer", error);
    }

    this.scheduleFileExplorerSelectionSync(file);
  }

  private isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return this.isRecord(value) && typeof value.then === "function";
  }

  private getFileExplorerPluginInstance(): FileExplorerPluginInstance | null {
    const internalPlugins = (this.app as AppWithInternalPlugins).internalPlugins;
    const entry =
      internalPlugins?.getPluginById?.("file-explorer") ?? internalPlugins?.plugins?.["file-explorer"] ?? null;

    return entry?.instance ?? null;
  }

  private scheduleFileExplorerSelectionSync(file: TFile): void {
    const path = file.path;
    const syncIfStillActive = () => {
      if (this.app.workspace.getActiveFile()?.path === path) {
        this.syncFileExplorerSelection(file);
      }
    };

    activeWindow.setTimeout(syncIfStillActive, 0);
    activeWindow.requestAnimationFrame(syncIfStillActive);
  }

  private syncFileExplorerSelection(file: TFile): boolean {
    const explorerEls = Array.from(
      activeDocument.querySelectorAll<HTMLElement>(
        `.workspace-leaf-content[data-type="file-explorer"]`,
      ),
    );
    const targetSelector = `.nav-file-title[data-path=${this.getCssString(file.path)}]`;
    let targetTitleEl: HTMLElement | null = null;

    for (const explorerEl of explorerEls) {
      explorerEl.querySelectorAll<HTMLElement>(".nav-file.is-active, .nav-file-title.is-active").forEach((el) => {
        el.removeClass("is-active");
      });

      const titleEl = explorerEl.querySelector<HTMLElement>(targetSelector);
      if (!titleEl) {
        continue;
      }

      titleEl.addClass("is-active");
      titleEl.closest<HTMLElement>(".nav-file")?.addClass("is-active");
      targetTitleEl = targetTitleEl ?? titleEl;
    }

    if (targetTitleEl) {
      targetTitleEl.scrollIntoView({ block: "nearest" });
      return true;
    }

    return false;
  }

  private getMarkdownFilesInNavigationOrder(): TFile[] {
    return this.getFilesInVaultDfsOrder();
  }

  private getFilesInVaultDfsOrder(): TFile[] {
    const files: TFile[] = [];

    const visitFolder = (folder: TFolder): void => {
      if (this.isArchivePath(folder.path)) {
        return;
      }

      const children = [...folder.children].sort((a, b) => this.compareAbstractFiles(a, b));

      for (const child of children) {
        if (this.isArchivePath(child.path)) {
          continue;
        }

        if (child instanceof TFolder) {
          visitFolder(child);
        } else if (child instanceof TFile && PageModePlugin.isMarkdownFile(child)) {
          files.push(child);
        }
      }
    };

    visitFolder(this.app.vault.getRoot());
    return files;
  }

  private compareAbstractFiles(a: TAbstractFile, b: TAbstractFile): number {
    const aIsFolder = a instanceof TFolder;
    const bIsFolder = b instanceof TFolder;

    if (aIsFolder !== bIsFolder) {
      return aIsFolder ? -1 : 1;
    }

    const nameCompare = this.collator.compare(a.name, b.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return this.collator.compare(a.path, b.path);
  }

  private async archiveAbstractFile(file: TAbstractFile): Promise<void> {
    const archiveFolderPath = this.getArchiveFolderPath();
    if (this.isArchivePath(file.path)) {
      new Notice("The item is already archived.");
      return;
    }

    const destinationPath = this.getAvailableAbstractFilePath(
      normalizePath(`${archiveFolderPath}/${file.path}`),
      file instanceof TFile,
    );
    if (file instanceof TFolder && this.isPathDescendantOf(destinationPath, file.path)) {
      new Notice("Cannot archive a folder into itself.");
      return;
    }

    await this.getOrCreateFolder(this.getParentPath(destinationPath));

    try {
      await this.app.fileManager.renameFile(file, destinationPath);
      new Notice(`Archived to ${destinationPath}.`);
    } catch (error) {
      console.error("Failed to archive item", error);
      new Notice("Failed to archive item.");
    }
  }

  private async unarchiveAbstractFile(file: TAbstractFile): Promise<void> {
    const unarchivedPath = this.getUnarchivedPath(file.path);
    if (!unarchivedPath) {
      new Notice("The item is not archived.");
      return;
    }

    const destinationPath = this.getAvailableAbstractFilePath(unarchivedPath, file instanceof TFile);
    await this.getOrCreateFolder(this.getParentPath(destinationPath));

    try {
      await this.app.fileManager.renameFile(file, destinationPath);
      new Notice(`Unarchived to ${destinationPath}.`);
    } catch (error) {
      console.error("Failed to unarchive item", error);
      new Notice("Failed to unarchive item.");
    }
  }

  private getArchiveFolderPath(): string {
    return this.normalizeArchiveFolder(this.settings.archiveFolder);
  }

  private isArchivePath(path: string): boolean {
    const archiveFolderPath = this.getArchiveFolderPath();
    return path === archiveFolderPath || path.startsWith(`${archiveFolderPath}/`);
  }

  private getUnarchivedPath(path: string): string | null {
    const archiveFolderPath = this.getArchiveFolderPath();
    if (path === archiveFolderPath) {
      return null;
    }

    if (!path.startsWith(`${archiveFolderPath}/`)) {
      return null;
    }

    return normalizePath(path.slice(archiveFolderPath.length + 1));
  }

  private getParentPath(path: string): string {
    const normalizedPath = normalizePath(path);
    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    return lastSlashIndex < 0 ? "" : normalizedPath.slice(0, lastSlashIndex);
  }

  private getAvailableAbstractFilePath(path: string, preserveExtension: boolean): string {
    const normalizedPath = normalizePath(path);
    const parentPath = this.getParentPath(normalizedPath);
    const name = parentPath ? normalizedPath.slice(parentPath.length + 1) : normalizedPath;
    const extensionMatch = preserveExtension ? name.match(/(\.[^.]*)$/) : null;
    const extension = extensionMatch?.[1] ?? "";
    const baseName = extension ? name.slice(0, -extension.length) : name;

    let candidateName = name;
    let candidatePath = this.joinVaultPath(parentPath, candidateName);
    let index = 1;

    while (this.app.vault.getAbstractFileByPath(candidatePath)) {
      candidateName = `${baseName} ${index}${extension}`;
      candidatePath = this.joinVaultPath(parentPath, candidateName);
      index += 1;
    }

    return candidatePath;
  }

  private async getOrCreateFolder(path: string): Promise<TFolder> {
    const normalizedPath = normalizePath(path).replace(/^\/+|\/+$/g, "");
    if (!normalizedPath) {
      return this.app.vault.getRoot();
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`Archive path segment is not a folder: ${currentPath}`);
      }

      await this.app.vault.createFolder(currentPath);
    }

    const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(folder instanceof TFolder)) {
      throw new Error(`Archive folder was not created: ${normalizedPath}`);
    }

    return folder;
  }

  private isPathDescendantOf(path: string, parentPath: string): boolean {
    return path.startsWith(`${parentPath}/`);
  }

  private async moveCurrentFileToFolder(targetFolder: TFolder): Promise<void> {
    const currentFile = this.app.workspace.getActiveFile();
    if (!currentFile) {
      new Notice("No active file to move.");
      return;
    }

    if (currentFile.parent?.path === targetFolder.path) {
      new Notice("The current file is already in that folder.");
      return;
    }

    const destinationPath = this.getAvailablePath(targetFolder, currentFile);

    try {
      await this.app.fileManager.renameFile(currentFile, destinationPath);
      new Notice(`Moved to ${targetFolder.path === "/" ? "vault root" : targetFolder.path}.`);
    } catch (error) {
      console.error("Failed to move current file", error);
      new Notice("Failed to move current file.");
    }
  }

  private getAvailablePath(targetFolder: TFolder, file: TFile): string {
    return this.getAvailableFilePath(targetFolder, file.name);
  }

  private getAvailableFilePath(targetFolder: TFolder, fileName: string): string {
    const extensionMatch = fileName.match(/(\.[^.]*)$/);
    const extension = extensionMatch?.[1] ?? "";
    const baseName = extension ? fileName.slice(0, -extension.length) : fileName;

    let candidateName = fileName;
    let candidatePath = this.joinPath(targetFolder, candidateName);
    let index = 1;

    while (this.app.vault.getAbstractFileByPath(candidatePath)) {
      candidateName = `${baseName} ${index}${extension}`;
      candidatePath = this.joinPath(targetFolder, candidateName);
      index += 1;
    }

    return candidatePath;
  }

  private joinPath(folder: TFolder, fileName: string): string {
    if (folder.path === "/") {
      return normalizePath(fileName);
    }

    return normalizePath(`${folder.path}/${fileName}`);
  }

  private joinVaultPath(parentPath: string, name: string): string {
    return parentPath ? normalizePath(`${parentPath}/${name}`) : normalizePath(name);
  }
}

class PageModeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: PageModePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Page-unit scrolling")
      .setDesc("Use wheel and trackpad gestures for page-sized content scrolling and edge-to-edge file movement.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pageUnitScroll).onChange(async (value) => {
          this.plugin.settings.pageUnitScroll = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("New right document location")
      .setDesc("When no Markdown document is available on the right, create the target here. Existing right documents and empty tabs are reused first.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(RIGHT_DOCUMENT_LOCATION_OPTIONS)
          .setValue(this.plugin.settings.rightDocumentLocation)
          .onChange(async (value) => {
            if (value !== "right-split" && value !== "right-sidebar") {
              return;
            }

            this.plugin.settings.rightDocumentLocation = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc("Files are moved under this folder while keeping their current relative path.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.archiveFolder)
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show archive folder")
      .setDesc("Show the archive folder in File explorer. Archived files are still excluded from PageMode navigation.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showArchiveFolder).onChange(async (value) => {
          this.plugin.settings.showArchiveFolder = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
