# @hochgi/test-kit-pglite-driver

Shared PGlite lifecycle helper used by the `pg-*` packages. It constructs a
PGlite instance, exposes a maintenance query path that bypasses the probe, and
disposes the instance on close.

This package **is published**. You typically consume it through
[`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md),
[`@hochgi/test-kit-pg-knex`](../pg-knex/README.md), or
[`@hochgi/test-kit-pg-sequelize`](../pg-sequelize/README.md) rather than
installing it directly.

## `createPgliteHandle`

```typescript
import { createPgliteHandle } from "@hochgi/test-kit-pglite-driver";

const handle = await createPgliteHandle({ extensions });
```

See [`docs/architecture.md`](../../docs/architecture.md) for how the pg-*
packages wire this into `SqlDriver`.
