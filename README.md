# PageMode

PageMode is an Obsidian plugin for reading and organizing Markdown notes as a continuous sequence. It adds optional page-style wheel navigation, next/previous file movement, and small filing tools for reshaping notes without leaving the editor.

## Features

- Scroll by page-sized steps in Markdown reading and editing views.
- With page-unit scrolling enabled, continue scrolling past the bottom or top of a note to open the next or previous Markdown file.
- Use commands to open the next or previous Markdown file directly.
- In editing view, send selected text to the nearest Markdown document on the right.
- In editing view, send a whole file to the right document when no text is selected.
- Drag selected text between Markdown editors to move it, or hold `Ctrl`/`Cmd` to copy it.
- Move the current file into a folder from the file explorer.
- Hide files and folders from PageMode navigation.

## Navigation

PageMode follows the vault's folder order when moving between Markdown files. Files and folders hidden from PageMode are skipped.

With page-unit scrolling enabled, wheel and trackpad gestures jump by one readable page instead of scrolling continuously. When you reach the end of a note, another scroll opens the next Markdown file. Scrolling upward from the top opens the previous Markdown file.

With page-unit scrolling disabled, normal Obsidian content scrolling is preserved. Wheel and trackpad gestures in title, tab, and header areas still move between files.

## Moving Text And Files

In editing view, use **Send selection or file to nearest right document** from the command palette, editor menu, or document action button.

When text is selected, PageMode appends it to the nearest Markdown document on the right and removes it from the source editor. When nothing is selected, PageMode appends the current file under a heading and then moves the source file to trash using Obsidian's file manager.

If no suitable right-side Markdown document exists, PageMode creates one in the right sidebar.

## File Explorer Actions

PageMode adds two file explorer actions:

- **Move active file here** moves the active file into the selected folder.
- **PageMode: Hide** excludes a file or folder from PageMode navigation.

Hidden paths can be restored from the PageMode settings tab.

## Settings

- **Page-unit scrolling**: Toggle page-sized content scrolling and edge-to-edge wheel navigation.
- **Hidden files and folders**: Review and restore hidden paths.

## Manual Install

1. Download `main.js` and `manifest.json` from the latest release.
2. Create `<vault>/.obsidian/plugins/pagemode/`.
3. Copy both files into that folder.
4. Reload Obsidian.
5. Enable `PageMode` in Settings -> Community plugins.

## Compatibility

PageMode requires Obsidian `1.6.6` or newer.
