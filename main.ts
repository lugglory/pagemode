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

const SCROLL_EDGE_TOLERANCE_PX = 24;
const LINE_BOUNDARY_EPSILON_PX = 1;
const MIN_PAGE_ADVANCE_PX = 4;
const MOUSE_WHEEL_DELTA_THRESHOLD = 80;
const TRACKPAD_DELTA_THRESHOLD = 60;
const TRACKPAD_IDLE_MS = 160;
const INLINE_TITLE_AREA_PADDING_PX = 8;

interface PageModeSettings {
  pageUnitScroll: boolean;
  hiddenPaths: string[];
}

type LoadedPageModeSettings = {
  pageUnitScroll?: boolean;
  hiddenPaths?: unknown;
};

const DEFAULT_SETTINGS: PageModeSettings = {
  pageUnitScroll: false,
  hiddenPaths: [],
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

type MarkdownFileTarget = {
  file: TFile;
  displayName: string;
};

export default class PageModePlugin extends Plugin {
  settings: PageModeSettings = { ...DEFAULT_SETTINGS };

  private openingFile = false;
  private draggedEditorSelection: DraggedEditorSelection | null = null;
  private markdownActionViews = new WeakSet<MarkdownView>();
  private hiddenFileExplorerStyleEl: HTMLStyleElement | null = null;
  private trackpadAccumulatedDelta = 0;
  private trackpadGestureLocked = false;
  private trackpadIdleTimer: number | null = null;
  private collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new PageModeSettingTab(this.app, this));
    this.updateHiddenFileExplorerStyles();

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
        if (!this.canSendToRightDocument(editor, info.file)) {
          return false;
        }

        if (!checking) {
          void this.extractSelectionToRightDocumentCommand(editor, info.file);
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
      this.clearTrackpadIdleTimer();
      this.hiddenFileExplorerStyleEl?.remove();
      this.hiddenFileExplorerStyleEl = null;
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("Move current file here")
              .setIcon("folder-input")
              .setSection("open")
              .onClick(() => {
                void this.moveCurrentFileToFolder(file);
              });
          });
        }

        this.addHideFromPageModeMenuItem(menu, file);
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
      this.addMarkdownViewActions();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.addMarkdownViewActions();
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

  private parseLoadedSettings(value: unknown): LoadedPageModeSettings {
    if (!this.isRecord(value)) {
      return {};
    }

    return {
      pageUnitScroll: typeof value.pageUnitScroll === "boolean" ? value.pageUnitScroll : undefined,
      hiddenPaths: value.hiddenPaths,
    };
  }

  async loadSettings(): Promise<void> {
    const loadedData = this.parseLoadedSettings(await this.loadData());
    this.settings = {
      ...DEFAULT_SETTINGS,
      pageUnitScroll: loadedData.pageUnitScroll ?? DEFAULT_SETTINGS.pageUnitScroll,
      hiddenPaths: this.normalizeHiddenPaths(loadedData?.hiddenPaths),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.updateHiddenFileExplorerStyles();
  }

  private addHideFromPageModeMenuItem(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile || file instanceof TFolder) || file.path === "/") {
      return;
    }

    menu.addItem((item) => {
      item.setTitle("Hide from PageMode").setIcon("eye-off").setSection("open");

      if (this.isHiddenPath(file.path, this.getHiddenPathSet())) {
        item.setDisabled(true);
        return;
      }

      item.onClick(() => {
        void this.hidePath(file.path);
      });
    });
  }

  async hidePath(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    const hiddenPaths = this.getHiddenPathSet();

    if (this.isHiddenPath(normalizedPath, hiddenPaths)) {
      new Notice("Already hidden from PageMode.");
      return;
    }

    const nextHiddenPaths = this.settings.hiddenPaths.filter(
      (hiddenPath) => !hiddenPath.startsWith(`${normalizedPath}/`),
    );
    nextHiddenPaths.push(normalizedPath);
    this.settings.hiddenPaths = this.normalizeHiddenPaths(nextHiddenPaths);
    await this.saveSettings();
    new Notice(`Hidden from PageMode: ${normalizedPath}`);
  }

  async unhidePath(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    this.settings.hiddenPaths = this.normalizeHiddenPaths(
      this.settings.hiddenPaths.filter((hiddenPath) => hiddenPath !== normalizedPath),
    );
    await this.saveSettings();
  }

  private normalizeHiddenPaths(paths: unknown): string[] {
    if (!Array.isArray(paths)) {
      return [];
    }

    const normalizedPaths = paths
      .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      .map((path) => normalizePath(path.trim()))
      .filter((path) => path !== "/")
      .sort((a, b) => this.collator.compare(a, b));

    const result: string[] = [];
    for (const path of normalizedPaths) {
      if (!result.some((existingPath) => path === existingPath || path.startsWith(`${existingPath}/`))) {
        result.push(path);
      }
    }

    return result;
  }

  private updateHiddenFileExplorerStyles(): void {
    if (!this.hiddenFileExplorerStyleEl) {
      this.hiddenFileExplorerStyleEl = activeDocument.createElement("style");
      this.hiddenFileExplorerStyleEl.setAttr("data-pagemode-hidden-files", "");
      activeDocument.head.appendChild(this.hiddenFileExplorerStyleEl);
    }

    const selectors = this.settings.hiddenPaths.flatMap((path) => {
      const dataPath = this.getCssString(path);
      return [
        `.workspace-leaf-content[data-type="file-explorer"] .nav-file:has(> .nav-file-title[data-path=${dataPath}])`,
        `.workspace-leaf-content[data-type="file-explorer"] .nav-folder:has(> .nav-folder-title[data-path=${dataPath}])`,
      ];
    });

    this.hiddenFileExplorerStyleEl.textContent =
      selectors.length > 0 ? `${selectors.join(",\n")} {\n  display: none !important;\n}\n` : "";
  }

  private getCssString(value: string): string {
    return JSON.stringify(value);
  }

  private getHiddenPathSet(): Set<string> {
    return new Set(this.settings.hiddenPaths);
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
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || this.markdownActionViews.has(view)) {
        return;
      }

      view.addAction("panel-left-open", "Send selection or file to right document", () => {
        void this.extractSelectionToRightDocumentFromView(view);
      });
      this.markdownActionViews.add(view);
    });
  }

  private canSendToRightDocument(
    editor: Editor,
    sourceFile: TFile | null,
    sourceView = this.app.workspace.getActiveViewOfType(MarkdownView),
  ): sourceFile is TFile {
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
    const target = await this.getOrCreateRightMarkdownTarget(sourceView, sourceFile);
    if (!target) {
      new Notice("No Markdown document available on the right.");
      return;
    }

    if (ranges.length === 0) {
      await this.moveWholeFileToRightDocument(sourceFile, target.file);
      return;
    }

    await this.extractSelectionToMarkdownFile(editor, ranges, target.file);
  }

  private async getOrCreateRightMarkdownTarget(
    sourceView: MarkdownView,
    sourceFile: TFile,
  ): Promise<MarkdownFileTarget | null> {
    const existingTarget = this.getNearestRightMarkdownTarget(sourceView, sourceFile);
    if (existingTarget) {
      return existingTarget;
    }

    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice("No right sidebar available.");
      return null;
    }

    let file: TFile | null = null;
    try {
      file = await this.createRootMarkdownFile();
      await leaf.openFile(file, { active: true });
      return { file, displayName: file.basename };
    } catch (error) {
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

  private async createRootMarkdownFile(): Promise<TFile> {
    const root = this.app.vault.getRoot();
    const path = this.getAvailableFilePath(root, "Untitled.md");
    return this.app.vault.create(path, "");
  }

  private async moveWholeFileToRightDocument(sourceFile: TFile, targetFile: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(sourceFile);
      await this.appendTextToFile(targetFile, this.getWholeFileExtractedText(sourceFile, content));
      await this.app.fileManager.trashFile(sourceFile);
      new Notice(`Moved ${sourceFile.basename} to ${targetFile.basename}.`);
    } catch (error) {
      console.error("Failed to move whole file to right document", error);
      new Notice("Failed to move file to right document.");
    }
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

    if (this.openingFile) {
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

    if (this.isAdjacentFileNavigationTarget(target, view)) {
      if (!this.shouldRunWheelAction(event, direction)) {
        return;
      }

      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForView(view, direction > 0 ? 1 : -1, false);
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
      if (!this.shouldRunWheelAction(event, direction)) {
        return;
      }

      this.consumeWheelEvent(event);
      await this.openAdjacentMarkdownFileForView(view, direction > 0 ? 1 : -1, false);
      return;
    }

    const { scrollEl, contentEl } = scrollContext;
    const currentTop = scrollEl.scrollTop;
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const atTop = currentTop <= SCROLL_EDGE_TOLERANCE_PX;
    const atBottom = currentTop + SCROLL_EDGE_TOLERANCE_PX >= maxScrollTop;
    const lastContentLineFullyVisible = mode === "preview" && this.isLastContentLineFullyVisible(scrollEl, contentEl);
    const shouldOpenNextFile = direction > 0 && (atBottom || lastContentLineFullyVisible);
    const shouldOpenPreviousFile = direction < 0 && atTop;

    if (!shouldOpenNextFile && !shouldOpenPreviousFile && !this.settings.pageUnitScroll) {
      return;
    }

    if (!this.shouldRunWheelAction(event, direction)) {
      return;
    }

    this.consumeWheelEvent(event);

    if (shouldOpenNextFile) {
      await this.openAdjacentMarkdownFileForView(view, 1, false);
      return;
    }

    if (shouldOpenPreviousFile) {
      await this.openAdjacentMarkdownFileForView(view, -1, false);
      return;
    }

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

  private async handleWheelWithoutActiveFile(event: WheelEvent, target: Node, direction: number): Promise<void> {
    if (!this.isHTMLElement(target) || !this.isMainWorkspaceTarget(target)) {
      return;
    }

    const leaf = this.getWorkspaceLeafForTarget(target);
    if (!leaf || leaf.view.getViewType() !== "empty") {
      return;
    }

    if (!this.shouldRunWheelAction(event, direction)) {
      return;
    }

    this.consumeWheelEvent(event);
    await this.openBoundaryMarkdownFileInLeaf(leaf, direction > 0 ? 1 : -1, false);
  }

  private isMainWorkspaceTarget(target: HTMLElement): boolean {
    return target.closest(".workspace-split.mod-root") !== null && target.closest(".workspace-sidedock") === null;
  }

  private shouldRunWheelAction(event: WheelEvent, direction: number): boolean {
    if (this.shouldHandleWheelEvent(event, direction)) {
      return true;
    }

    if (!this.trackpadGestureLocked) {
      this.consumeWheelEvent(event);
    }

    return false;
  }

  private shouldHandleWheelEvent(event: WheelEvent, direction: number): boolean {
    if (!this.isLikelyTrackpadEvent(event)) {
      return true;
    }

    this.scheduleTrackpadGestureReset();

    if (this.trackpadGestureLocked) {
      return false;
    }

    const accumulatedDirection = Math.sign(this.trackpadAccumulatedDelta);
    if (accumulatedDirection !== 0 && accumulatedDirection !== direction) {
      this.trackpadAccumulatedDelta = 0;
    }

    this.trackpadAccumulatedDelta += event.deltaY;

    if (Math.abs(this.trackpadAccumulatedDelta) < TRACKPAD_DELTA_THRESHOLD) {
      return false;
    }

    this.trackpadGestureLocked = true;
    return true;
  }

  private isLikelyTrackpadEvent(event: WheelEvent): boolean {
    return event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < MOUSE_WHEEL_DELTA_THRESHOLD;
  }

  private scheduleTrackpadGestureReset(): void {
    this.clearTrackpadIdleTimer();
    this.trackpadIdleTimer = window.setTimeout(() => {
      this.trackpadAccumulatedDelta = 0;
      this.trackpadGestureLocked = false;
      this.trackpadIdleTimer = null;
    }, TRACKPAD_IDLE_MS);
  }

  private clearTrackpadIdleTimer(): void {
    if (this.trackpadIdleTimer === null) {
      return;
    }

    window.clearTimeout(this.trackpadIdleTimer);
    this.trackpadIdleTimer = null;
  }

  private resetTrackpadGesture(): void {
    this.clearTrackpadIdleTimer();
    this.trackpadAccumulatedDelta = 0;
    this.trackpadGestureLocked = false;
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

  private isLastContentLineFullyVisible(scrollEl: HTMLElement, contentEl: HTMLElement): boolean {
    const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
    const lineRects = this.getContentLineRects(scrollEl, contentEl, {
      top: scrollEl.scrollTop,
      bottom: scrollEl.scrollHeight,
    });
    const lastLine = lineRects[lineRects.length - 1];

    return lastLine !== undefined && lastLine.bottom <= viewportBottom + LINE_BOUNDARY_EPSILON_PX;
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

  private async openBoundaryMarkdownFile(direction: -1 | 1, showNotice: boolean): Promise<void> {
    await this.openBoundaryMarkdownFileInLeaf(this.app.workspace.getLeaf(false), direction, showNotice);
  }

  private async openBoundaryMarkdownFileInLeaf(
    leaf: WorkspaceLeaf,
    direction: -1 | 1,
    showNotice: boolean,
  ): Promise<void> {
    if (this.openingFile) {
      this.resetTrackpadGesture();
      return;
    }

    const files = this.getMarkdownFilesInNavigationOrder();
    const file = direction > 0 ? files[0] : files[files.length - 1];
    if (!file) {
      if (showNotice) {
        new Notice("No Markdown files in the vault.");
      }
      return;
    }

    this.openingFile = true;
    try {
      await leaf.openFile(file, { active: true });
    } catch (error) {
      console.error("Failed to open Markdown file", error);
      new Notice("Failed to open Markdown file.");
    } finally {
      this.resetTrackpadGesture();
      this.openingFile = false;
    }
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

  private async openAdjacentMarkdownFileInLeaf(
    currentFile: TFile | null,
    leaf: WorkspaceLeaf,
    offset: -1 | 1,
    showNotice: boolean,
  ): Promise<void> {
    if (this.openingFile) {
      this.resetTrackpadGesture();
      return;
    }

    if (!currentFile) {
      this.resetTrackpadGesture();
      if (showNotice) {
        new Notice("No active file.");
      }
      return;
    }

    const adjacentFile = this.getAdjacentMarkdownFile(currentFile, offset);
    if (!adjacentFile) {
      this.resetTrackpadGesture();
      if (showNotice) {
        new Notice(offset > 0 ? "No next Markdown file in the vault." : "No previous Markdown file in the vault.");
      }
      return;
    }

    this.openingFile = true;
    try {
      await leaf.openFile(adjacentFile, { active: true });
    } catch (error) {
      console.error("Failed to open adjacent Markdown file", error);
      new Notice("Failed to open Markdown file.");
    } finally {
      this.resetTrackpadGesture();
      this.openingFile = false;
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

  private getMarkdownFilesInNavigationOrder(): TFile[] {
    return this.getFilesInVaultDfsOrder(this.getHiddenPathSet());
  }

  private getFilesInVaultDfsOrder(hiddenPaths = new Set<string>()): TFile[] {
    const files: TFile[] = [];

    const visitFolder = (folder: TFolder): void => {
      if (this.isHiddenPath(folder.path, hiddenPaths)) {
        return;
      }

      const children = [...folder.children].sort((a, b) => this.compareAbstractFiles(a, b));

      for (const child of children) {
        if (this.isHiddenPath(child.path, hiddenPaths)) {
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

  private isHiddenPath(path: string, hiddenPaths: Set<string>): boolean {
    for (const hiddenPath of hiddenPaths) {
      if (path === hiddenPath || path.startsWith(`${hiddenPath}/`)) {
        return true;
      }
    }

    return false;
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
      .setDesc("Use one wheel or trackpad gesture to jump by a page in main document tabs.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pageUnitScroll).onChange(async (value) => {
          this.plugin.settings.pageUnitScroll = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Hidden files and folders").setDesc("Items hidden from File explorer and PageMode navigation.");

    if (this.plugin.settings.hiddenPaths.length === 0) {
      new Setting(containerEl).setName("No hidden items");
      return;
    }

    for (const path of this.plugin.settings.hiddenPaths) {
      new Setting(containerEl)
        .setName(path)
        .addExtraButton((button) => {
          button
            .setIcon("x")
            .setTooltip("Remove from hidden items")
            .onClick(async () => {
              await this.plugin.unhidePath(path);
              this.display();
            });
        });
    }
  }
}
