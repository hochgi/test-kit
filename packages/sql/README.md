# @vnatures/test-kit-sql

Shared probe surface and `SqlDriver` seam for SQL-family adapters. This
package is the foundation that the per-ORM packages
(`@vnatures/test-kit-pg-kysely`, `@vnatures/test-kit-pg-knex`,
`@vnatures/test-kit-pg-sequelize`) plug into.

You typically do **not** install this directly. Install the per-ORM
package matching your database boundary:

- [`@vnatures/test-kit-pg-kysely`](../pg-kysely/README.md)
- [`@vnatures/test-kit-pg-knex`](../pg-knex/README.md)
- [`@vnatures/test-kit-pg-sequelize`](../pg-sequelize/README.md)

## What lives here

- `QueryCall`, `QueryPendingCall`, `QueryProbe` — the call shape and
  probe API every SQL adapter exposes. `QueryCall` carries the parsed
  SQL fragment, parameters, and raw statement.
- `SqlDriver` — the seam each per-ORM package implements (one or two
  hooks: `executeForward(query)` and an optional `formatBoundParameters`).
- `createProbedSqlAdapter(driver, harness, options)` — the helper that
  constructs the probe, installs the default forward rule, and returns
  the probed pair.

The package has zero dependencies on PGlite or any specific ORM. It is
pure types and glue.

## Adding a new ORM

To add a new SQL ORM (e.g. Drizzle, TypeORM):

1. Implement a `SqlDriver` for it.
2. Construct your ORM's adapter atop
   [`@vnatures/test-kit-pglite-driver`](../pglite-driver/README.md) (or
   another Postgres-compatible store).
3. Wire them with `createProbedSqlAdapter`.

See [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/internal/tech-design.md`](../../docs/internal/tech-design.md) for
the full contributor walkthrough.
