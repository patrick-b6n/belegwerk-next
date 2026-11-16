import { writeTextFile } from "@tauri-apps/plugin-fs";

import {
  BackupTargetInDatabaseFolderError,
  BackupWriteError,
  type DatabaseBackup,
  isInDatabaseFolder,
} from "@/business/backup";
import type { Database } from "@/persistence/database";

/**
 * {@link DatabaseBackup} of the app (#32): SQLite writes the copy itself
 * (`VACUUM INTO`, {@link Database.backupTo}) – in the Rust process, so the
 * fs plugin's scope does not apply to that write.
 *
 * 1. **Guard first:** a target in the folder of the live database (the
 *    database itself, its journal, any file there or below) is refused with
 *    {@link BackupTargetInDatabaseFolderError} before anything is written.
 *    Emptying `belegwerk.db` would destroy all data: SQLite opens it with
 *    write sharing, so truncating it succeeds and the following `VACUUM INTO`
 *    then fails.
 * 2. `VACUUM INTO` refuses a target that exists and is not empty, but the save
 *    dialog lets the user pick an existing file (after asking to replace it).
 *    So the picked file is created or truncated to zero bytes with
 *    `writeTextFile(path, "")` – the permission the CSV export already has
 *    (`fs:allow-write-text-file`), and the dialog put exactly this path into
 *    the fs scope. No `fs:allow-remove`/`rename`/`copy-file` and no temporary
 *    file that would need a static scope (docs/architecture.md,
 *    "Backup (#32)").
 * 3. If writing or checking fails, the file is truncated again (best effort):
 *    an empty file is plainly no backup, a half-written one might pass for
 *    one. The error is a {@link BackupWriteError} saying whether the target
 *    had been emptied.
 */
export function createTauriDatabaseBackup(
  database: Pick<Database, "backupTo" | "mainFilePath">,
): DatabaseBackup {
  return {
    writeTo: async (path) => {
      const databaseFile = await database.mainFilePath();
      // Unknown location (in-memory database): the guard cannot work.
      if (databaseFile === "") throw new Error("The database file path is unknown");
      if (isInDatabaseFolder(path, databaseFile)) throw new BackupTargetInDatabaseFolderError();

      try {
        await writeTextFile(path, "");
      } catch (error) {
        throw new BackupWriteError(false, { cause: error });
      }
      try {
        await database.backupTo(path);
      } catch (error) {
        await writeTextFile(path, "").catch(() => undefined);
        throw new BackupWriteError(true, { cause: error });
      }
    },
  };
}
