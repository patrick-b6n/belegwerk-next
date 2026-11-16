/**
 * Auto-update from GitHub releases (#71). The Tauri host does the network
 * access and replaces the exe (src-tauri/src/updater.rs); business only
 * defines the port and the small amount of logic around it
 * (docs/architecture.md, "Auto-update (#71)").
 */

/** Result of an update check. */
export interface UpdateCheck {
  /** Version of the running app as CalVer, e.g. `"2026-11-14-2000"` (`"0.0.0"` in development). */
  readonly currentVersion: string;
  /** Version of the latest release on GitHub (tag without `v`, CalVer). */
  readonly latestVersion: string;
  /** Whether the latest release is newer than the running app (SemVer). */
  readonly updateAvailable: boolean;
  /** The release page with the release notes (GitHub). */
  readonly releaseUrl: string;
}

/** Download progress of {@link Updater.install}, in bytes. */
export interface DownloadProgress {
  readonly downloaded: number;
  readonly total: number;
}

/**
 * Why a check or an update failed – the codes of the host plus `unexpected`
 * (anything without a code, e.g. a failed IPC call). The UI translates them.
 */
export type UpdateErrorKind =
  /** No connection to GitHub (offline, DNS, TLS, timeout). */
  | "network"
  /** GitHub answered with an error status (e.g. rate limit). */
  | "http"
  /** No release has been published yet. */
  | "noRelease"
  /** The release is unusable (tag, assets, checksum file, size). */
  | "invalidRelease"
  /** The download does not match the published SHA-256. */
  | "checksumMismatch"
  /** There is no newer version (anymore). */
  | "noUpdate"
  /** Development build (`pnpm tauri dev`): the exe is never replaced. */
  | "devBuild"
  /** Downloading next to the exe or replacing it failed (e.g. no write access). */
  | "fileSystem"
  /**
   * The new exe could not be moved in and the old one not back: the exe is
   * missing, the old version is at {@link UpdateError.path} (`<exe>.old`).
   */
  | "rollbackFailed"
  /** Another update is already being installed. */
  | "alreadyRunning"
  /** Anything else (also errors without a code, e.g. a failed IPC call). */
  | "unexpected";

export const UPDATE_ERROR_KINDS: readonly UpdateErrorKind[] = [
  "network",
  "http",
  "noRelease",
  "invalidRelease",
  "checksumMismatch",
  "noUpdate",
  "devBuild",
  "fileSystem",
  "rollbackFailed",
  "alreadyRunning",
  "unexpected",
];

/** Failure of {@link Updater}; `message` is technical detail for the console. */
export class UpdateError extends Error {
  readonly kind: UpdateErrorKind;
  /** For `rollbackFailed`: the parked old exe (`<exe>.old`) to rename back. */
  readonly path: string | null;

  constructor(
    kind: UpdateErrorKind,
    message: string,
    options?: ErrorOptions & { readonly path?: string | null },
  ) {
    super(message, options);
    this.name = "UpdateError";
    this.kind = kind;
    this.path = options?.path ?? null;
  }
}

/** Port to the host (`src/app/tauri-updater.ts`). */
export interface Updater {
  /**
   * Asks GitHub for the latest release.
   *
   * @throws {UpdateError}
   */
  check(): Promise<UpdateCheck>;
  /**
   * Downloads the latest release, verifies its SHA-256, replaces the exe and
   * restarts the app – on success the promise never settles (the app is
   * gone). On failure the installed version is unchanged, except for
   * `rollbackFailed`.
   *
   * @throws {UpdateError}
   */
  install(onProgress: (progress: DownloadProgress) => void): Promise<void>;
  /** Opens a release page in the default browser. */
  openReleasePage(url: string): Promise<void>;
}

export interface UpdateService {
  /**
   * "Check for updates" in the settings.
   *
   * @throws {UpdateError}
   */
  check(): Promise<UpdateCheck>;
  /**
   * The check at startup: never fails – an error (offline, GitHub down) is
   * only logged and yields `null`, so no dialog appears.
   */
  checkInBackground(): Promise<UpdateCheck | null>;
  /** "Jetzt aktualisieren"; see {@link Updater.install}. */
  install(onProgress: (progress: DownloadProgress) => void): Promise<void>;
  /** "Release-Notes" of a check result. */
  openReleaseNotes(check: UpdateCheck): Promise<void>;
}

export interface UpdateServiceDependencies {
  readonly updater: Updater;
  /** Where errors of the background check go; defaults to `console.warn`. */
  readonly logError?: (message: string, error: unknown) => void;
}

export function createUpdateService({
  updater,
  logError = (message, error) => console.warn(message, error),
}: UpdateServiceDependencies): UpdateService {
  return {
    check: () => updater.check(),
    checkInBackground: async () => {
      try {
        return await updater.check();
      } catch (error) {
        logError("Background update check failed", error);
        return null;
      }
    },
    install: (onProgress) => updater.install(onProgress),
    openReleaseNotes: (check) => updater.openReleasePage(check.releaseUrl),
  };
}

/**
 * Download progress in whole percent (0–100, rounded down so 100 means
 * complete); `null` while the size is unknown.
 */
export function downloadPercent(progress: DownloadProgress): number | null {
  if (!(progress.total > 0)) return null;
  const percent = Math.floor((progress.downloaded / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
}
