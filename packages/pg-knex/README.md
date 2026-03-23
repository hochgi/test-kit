# @vnatures/test-kit-pg-knex

PGlite-backed **Knex** test database for component tests, with optional **DbProbe** (same plumbing/porcelain model as `@vnatures/test-kit-pg-kysely`).

Uses [`knex-pglite`](https://www.npmjs.com/package/knex-pglite) and requires **Knex 3.x**.

## Install

```bash
npm install @vnatures/test-kit-pg-knex knex
```

## Quick start

```typescript
import knexStringcase from 'knex-stringcase';
import { createTestDb } from '@vnatures/test-kit-pg-knex';
import type { Knex } from 'knex';

async function bootstrap(db: Knex) {
    await db.schema.createTable('users', (t) => {
        t.increments('id').primary();
        t.string('name').notNullable();
    });
}

const testDb = await createTestDb({
    // Same camelCase ↔ snake_case behavior as production `Knex(knexStringcase({...}))`
    knexConfig: knexStringcase({}),
    bootstrap,
});
```

## API

### `createTestDb(options)`

- `bootstrap(db: Knex)`: idempotent DDL (use `IF NOT EXISTS` where needed).
- `knexConfig?`: merged into the internal config; `client`, `connection`, and `pool` are ignored.

Returns `TestDb`:

- `db`: `Knex` instance (PGlite).
- `reset()`: drop user tables in `public`, re-run `bootstrap`.
- `seed(table, rows)`: insert rows; JSON-serializes plain objects for JSONB-like columns.
- `close()`: destroy Knex / close PGlite.

### `createProbedTestDb(options)`

Same options as `createTestDb`, plus `probe: DbProbe` on the returned object. Application code should use `db`; `reset` / `seed` use an internal unprobed Knex so cleanup is not blocked by probe behavior.

### `DbProbe`

Same semantics as pg-kysely: `expectNext`, `expectMatching`, `whenQueried`, `alwaysForward`, `alwaysReject`, `clearBehavior`, `drain*`, `queries`, etc.

## Plumbing: `expectNext` and Knex scheduling

Knex may start the query runner in the same synchronous turn as building the chain. Register the waiter **before** the query is scheduled, e.g.:

```typescript
const pendingPromise = probe.expectNext();
const queryPromise = new Promise((resolve, reject) => {
    setImmediate(() => {
        appDb('orders').select('*').then(resolve).catch(reject);
    });
});
const pending = await pendingPromise;
pending.forward();
await queryPromise;
```

## Why `connection` is a function

Knex deep-clones a plain `{ pglite }` connection object, which breaks PGlite internals. This package uses `connection: () => ({ pglite })`, as supported by `knex-pglite`.

## Scripts

`npm test` sets `NODE_OPTIONS=--experimental-vm-modules` (required by `@electric-sql/pglite`).
