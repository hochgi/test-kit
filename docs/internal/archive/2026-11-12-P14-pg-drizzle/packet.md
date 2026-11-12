# P14 pg-drizzle: probed Drizzle over PGlite

Ticket: none
Depends on: nothing

Scope: new packages/pg-drizzle/
Goldilocks: just right
  Justification: the SUT gets a real `PgliteDatabase<TSchema>`, the same
  Drizzle seam it uses in prod. The adapter intercepts only at the PGlite
  client, below Drizzle. Pooling, retries and transaction orchestration stay
  in the component.

Adapter category: backed
Call shape: `{ sql, parameters }` (existing `QueryCall`)
  Seam: a thin proxy over the PGlite instance. `query()` goes through
  `recordCall`. `transaction(cb)` runs the real transaction but hands `cb` a
  proxied tx client whose `query()` is also probed. Every other member passes
  through. Verified in drizzle-orm 0.45.4 (`pglite/session.js`): every
  statement (query builder, relational `db.query.*`, raw `db.execute`,
  prepared queries) ends in `client.query(sql, params, { rowMode, … })`;
  transactions use `client.transaction(async (tx) => …)`; nested
  transactions are savepoints on the same tx client.
  Results: forward returns PGlite's real result. `answer()` is inherited from
  core and passes through to Drizzle unchanged; it is not a featured path for
  this backed adapter and gets no row-shape conversion.
Backing: PGlite via `@hochgi/test-kit-pglite-driver` (`@electric-sql/pglite` ^0.3.2, as siblings)
Lifecycle: ProbedResource — `reset()` truncates all user tables then re-runs
  `bootstrap`; `close()` disposes the handle. Mirror pg-kysely, including
  disposing the handle and rethrowing when `bootstrap` throws.
Filter sugars: none beyond existing `sql(match)` and `filter()`
Default rule: probe.always().forward()
SqlDriver: yes (packages/sql)
Factory: createProbedDrizzleAdapter
Package: @hochgi/test-kit-pg-drizzle

## Shape

- Options: `{ harness, schema?, bootstrap: (db: PgliteDatabase<TSchema>) => Promise<void>, role?: string, extensions?, defaultTimeout? }`.
  `bootstrap` runs on an unprobed maintenance Drizzle instance over the same
  PGlite. The caller supplies DDL, raw or via Drizzle's `migrate()`; no
  migration helper ships.
- Return: `ProbedAdapterWithLifecycle<PgliteDatabase<TSchema>, QueryProbe>`
  plus `seed(table, rows)`, `pglite`, `notifications` (mirrors pg-kysely).
  `seed` takes a Drizzle `PgTable` with rows typed `table.$inferInsert`, and
  writes through the maintenance connection (unprobed).
- `role?: string` — minimum needed for an RLS app to behave truthfully.
  PGlite's default user is superuser `postgres`, which bypasses RLS, and a
  session-wide `SET ROLE` breaks `reset()` (TRUNCATE denied). So when set,
  `SET LOCAL ROLE <role>` is the first, **unprobed** statement of every
  probed transaction, and a non-tx `query` is wrapped in a short transaction
  that does the same. Bootstrap, seed and reset stay on the owner role.
  Nothing more general.
- Peer deps: `drizzle-orm` (0.45.x verified; widen only down to the oldest
  version with the same pglite session shape; cap `<1`, 1.0 is in beta) and
  `@electric-sql/pglite`.

## Known constraints to specify (not fix)

- PGlite runs one transaction at a time. While a query in transaction A is
  parked, transaction B cannot begin, and neither can a plain query.
  Concurrent queries inside the same transaction (or outside any transaction)
  can be released in any order. Cross-transaction ordering is a documented
  limitation: scenario + README.
- Nested `tx.transaction()` produces probed `savepoint` / `release savepoint`
  calls; a catch-all rule matches them. BEGIN/COMMIT are not probed.

## Consumer acceptance example

`examples/pg-drizzle-rls` (next to `examples/grpc-client`), run in CI,
mirroring the first consumer's (sensi-sor-api) per-request-transaction RLS
pattern: role `app_rt`, a `clients` table whose `customer_id` defaults from
`current_setting('app.customer_id', true)`, RLS + tenant policy, grants; a
tiny `forTenant(id).transaction(work)` service that calls
`set_config('app.customer_id', …, true)` then runs Drizzle queries. Tests:
tenant isolation with two seeded tenants; a probe-rejected write rolls back;
a probe-hung read times out and the next request still works; the probe sees
`set_config` before the repository query.

Wiring: add `packages/pg-drizzle` and the example to the explicit
`test.projects` list in root `vitest.config.ts`.

## Alternatives rejected

- Subclassing Drizzle's `PgSession` / `PgPreparedQuery`: deeper internals,
  fragile across versions.
- Drizzle's `logger` hook: observe-only; cannot forward-gate, delay or reject.
- Probing BEGIN/COMMIT: siblings don't; family consistency is a requirement.

Out: Prisma; Python consumers; other Drizzle drivers (`postgres-js`,
`node-postgres`); streaming and cursors; migration helpers; probing
BEGIN/COMMIT; multi-connection / cross-transaction concurrency (a
Testcontainers Postgres backing would be its own packet, only if a real
consumer needs it); lazy/deferred transactions or any workaround for
PGlite's transaction lock; any change to sensi-sor-api (its
`PostgresJsDatabase` type widening is a separate, later task).

Size: ~200 lines of src, ~25–30 tests including the example, against a
~40-test split. If it goes over, split `role` into its own packet.
