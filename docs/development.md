# Development

## Prerequisites

| Tool                | Version                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows             | 10/11 (the app is built for Windows only)                                                               |
| Node.js             | ≥ 26 (`engines` in `package.json`)                                                                      |
| pnpm                | 12, exact version via `packageManager` in `package.json` (e.g. with `corepack enable`)                  |
| Rust                | stable, at least 1.90 (`rust-version` in `src-tauri/Cargo.toml`), MSVC toolchain                        |
| WebView2 Runtime    | see [Installation](handbuch.md#installation)                                                            |
| Tauri prerequisites | Microsoft C++ Build Tools, see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) |

## Setup

```sh
pnpm install
pnpm tauri dev   # starts Vite (port 1420) and the desktop window
```

`pnpm dev` on its own only starts Vite; a regular browser has no Tauri and no
database, so the app shows "Belegwerk läuft nur als Desktop-App". If the
release `.exe` is running, `pnpm tauri dev` exits immediately and brings that
window to the front (single instance per app) – close the `.exe` first.

The development build uses its own database,
`%APPDATA%\de.belegwerk.desktop\belegwerk-dev.db`; the real data in
`belegwerk.db` is never touched while developing and testing. To test with
real data, put a copy of `belegwerk.db` under that name (close the app first).

If the development database is empty (no bookings), the development build
seeds it on startup with sample data: about 14 months of bookings up to today
(`src/app/dev-sample-data.ts`). To start over, delete `belegwerk-dev.db` and
restart the app. Release builds do not contain this code.

## Scripts

| Script              | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`          | Vite dev server (frontend only, see above)                                 |
| `pnpm build`        | Build the frontend (`dist/client`)                                         |
| `pnpm tauri …`      | Tauri CLI, e.g. `pnpm tauri dev`, `pnpm tauri build --no-bundle`           |
| `pnpm typecheck`    | Compile Paraglide messages, then `tsc -b`                                  |
| `pnpm lint`         | oxlint (including layer boundaries), warnings are errors                   |
| `pnpm format`       | oxfmt: format                                                              |
| `pnpm format:check` | oxfmt: check only                                                          |
| `pnpm test`         | Vitest, run all tests once                                                 |
| `pnpm test:watch`   | Vitest in watch mode                                                       |
| `pnpm db:generate`  | drizzle-kit: generate a migration from the schema                          |
| `pnpm i18n:compile` | Compile Paraglide messages to `src/paraglide/`                             |
| `pnpm verify`       | `format:check`, `lint`, `typecheck`, `test` – before every commit/release  |
| `pnpm release`      | Build the release `.exe` and copy it to `release/` ([Release](release.md)) |

## CI

GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) on
`windows-latest` for every pull request: format check, lint, typecheck, tests,
a check that the migrations match the schema (`pnpm db:generate` produces no
changes), and `pnpm tauri build --no-bundle`. The built `.exe` is kept for 7
days as a run artifact for trying it out.

CI does not run again on `main`. Instead, every push starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml) and
creates a release: the same checks (including migrations), a version from the
current UTC time (strictly greater than the last release tag, otherwise that
tag + 1 minute), the build, and a GitHub release with `.exe` and `.sha256`
plus the tag `v<YYYY-MM-DD-HHMM>` on the commit. Only one run is active at a
time; a new push cancels the running one
([Release](release.md#publishing-a-release-71-74)).

## Architecture

Tauri v2 is only the host (window, SQLite, file dialogs, HTTP, auto-update);
all logic runs in TypeScript inside the WebView – TanStack Start in SPA mode
with TanStack Router/Query/Table/Form, shadcn/ui and Tailwind. Persistence via
`tauri-plugin-sql` and Drizzle ORM (`sqlite-proxy`), UI texts via Paraglide JS
(German only).

```
src/routes ─┬──────────────────► src/app ──────────────┐
src/ui ─────┤                   (composition root)     │ wires up
            │                        │                 ▼
            └──► src/business ◄──────┴────────── src/persistence
```

Arrows = "imports from".

| Layer             | Contents                                                                               |
| ----------------- | -------------------------------------------------------------------------------------- |
| `src/routes`      | File-based routes, thin: read parameters, call services, render UI                     |
| `src/ui`          | Presentation: components, styles, shadcn/ui                                            |
| `src/business`    | Domain logic, validation, services and repository interfaces – no React, no Tauri      |
| `src/persistence` | Drizzle schema, migrations, implementations of the repository interfaces               |
| `src/app`         | Composition root: opens the DB, migrates, creates services and provides them to the UI |

UI and routes reach data only through services from `src/app`; business does
not know persistence (dependency inversion). oxlint enforces the boundaries
(`no-restricted-imports`, [`.oxlintrc.json`](../.oxlintrc.json)).

Further reading (in German):

- [Architektur](architecture.md) – layers, services, routes, Stripe, backup
- [Datenmodell](data-model.md) – tables, EÜR positions and calculation, migrations, backup
- [i18n & Formatierung](i18n.md) – Paraglide, format helpers
- [Tests](testing.md) – Vitest, fakes, persistence tests
- [Release](release.md) – release on every push to `main`, auto-update, building the `.exe`, versioning, storage locations
