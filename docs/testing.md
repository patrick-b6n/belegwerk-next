# Tests

Tests run with **Vitest** in the **Node environment**
([`vitest.config.ts`](../vitest.config.ts)).

| Script            | Purpose                                |
| ----------------- | -------------------------------------- |
| `pnpm test`       | run all tests once (for CI, #7)        |
| `pnpm test:watch` | watch mode: re-runs the affected tests |

Single files or test names: `pnpm test src/business/format` or
`pnpm test -t "parseAmount"`.

## Location and naming

- Tests live **next to the code** as `<file>.test.ts`, e.g.
  `src/business/format/currency.ts` → `currency.test.ts`. Vitest collects
  `src/**/*.test.{ts,tsx}`.
- **Test helpers** that are not tests themselves (fakes, fixtures, DB
  helpers) live in a `__tests__/` folder inside the respective layer, e.g.
  `src/business/__tests__/` or `src/persistence/__tests__/`. That way the
  same layer boundaries apply to them as to the code next to them.
- Under `src/routes`, `*.test.ts[x]` and `__tests__/` are ignored by the
  router (`routeFileIgnorePattern` in `vite.config.ts`), so tests can live
  next to the routes too.
- Production code **never** imports from `*.test.ts` or `__tests__/`.
- Import APIs explicitly (`import { describe, expect, it } from "vitest"`),
  no globals.

## Layers

- **Business** (`src/business`): pure unit tests. Repositories and platform
  access are replaced by **in-memory fakes** of the interfaces:
  `createInMemoryDatabase({ clock })` from
  `src/business/__tests__/in-memory-repositories.ts` returns `repositories`
  and `unitOfWork` (with rollback). The fakes throw if the outer repositories
  or a nested `run` are used inside `unitOfWork.run` (a deadlock in the app).
  The business lint rules apply to tests as well – no Drizzle, no
  `better-sqlite3`, no React/Tauri.
- **Contract tests** (`src/business/__tests__/repository-contract.ts`):
  `describeRepositoryContract(name, setup)` runs against the fakes and
  against the Drizzle repositories on `better-sqlite3`
  (`src/persistence/repositories/repositories.test.ts`). New repository
  methods get their cases there, so fakes and DB stay in sync and every query
  runs against SQLite.
- **Persistence** (`src/persistence`): tests against **`better-sqlite3`**
  with the same Drizzle schema and the same migrations as the app (#11):
  `await createTestDb()` from `src/persistence/__tests__/test-db.ts` returns
  a fresh in-memory database per test – through the same path as the app
  (`openDatabase`: own migrator, `sqlite-proxy` adapter), only the plugin is
  replaced by a `better-sqlite3` client ([Data model](data-model.md)).
  Queries are therefore asynchronous. `dbError(query)` returns the error
  messages of a failing query including `cause` (Drizzle wraps SQLite
  errors). The test client rejects duplicate result column names, which the
  plugin would silently merge.
- **UI**: no tests so far. Should DOM tests later need an environment like
  `jsdom`, it can be set per file via `// @vitest-environment jsdom`.

## TypeScript

Test code runs in Node, the app in the WebView. That is why there is a
separate project [`tsconfig.test.json`](../tsconfig.test.json):

- covers `src/**/*.test.ts`, `src/**/*.test.tsx` and `src/**/__tests__/`,
- inherits all options from `tsconfig.app.json` (including the `@/*` alias),
- additionally has **Node types** (`node:fs`, `process`, `better-sqlite3`, …).

`tsconfig.app.json` excludes exactly these files so Node types do not leak
into the WebView code: `process` or `node:*` in regular code under `src/`
stays a type error. `pnpm typecheck` checks all projects.

## Time zone

The tests run in `Pacific/Pago_Pago` (UTC−11, no daylight saving time), set
in `vitest.config.ts`. Code that accidentally computes in local time thus
fails on UTC runners too. A test in `src/business/format/date.test.ts` makes
sure the setting takes effect.

## Coverage

Deliberately not set up yet (would need `@vitest/coverage-v8`). Add it when
needed.
