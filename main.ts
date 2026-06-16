import {
  MarkdownView,
  Notice,
  OpenViewState,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  type Editor,
  type EditorPosition,
  type Menu,
} from "obsidian";

const SCROLL_EDGE_TOLERANCE_PX = 24;
const LINE_BOUNDARY_EPSILON_PX = 1;
const MIN_PAGE_ADVANCE_PX = 4;
const MOUSE_WHEEL_DELTA_THRESHOLD = 80;
const TRACKPAD_DELTA_THRESHOLD = 60;
const TRACKPAD_IDLE_MS = 160;

type ContentLineRect = {
  top: number;
  bottom: number;
};

type ScrollBand = {
  top: number;
  bottom: number;
};

type SelectedEditorRange = {
  from: EditorPosition;
  to: EditorPosition;
  text: string;
};

type SidebarMarkdownTarget = {
  file: TFile;
  side: "left" | "right";
  displayName: string;
};

type DraggedEditorSelection = {
  editor: Editor;
  sourceFile: TFile;
  ranges: SelectedEditorRange[];
};

export default class PageModePlugin extends Plugin {
  private openingFile = false;
  private draggedEditorSelection: DraggedEditorSelection | null = null;
  private trackpadAccumulatedDelta = 0;
  private trackpadGestureLocked = false;
  private trackpadIdleTimer: number | null = null;
  private collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  onload(): void {
    this.patchOpenFileToPreferReadingMode();

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
      id: "switch-active-file-to-edit-mode",
      name: "Switch active file to edit mode",
      callback: () => {
        void this.switchActiveMarkdownViewToEditMode();
      },
    });

    this.addRibbonIcon("skip-forward", "Open next Markdown file", () => {
      void this.openNextMarkdownFile(true);
    });

    this.addRibbonIcon("skip-back", "Open previous Markdown file", () => {
      void this.openPreviousMarkdownFile(true);
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

    this.registerDomEvent(
      activeDocument,
      "keydown",
      (event: KeyboardEvent) => {
        void this.handleKeyDown(event);
      },
      { capture: true },
    );

    this.register(() => {
      this.clearTrackpadIdleTimer();
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Move current file here")
            .setIcon("folder-input")
            .setSection("open")
            .onClick(() => {
              void this.moveCurrentFileToFolder(file);
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        this.addExtractSelectionMenuItems(menu, editor, info.file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-drop", (event, editor, info) => {
        this.handleEditorDrop(event, editor, info.file);
      }),
    );
  }

  private patchOpenFileToPreferReadingMode(): void {
    const prototype = WorkspaceLeaf.prototype;
    const originalOpenFile = Reflect.get(prototype, "openFile") as (
      this: WorkspaceLeaf,
      file: TFile,
      openState?: OpenViewState,
    ) => Promise<void>;

    const patchedOpenFile = function patchedOpenFile(
      this: WorkspaceLeaf,
      file: TFile,
      openState?: OpenViewState,
    ): Promise<void> {
      const currentFile = this.view instanceof MarkdownView ? this.view.file : null;
      const fileChanged = PageModePlugin.isMarkdownFile(file) && currentFile?.path !== file.path;
      const openStateState = openState?.state;
      const hasExplicitMode = openStateState !== undefined && ("mode" in openStateState || "source" in openStateState);
      const nextOpenState =
        fileChanged && !hasExplicitMode ? PageModePlugin.withReadingModeOpenState(openState) : openState;

      const openFile = originalOpenFile.bind(this);
      const openFilePromise = openFile(file, nextOpenState);
      return openFilePromise;
    };

    prototype.openFile = patchedOpenFile;

    this.register(() => {
      if (prototype.openFile === patchedOpenFile) {
        prototype.openFile = originalOpenFile;
      }
    });
  }

  private static withReadingModeOpenState(openState?: OpenViewState): OpenViewState {
    return {
      ...openState,
      state: {
        ...(openState?.state ?? {}),
        mode: "preview",
        source: false,
      },
    };
  }

  private static isMarkdownFile(file: TFile): boolean {
    return file.extension.toLowerCase() === "md";
  }

  private async switchActiveMarkdownViewToEditMode(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("No active Markdown file.");
      return;
    }

    await this.switchMarkdownViewToEditMode(view);
  }

  private async switchMarkdownViewToEditMode(view: MarkdownView): Promise<void> {
    if (view.getMode() === "preview") {
      await this.toggleMarkdownViewMode(view);
    }
  }

  private async switchMarkdownViewToReadingMode(view: MarkdownView): Promise<void> {
    if (view.getMode() === "source") {
      await this.toggleMarkdownViewMode(view);
    }
  }

  private async toggleMarkdownViewMode(view: MarkdownView): Promise<void> {
    const commands = (this.app as typeof this.app & {
      commands?: {
        executeCommandById?: (id: string) => boolean;
      };
    }).commands;

    if (!commands?.executeCommandById) {
      return;
    }

    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    commands.executeCommandById("markdown:toggle-preview");
  }

  private async handleKeyDown(event: KeyboardEvent): Promise<void> {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    ) {
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    if (!this.isKeyboardEventInView(event, view)) {
      return;
    }

    if (event.code === "KeyE" && view.getMode() === "preview") {
      const target = event.targetNode;
      if (this.isHTMLElement(target) && this.isEditableTarget(target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      await this.switchMarkdownViewToEditMode(view);
      return;
    }

    if (event.code === "Escape" && view.getMode() === "source") {
      const target = event.targetNode;
      if (this.isHTMLElement(target) && this.isEditableTarget(target) && !this.isMarkdownEditorTarget(target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      await this.switchMarkdownViewToReadingMode(view);
    }
  }

  private isEditableTarget(target: HTMLElement): boolean {
    return target.closest("input, textarea, select, [contenteditable='true'], .cm-editor") !== null;
  }

  private isMarkdownEditorTarget(target: HTMLElement): boolean {
    return target.closest(".cm-editor") !== null;
  }

  private isHTMLElement(target: Node | null): target is HTMLElement {
    return target?.instanceOf(HTMLElement) === true;
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

  private addExtractSelectionMenuItems(menu: Menu, editor: Editor, sourceFile: TFile | null): void {
    if (!sourceFile || !PageModePlugin.isMarkdownFile(sourceFile)) {
      return;
    }

    const ranges = this.getSelectedEditorRanges(editor);
    if (ranges.length === 0) {
      return;
    }

    const targets = this.getSidebarMarkdownTargets(sourceFile);
    menu.addSeparator();

    if (targets.length === 0) {
      menu.addItem((item) => {
        item.setTitle("Extract selection to sidebar").setIcon("panel-right-open").setDisabled(true);
      });
      return;
    }

    if (targets.length === 1) {
      const target = targets[0];
      menu.addItem((item) => {
        item
          .setTitle("Extract selection to sidebar")
          .setIcon("panel-right-open")
          .onClick(() => {
            void this.extractSelectionToSidebarFile(editor, ranges, target.file);
          });
      });
      return;
    }

    for (const target of targets) {
      menu.addItem((item) => {
        item
          .setTitle(`Extract to ${target.displayName}`)
          .setIcon(target.side === "left" ? "panel-left-open" : "panel-right-open")
          .onClick(() => {
            void this.extractSelectionToSidebarFile(editor, ranges, target.file);
          });
      });
    }
  }

  private async extractSelectionToSidebarFile(editor: Editor, ranges: SelectedEditorRange[], targetFile: TFile): Promise<void> {
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

  private getSidebarMarkdownTargets(sourceFile: TFile): SidebarMarkdownTarget[] {
    const targets: SidebarMarkdownTarget[] = [];
    const leftLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.leftSplit);
    const rightLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rightSplit);

    this.addSidebarMarkdownTarget(targets, leftLeaf, "left", sourceFile);
    this.addSidebarMarkdownTarget(targets, rightLeaf, "right", sourceFile);

    const basenameCounts = new Map<string, number>();
    for (const target of targets) {
      basenameCounts.set(target.displayName, (basenameCounts.get(target.displayName) ?? 0) + 1);
    }

    for (const target of targets) {
      if ((basenameCounts.get(target.displayName) ?? 0) > 1) {
        target.displayName = target.file.path;
      }
    }

    return targets.sort((a, b) => this.compareSidebarTargets(a, b));
  }

  private addSidebarMarkdownTarget(
    targets: SidebarMarkdownTarget[],
    leaf: WorkspaceLeaf | null,
    side: "left" | "right",
    sourceFile: TFile,
  ): void {
    const view = leaf?.view;
    if (!(view instanceof MarkdownView) || !view.file || view.file.path === sourceFile.path) {
      return;
    }

    targets.push({
      file: view.file,
      side,
      displayName: view.file.basename,
    });
  }

  private compareSidebarTargets(a: SidebarMarkdownTarget, b: SidebarMarkdownTarget): number {
    if (a.side !== b.side) {
      return a.side === "left" ? -1 : 1;
    }

    return this.collator.compare(a.displayName, b.displayName);
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

  private isKeyboardEventInView(event: KeyboardEvent, view: MarkdownView): boolean {
    const target = event.targetNode;
    if (!target) {
      return true;
    }

    if (target === event.doc.body || target === event.doc.documentElement) {
      return true;
    }

    return view.containerEl.contains(target);
  }

  private async handleWheel(event: WheelEvent): Promise<void> {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }

    const direction = Math.sign(event.deltaY);
    if (direction === 0) {
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      await this.handleWheelWithoutActiveFile(event, direction);
      return;
    }

    if (view.getMode() !== "preview") {
      return;
    }

    const target = event.targetNode;
    if (!target || !view.containerEl.contains(target)) {
      return;
    }

    if (this.isInlineTitleTarget(target)) {
      event.preventDefault();
      event.stopPropagation();
      await this.openAdjacentMarkdownFile(direction > 0 ? 1 : -1, false);
      return;
    }

    const scrollEl = this.getPreviewScrollElement(view);
    if (!scrollEl || !scrollEl.contains(target)) {
      return;
    }

    if (!this.shouldHandleWheelEvent(event, direction)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const currentTop = scrollEl.scrollTop;
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const atTop = currentTop <= SCROLL_EDGE_TOLERANCE_PX;
    const atBottom = currentTop + SCROLL_EDGE_TOLERANCE_PX >= maxScrollTop;
    const lastContentLineFullyVisible = this.isLastContentLineFullyVisible(scrollEl);
    const nextTop = this.getNextPageTop(scrollEl, direction, maxScrollTop);

    event.preventDefault();
    event.stopPropagation();

    if (direction > 0 && (atBottom || lastContentLineFullyVisible)) {
      await this.openNextMarkdownFile(false);
      return;
    }

    if (direction < 0 && atTop) {
      await this.openPreviousMarkdownFile(false);
      return;
    }

    scrollEl.scrollTo({
      top: nextTop,
      behavior: "auto",
    });
  }

  private getPreviewScrollElement(view: MarkdownView): HTMLElement | null {
    return view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
  }

  private isInlineTitleTarget(target: Node): boolean {
    return target.instanceOf(Element) && target.closest(".inline-title") !== null;
  }

  private async handleWheelWithoutActiveFile(event: WheelEvent, direction: number): Promise<void> {
    if (this.app.workspace.getActiveFile() || this.app.workspace.getLeaf(false).view.getViewType() !== "empty") {
      return;
    }

    const target = event.targetNode;
    if (!this.isHTMLElement(target) || !this.isMainWorkspaceTarget(target)) {
      return;
    }

    if (!this.shouldHandleWheelEvent(event, direction)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await this.openBoundaryMarkdownFile(direction > 0 ? 1 : -1, false);
  }

  private isMainWorkspaceTarget(target: HTMLElement): boolean {
    return target.closest(".workspace-split.mod-root") !== null && target.closest(".workspace-sidedock") === null;
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

  private getNextPageTop(scrollEl: HTMLElement, direction: number, maxScrollTop: number): number {
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
    const lineRects = this.getContentLineRects(scrollEl, searchBand);

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

  private isLastContentLineFullyVisible(scrollEl: HTMLElement): boolean {
    const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
    const lineRects = this.getContentLineRects(scrollEl, {
      top: scrollEl.scrollTop,
      bottom: scrollEl.scrollHeight,
    });
    const lastLine = lineRects[lineRects.length - 1];

    return lastLine !== undefined && lastLine.bottom <= viewportBottom + LINE_BOUNDARY_EPSILON_PX;
  }

  private getContentLineRects(scrollEl: HTMLElement, searchBand: ScrollBand): ContentLineRect[] {
    const scrollRect = scrollEl.getBoundingClientRect();
    const lineRects: ContentLineRect[] = [];
    const range = scrollEl.doc.createRange();

    try {
      this.collectContentLineRects(scrollEl, scrollEl, searchBand, scrollRect, range, lineRects);
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
    if (this.openingFile) {
      return;
    }

    const files = this.getFilesInVaultDfsOrder();
    const file = direction > 0 ? files[0] : files[files.length - 1];
    if (!file) {
      if (showNotice) {
        new Notice("No Markdown files in the vault.");
      }
      return;
    }

    this.openingFile = true;
    try {
      await this.app.workspace.getLeaf(false).openFile(
        file,
        PageModePlugin.withReadingModeOpenState({ active: true }),
      );
    } catch (error) {
      console.error("Failed to open Markdown file", error);
      new Notice("Failed to open Markdown file.");
    } finally {
      this.openingFile = false;
    }
  }

  private async openAdjacentMarkdownFile(offset: -1 | 1, showNotice: boolean): Promise<void> {
    if (this.openingFile) {
      return;
    }

    const currentFile = this.app.workspace.getActiveFile();
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

    this.openingFile = true;
    try {
      await this.app.workspace.getLeaf(false).openFile(
        adjacentFile,
        PageModePlugin.withReadingModeOpenState({ active: true }),
      );
    } catch (error) {
      console.error("Failed to open adjacent Markdown file", error);
      new Notice("Failed to open Markdown file.");
    } finally {
      this.openingFile = false;
    }
  }

  private getAdjacentMarkdownFile(currentFile: TFile, offset: -1 | 1): TFile | null {
    const files = this.getFilesInVaultDfsOrder();

    const index = files.findIndex((file) => file.path === currentFile.path);
    const adjacentIndex = index + offset;
    if (index < 0 || adjacentIndex < 0 || adjacentIndex >= files.length) {
      return null;
    }

    return files[adjacentIndex];
  }

  private getFilesInVaultDfsOrder(): TFile[] {
    const files: TFile[] = [];

    const visitFolder = (folder: TFolder): void => {
      const children = [...folder.children].sort((a, b) => this.compareAbstractFiles(a, b));

      for (const child of children) {
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
    const extension = file.extension ? `.${file.extension}` : "";
    const baseName = file.basename;

    let candidateName = file.name;
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
