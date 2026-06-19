# PageMode

PageMode is an Obsidian plugin for moving through Markdown notes as an ordered sequence and reshaping notes without leaving the editor. It adds wheel-based file navigation, optional page-style scrolling, a left-side file position bar, and small filing tools for moving content between notes.

## Features

- Open the next or previous Markdown file with commands or wheel gestures.
- Use optional page-unit scrolling in Markdown reading and editing views.
- Use the left file position bar to see where the current note sits in PageMode navigation and wheel to adjacent notes.
- Send selected text, or a whole file, to the nearest Markdown document on the right.
- Drag selected text between Markdown editors to move it, or hold `Ctrl`/`Cmd` to copy it.
- Move the active file into a folder from the file explorer.
- Hide files and folders from PageMode navigation and from the file explorer.

## Navigation Order

PageMode builds its navigation list from the vault tree. It walks folders recursively, places folders before files, sorts names naturally, and includes Markdown files only. Hidden files and folders are skipped.

## Wheel Navigation

Wheel direction maps to file direction:

- Scroll down to open the next Markdown file.
- Scroll up to open the previous Markdown file.

These wheel areas work even when page-unit scrolling is disabled:

- The active tab, tab header area, and view header.
- The inline title and the small area around the top of the note.
- The left file position bar area.
- An empty main workspace pane, which opens the first or last Markdown file.

When page-unit scrolling is disabled, normal Obsidian document scrolling is preserved in the note body.

When page-unit scrolling is enabled, wheel and trackpad gestures in the note body move by page-sized steps. If the note is already at the bottom, another downward scroll opens the next Markdown file. If the note is already at the top, another upward scroll opens the previous Markdown file.

## File Position Bar

Markdown views get a narrow position bar in the left margin. Move the pointer over unused left margin space to show the indicator. The indicator marks the current file's position among the visible PageMode navigation files.

Wheel over the bar area to move to the previous or next Markdown file. The bar does not handle clicks.

PageMode leaves Obsidian controls alone. If the pointer is over a button, link, fold control, or similar document control, that control keeps priority and the PageMode bar stays inactive.

## Moving Text And Files Right

In editing view, run **Send selection or file to nearest right document** from the command palette, editor menu, or document action button.

If text is selected, PageMode appends the selected text to the nearest Markdown document on the right and removes it from the source editor.

If nothing is selected, PageMode appends the whole source file to the nearest Markdown document on the right under a heading named after the source file. The original source file is then moved to trash through Obsidian's file manager.

If there is no suitable Markdown document on the right, PageMode creates an `Untitled.md` file in the vault root and opens it in the right sidebar.

## Dragging Text Between Editors

In editing view, drag selected text from one Markdown editor to another Markdown editor to move it. Hold `Ctrl` on Windows/Linux or `Cmd` on macOS to copy instead.

PageMode only removes the original selection after the drop changes the target editor and the source selection is still unchanged.

## File Explorer Actions

PageMode adds two file explorer actions:

- **Move active file here** appears on folders and moves the active file into that folder.
- **PageMode: Hide** appears on files and folders and excludes that path from PageMode navigation.

Hidden folders also hide their child files and folders. Hidden paths can be restored from the PageMode settings tab.

## Settings

- **Page-unit scrolling**: Toggle page-sized content scrolling and scroll-edge file movement.
- **Hidden files and folders**: Review and restore paths hidden from PageMode.

## Commands

- **Open next Markdown file**
- **Open previous Markdown file**
- **Send selection or file to nearest right document**

## Manual Install

1. Download `main.js` and `manifest.json` from the latest release.
2. Create `<vault>/.obsidian/plugins/pagemode/`.
3. Copy both files into that folder.
4. Reload Obsidian.
5. Enable `PageMode` in Settings -> Community plugins.

## Compatibility

PageMode requires Obsidian `1.6.6` or newer.
