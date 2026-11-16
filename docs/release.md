# Release (#33, #71, #74)

Belegwerk ships as a **single `.exe`** – no installer (no NSIS/MSI), no code
signing. **Every push to `main` creates a GitHub release**; the app updates
itself from it ([Auto-update](#auto-update-71)).

## Version scheme (#71)

Versions are the **release date and time in UTC** (CalVer, no separator
between hour and minute): `YYYY-MM-DD-HHMM`, e.g. `2026-11-14-2000` for
14 Nov 2026, 20:00 UTC. This applies to published releases and local builds
alike, independent of the machine's time zone and without jumps at daylight
saving changes. The time is therefore **not German local time**: a release at
20:00 in Berlin is called `…-1900` in winter (CET, UTC+1) and `…-1800` in
summer (CEST, UTC+2). That is how the tag (`v2026-11-14-2000`), the release
and the assets (`belegwerk-2026-11-14-2000.exe`) are named, and how the app
(settings, update notice, log) shows the version.

Tauri and the Windows file version need SemVer with numbers up to 65535 and
no leading zeros. Internally (package.json, `.exe`) the version is therefore
`YYYY.(MM*100+DD).(HH*100+MM)`: `2026-11-14-2000` → `2026.1114.2000`,
`2026-01-05-0930` → `2026.105.930`. The order is preserved. The conversion in
both directions lives in `src/business/updates/calver.ts` (scripts, workflow,
UI) and in `src-tauri/src/updater.rs` (updater), each with tests.

**Nobody maintains the version by hand.** `package.json` has the committed
placeholder `0.0.0` (development; the updater treats it as older than any
release, but debug builds never install anything). The version is created in
the release workflow or when building locally; the `version` in
`src-tauri/Cargo.toml` is not used.

## Publishing a release (#71, #74)

There is no manual step: **every push to `main`** (i.e. every merged pull
request) starts `.github/workflows/release.yml` (windows-latest, same setup
as CI). The workflow can be started by hand via "Run workflow"
(`workflow_dispatch`) – only on `main`; on other branches the job is skipped.

1. `pnpm verify` and the migration check (`pnpm db:generate` produces no
   changes) – CI (`ci.yml`) only runs for pull requests; on `main` this
   workflow is the only check.
2. **Determine the version** (`scripts/release-version.ts`): the current time
   in **UTC** as `YYYY-MM-DD-HHMM` (`calVerFromDate`). The workflow fetches
   the existing `v*` tags via the GitHub API (`git/matching-refs/tags/v`). If
   the time is **not strictly greater** than the highest release tag
   (compared in SemVer form), the version becomes **highest tag + 1 minute**
   (`nextReleaseCalVer`, carrying over into hour, day, month and year) – e.g.
   for two pushes in the same minute or a clock running behind. So the run
   neither fails nor waits; the version is at most a few minutes ahead of
   the clock.
3. Build with `node scripts/release.ts --calver <version>`: sets the SemVer
   form in `package.json` (only in the CI checkout, not committed), same
   release profile as CI, checks the file version of the `.exe`.
4. `gh release create "v<version>" --target <commit> --generate-notes
   --latest`: creates the tag `v<version>` on the built commit and the GitHub
   release "Belegwerk `<version>`" with the assets `belegwerk-<version>.exe`
   and `belegwerk-<version>.exe.sha256`. The release is not a pre-release
   and is marked "Latest" – exactly what the app reads (`releases/latest`).
   `gh` uploads the assets before publishing the release – so the app never
   sees a release without assets.

**Only the current state:** At the start and again right before
`gh release create`, the job checks that the built commit (`GITHUB_SHA`) is
still the head of `main` (`gh api repos/…/commits/main`). Otherwise it ends
successfully without a release, with a note in the log – e.g. when re-running
an old run or when `main` moved on during the build. The newer run then
publishes the commits; an older state never becomes "Latest".

**Only one run:** All runs on `main` share a concurrency group
(`<workflow>-<ref>`) with `cancel-in-progress: true`. A new push cancels the
running (or waiting) run; the new run's release then contains its commits
too. A cancelled run has not created a tag yet; the new run determines the
version from the existing tags. Likewise, in CI a new push to a pull request
cancels its running check.

This job is the only one with `contents: write`; the checkout does not store
credentials (`persist-credentials: false`), `gh` uses the `GITHUB_TOKEN`.
This job saves the Cargo cache of `main` (`shared-key: tauri-release`, the
same key as in `ci.yml`); CI runs in pull requests only restore it.
Pre-releases (marked "Pre-release" on GitHub) and drafts are not returned by
the API under `releases/latest`, so the app never offers them.

## Building locally

```sh
pnpm verify    # format:check, lint, typecheck, test
pnpm release   # builds the .exe
```

Local builds are **not published** – releases are only created by the
workflow ([Publishing a release](#publishing-a-release-71-74)).

`pnpm release` (`scripts/release.ts`):

1. Version = current time in UTC (`YYYY-MM-DD-HHMM`, as in the workflow) or
   `--calver <YYYY-MM-DD-HHMM>` (that is how the workflow calls it). The
   SemVer form goes into `package.json` for the build and is restored
   afterwards (also on errors and Ctrl+C).
2. `pnpm tauri build --no-bundle` – build the frontend (`pnpm build`,
   `beforeBuildCommand`), compile Rust in the release profile, embed the
   frontend in the `.exe`. `--no-bundle` skips the installers.
3. Copies `src-tauri/target/release/belegwerk.exe` to
   `release/belegwerk-<version>.exe` and writes the checksum to
   `release/belegwerk-<version>.exe.sha256` (`sha256sum` format). If the
   `.exe` is running (file locked), it aborts with a message.
4. Checks that the file version of the `.exe` matches the SemVer form (also
   with a trailing `.0`; aborts otherwise).
5. Prints path, version, size and SHA-256. Builds are not bit-for-bit
   reproducible; the checksum only identifies this file.

`release/` is git-ignored. The checks deliberately do not run in
`pnpm release` (the build takes a few minutes anyway; CI checks every
commit) – so run `pnpm verify` before a release. If there are uncommitted
changes, the script warns (but does not abort).

Verify the checksum: `Get-FileHash belegwerk-2026-11-14-2000.exe`
(PowerShell) or `sha256sum -c belegwerk-2026-11-14-2000.exe.sha256`.

## Version, name, icon

- **Version:** `version` in `package.json` – committed `0.0.0`, in the
  release build the SemVer form of the CalVer
  ([Version scheme](#version-scheme-71)). `src-tauri/tauri.conf.json` points
  to it with `"version": "../package.json"`; `tauri-build` writes it into the
  `.exe` as file and product version. Since `tauri-build` only re-runs when
  `tauri.conf.json` changes, `src-tauri/build.rs` additionally registers
  `package.json` as a dependency (`cargo:rerun-if-changed`) – otherwise
  incremental builds would keep the old version in the `.exe` after a version
  bump. The `version` in `src-tauri/Cargo.toml` is not used.
- **Name:** `productName` "Belegwerk" → product name and file description,
  `bundle.publisher` "Belegwerk" → company.
- **Icon:** `src-tauri/icons/icon.ico` is embedded as a resource (Explorer,
  taskbar, window).

Check: `(Get-Item release\belegwerk-2026-11-14-2000.exe).VersionInfo | Format-List`
(file version `2026.1114.2000`).

## Release profile

`[profile.release]` in `src-tauri/Cargo.toml`:

| Setting         | Value  | Reason                                                  |
| --------------- | ------ | ------------------------------------------------------- |
| `codegen-units` | `1`    | LLVM optimises the whole crate at once                  |
| `lto`           | `true` | Link-time optimisation across all crates (fat LTO)      |
| `opt-level`     | `"s"`  | optimised for size                                      |
| `strip`         | `true` | remove debug symbols                                    |
| `panic`         | –      | stays `unwind`: a panic only ends the call, not the app |

Measured (Windows, Rust 1.99): without a profile 20.4 MB, with
`opt-level = 3` 17.9 MB, with `opt-level = "s"` 13.1 MB. The Rust side only
registers plugins, the runtime depends on WebView2 and SQLite; `"s"` therefore
gives a noticeably smaller size without a noticeable startup penalty. Cost:
the release build takes longer (locally, dependencies cached: about
1.5–2.5 min instead of about 0.5 min). CI builds the same profile.

## Starting

- The `.exe` starts from any folder (including spaces/umlauts in the path);
  it needs no other files.
- **No console window:** `src-tauri/src/main.rs` sets
  `windows_subsystem = "windows"` in release builds.
- **Single instance:** `tauri-plugin-single-instance` (first plugin in
  `src-tauri/src/lib.rs`). A second start exits immediately and brings the
  running window to the front (also from minimised state). So two processes
  never open the same database. This also applies to development: if the
  release `.exe` is running, `pnpm tauri dev` exits immediately and brings
  the `.exe`'s window to the front (same identifier, same database) – close
  the `.exe` first.
- **WebView2:** The WebView2 Runtime is required (preinstalled on Windows 11,
  usually present via Edge on Windows 10). If it is missing, the `.exe` shows
  a Tauri error message ("Could not find the WebView2 Runtime", with a link to
  the Microsoft download) and exits. The setting
  `bundle.windows.webviewInstallMode` only applies to installers and has no
  effect here.

### Unsigned .exe: SmartScreen

The `.exe` is not signed. If it was downloaded (Mark of the Web), Windows
shows "Der Computer wurde durch Windows geschützt" ("Windows protected your
PC", publisher: "Unbekannter Herausgeber") on first start. Start it via
**"Weitere Informationen" → "Trotzdem ausführen"** ("More info" → "Run
anyway"). Alternatively tick "Zulassen" ("Unblock") in the file properties
beforehand (removes the download mark).

## Auto-update (#71)

Tauri's updater plugin requires an installer or an archive; for a single
`.exe` Belegwerk handles the swap itself (`src-tauri/src/updater.rs`, Tauri
commands `check_for_update` and `install_update`; for the frontend see
[Architecture](architecture.md#auto-update-71)).

**Check** – in the background on startup and via "Nach Updates suchen" in the
settings: `GET https://api.github.com/repos/patrick-b6n/belegwerk-next/releases/latest`
(public repository, no token; user agent `Belegwerk-Updater`, no personal
data), convert the tag `v<YYYY-MM-DD-HHMM>` to SemVer form and compare it
with the running version. If it is newer, the top bar shows a notice with the
version, a link to the release notes (default browser) and "Jetzt
aktualisieren". Without network or on GitHub errors nothing appears on
startup, only a log entry.

**Update** ("Jetzt aktualisieren"):

1. Query the release from GitHub again (the app does not trust URLs from the
   WebView) and check that it is newer.
2. Download `belegwerk-<version>.exe.sha256` (`sha256sum` format), then
   `belegwerk-<version>.exe` to `<exe>.update` **next to** the running `.exe`
   (same drive; an old `.update` is deleted first, then the file is created
   exclusively); then check size and SHA-256 of the file on disk. The
   `.sha256` may be at most 4 KB. Both URLs must be downloads of this
   repository.
3. Swap: rename the running `.exe` → `<exe>.old` (Windows allows renaming a
   running program, not overwriting it), then `<exe>.update` → `<exe>`. If
   the second step fails, the first one is undone.
4. Restart (`app.restart()`); on startup the new version deletes `<exe>.old`
   (and any leftover `<exe>.update`).

Until the swap, the only file that changes next to the `.exe` is
`<exe>.update`, which is deleted on any error: **on errors the old version
stays untouched**, and the app shows a message (no connection, wrong
checksum, no write access to the `.exe`'s folder …).

- **File name:** The update replaces the `.exe` under its current name.
  Whoever downloaded `belegwerk-2026-11-14-2000.exe` keeps that name after
  updates, even when it long contains a newer version. Recommendation: rename
  the downloaded file to `belegwerk.exe` before the first start (shortcuts
  then stay valid too).
- **Only one update at a time:** A second call while one is running (notice
  and settings) fails with "Das Update wird bereits installiert.".
- **Rollback failed:** If the new `.exe` cannot be put in place and the old
  one cannot be renamed back afterwards (very unlikely, e.g. when a virus
  scanner locks the file), the `.exe` is missing. The message then names the
  file `<exe>.old`; it has to be renamed back by hand (remove the `.old`
  extension).
- **Development mode** (`pnpm tauri dev`, debug build): `install_update`
  refuses, nothing is ever replaced. Test only with a release `.exe`.
- **Write access:** The `.exe` must be in a folder the user can write to
  (e.g. not under `C:\Program Files`); otherwise the update reports an error
  and stays on the old version.
- **SmartScreen:** The `.exe` downloaded by the app has no download mark
  (Mark of the Web); SmartScreen does not ask again after the update.
- **Database:** stays where it is; pending migrations run on restart.
- **Permissions:** The commands are declared in the app manifest
  (`src-tauri/build.rs`) and can only be called with `allow-check-for-update`
  or `allow-install-update`; the opener may only open
  `https://github.com/patrick-b6n/belegwerk-next/releases/*`
  (`src-tauri/capabilities/default.json`). The CSP stays unchanged – the
  requests run in Rust (`reqwest` with rustls, the same TLS stack as
  `tauri-plugin-http`).

Updating by hand still works: close the app, replace the `.exe` with the new
one.

## Data

The data is **not** stored next to the `.exe` but in the user profile:

| What             | Location                                        |
| ---------------- | ----------------------------------------------- |
| Database         | `%APPDATA%\de.belegwerk.desktop\belegwerk.db`   |
| Log              | `%LOCALAPPDATA%\de.belegwerk.desktop\logs`      |
| WebView2 profile | `%LOCALAPPDATA%\de.belegwerk.desktop\EBWebView` |

A new version (auto-update or by hand) only replaces the `.exe`; the database
stays, pending migrations run on startup ([Data model](data-model.md)).
Uninstall: delete the `.exe`, optionally the two folders (create a backup
first, see [Backup](architecture.md#backup-32)).
