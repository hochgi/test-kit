# @hochgi/test-kit-sql

Shared probe surface and `SqlDriver` seam for SQL-family adapters. This
package is the foundation that the per-ORM packages
(`@hochgi/test-kit-pg-kysely`, `@hochgi/test-kit-pg-knex`,
`@hochgi/test-kit-pg-sequelize`) plug into.

You typically do **not** install this directly. Install the per-ORM
package matching your database boundary:

- [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md)
- [`@hochgi/test-kit-pg-knex`](../pg-knex/README.md)
- [`@hochgi/test-kit-pg-sequelize`](../pg-sequelize/README.md)

## What lives here

- `QueryCall`, `QueryPendingCall`, `QueryProbe` — the call shape and
  probe API every SQL adapter exposes. `QueryCall` is `{ sql, parameters }`
  only. `QueryProbe` adds `sql(...)` sugar and inherits `calls`.
- `SqlDriver` — the seam each per-ORM package implements:
  `onApplicationQuery`, `reset`, and `close`.
- `createProbedSqlAdapter({ harness: rig, driver })` — the helper that
  constructs the probe, installs the default forward rule, and returns
  `{ probe, probeRoot }`.

The package has zero dependencies on PGlite or any specific ORM. It is
pure types and glue.

## Adding a new ORM

To add a new SQL ORM (e.g. Drizzle, TypeORM):

1. Implement a `SqlDriver` for it.
2. Construct your ORM's adapter atop
   [`@hochgi/test-kit-pglite-driver`](../pglite-driver/README.md) (or
   another Postgres-compatible store).
3. Wire them with `createProbedSqlAdapter`.

See [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/internal/tech-design.md`](../../docs/internal/tech-design.md) for
the full contributor walkthrough.
