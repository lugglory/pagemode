# PageMode

PageMode makes Obsidian notes behave more like paged reading, with quick file navigation and filing actions.

## Features

- Turns mouse wheel and trackpad scrolling in main Reading and editing tabs into optional page-sized jumps aligned to nearby text lines.
- Opens the next or previous Markdown file when scrolling past the bottom or top of a note.
- Scroll on a main tab's top UI or note inline title to open the next or previous Markdown file.
- Opens the first or last Markdown file when scrolling down or up in the empty document area.
- Adds next/previous Markdown file commands and ribbon buttons.
- Moves dragged editor selections to another Markdown editor by default; hold `Ctrl`/`Cmd` to copy instead.
- Adds a command and editor context menu item to extract the current selection to a Markdown file open in the sidebar.
- Adds a document header button, command, and editor context menu item to send the current selection to the nearest Markdown document on the right; with no selection, it appends the current file with its title and moves the source file to trash.
- Adds `Move current file here` to folder context menus in the file explorer.

## Manual install

1. Download `main.js` and `manifest.json` from the latest release.
2. Create `<vault>/.obsidian/plugins/pagemode/`.
3. Copy both files into that folder.
4. Reload Obsidian and enable `PageMode` in Settings -> Community plugins.
