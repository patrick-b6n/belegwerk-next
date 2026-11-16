/**
 * Port for saving files (docs/architecture.md, "Platform access"): Business
 * stays free of Tauri; `src/app` implements it with `tauri-plugin-dialog`
 * (save dialog) and `tauri-plugin-fs` (writing).
 */

export interface SaveTextFileRequest {
  /** File name the save dialog suggests, e.g. `buchungen-2025-01-01_2025-12-31.csv`. */
  readonly defaultFileName: string;
  /** File type filter of the dialog (UI text, e.g. "CSV-Datei") and its extensions without dot. */
  readonly filter: { readonly name: string; readonly extensions: readonly string[] };
  /** Written as UTF-8, unchanged (a leading BOM stays). */
  readonly content: string;
}

export type SaveTextFileResult =
  /** Written to `path` (the path the user chose). */
  | { readonly saved: true; readonly path: string }
  /** The user cancelled the dialog; nothing was written. */
  | { readonly saved: false };

export interface FileSaver {
  /**
   * Asks the user where to save (save dialog) and writes `content` there,
   * replacing an existing file (the dialog asks before overwriting).
   *
   * @throws if writing fails (e.g. no permission, file locked by Excel).
   */
  saveTextFile(request: SaveTextFileRequest): Promise<SaveTextFileResult>;
}

// Not allowed in Windows file names (plus control characters).
const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

/** `text` for use in a file name: characters Windows forbids become `_`. */
export function safeFileNamePart(text: string): string {
  return text.replace(INVALID_FILE_NAME_CHARS, "_");
}

/** The file name of a saved path (last segment; Windows or POSIX separators). */
export function fileNameOfPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Request of {@link SavePathPicker.pickSavePath}. */
export interface PickSavePathRequest {
  /** File name the save dialog suggests, e.g. `belegwerk-backup-2026-11-14_1530.db`. */
  readonly defaultFileName: string;
  /** File type filter of the dialog (UI text) and its extensions without dot. */
  readonly filter: { readonly name: string; readonly extensions: readonly string[] };
}

/**
 * Port for a save dialog alone (backup, #32): for files that are not written
 * by the WebView itself but e.g. by SQLite (`VACUUM INTO`). `src/app`
 * implements it with `tauri-plugin-dialog`; the dialog also allows the
 * WebView to write the picked path (and only it) via `tauri-plugin-fs`.
 */
export interface SavePathPicker {
  /**
   * Asks the user where to save; the path, or `null` if cancelled. Picking
   * an existing file means replacing it (the dialog asks before).
   */
  pickSavePath(request: PickSavePathRequest): Promise<string | null>;
}
