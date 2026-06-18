# Review Notes

This document records intentional decisions around Obsidian plugin review warnings that are currently left unresolved.

## `editor-drop` And `preventDefault()`

Obsidian's review tooling warns that an `editor-drop` handler should call `evt.preventDefault()` after handling the event.

PageMode intentionally does not call `preventDefault()` in this handler.

The drag-to-move behavior relies on Obsidian/CodeMirror's default drop handling to insert the dragged text at the actual drop position in the target editor. After the default drop has changed the target editor content, PageMode verifies that the source selection is unchanged and then removes the original selection.

Calling `preventDefault()` during the drop event would stop the default editor insertion. To preserve the current behavior after preventing the default event, PageMode would need to implement the full drop insertion itself, including converting pointer coordinates into an editor document position. That would require relying on editor internals rather than the public Obsidian `Editor` API, which is more fragile than the current behavior.

Current behavior:

- If another handler has already prevented the event, PageMode returns early.
- Normal drops move selected text between Markdown editors.
- `Ctrl`/`Cmd` drops keep copy behavior.
- PageMode lets Obsidian/CodeMirror perform the actual insertion.

This warning is accepted to preserve stable drop behavior.

## `PluginSettingTab.display()` Deprecation

Obsidian marks `PluginSettingTab.display()` as deprecated since Obsidian `1.13.0` and recommends `getSettingDefinitions()`.

PageMode intentionally keeps `display()` for now.

Using `getSettingDefinitions()` would require raising `minAppVersion` to `1.13.0`. PageMode currently supports Obsidian `1.6.6` and newer. Keeping `display()` preserves compatibility with older supported Obsidian versions.

This recommendation is accepted until PageMode is ready to require Obsidian `1.13.0` or newer.
