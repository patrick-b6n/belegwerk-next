import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

import type { FileSaver, SavePathPicker } from "@/business/files";

/**
 * {@link FileSaver} of the app: the native save dialog (`tauri-plugin-dialog`)
 * and writing via `tauri-plugin-fs`.
 *
 * Permissions (`src-tauri/capabilities/default.json`): only `dialog:allow-save`
 * and `fs:allow-write-text-file` without a configured scope. The dialog adds
 * the chosen path to the fs scope at runtime, so the WebView can write exactly
 * the files the user picked – no other path (docs/architecture.md, "Saving
 * files").
 */
export function createTauriFileSaver(): FileSaver {
  return {
    saveTextFile: async ({ defaultFileName, filter, content }) => {
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filter.name, extensions: [...filter.extensions] }],
      });
      if (path === null) return { saved: false };
      // Encoded as UTF-8 (TextEncoder); a leading BOM stays.
      await writeTextFile(path, content);
      return { saved: true, path };
    },
  };
}

/**
 * {@link SavePathPicker} of the app (backup, #32): only the save dialog of
 * `tauri-plugin-dialog`. Like for {@link createTauriFileSaver}, the dialog adds
 * the picked path – and only it – to the fs scope.
 */
export function createTauriSavePathPicker(): SavePathPicker {
  return {
    pickSavePath: ({ defaultFileName, filter }) =>
      save({
        defaultPath: defaultFileName,
        filters: [{ name: filter.name, extensions: [...filter.extensions] }],
      }),
  };
}
