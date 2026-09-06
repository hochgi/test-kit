# APPENDIX — PGlite Adapter Landscape & Sequelize Evaluation

This document captures the research and evaluation performed before building `@vnatures/test-kit-pg-sequelize`. It is intended as a reference for future architectural decisions around ORM selection and test-kit support.

---

## 1. PGlite Adapter Landscape

[PGlite](https://github.com/electric-sql/pglite) runs real PostgreSQL (compiled to WebAssembly) entirely in-process — no Docker, no server, no infrastructure. Test-kit uses it as the backing store for `pg-*` packages because it offers **faithful SQL behavior** (JSONB, GIN, CTEs, window functions, etc.) without infrastructure overhead.

### ORMs / query builders with native or community PGlite support

| Library | PGlite adapter | Notes |
| :--- | :--- | :--- |
| **Kysely** | `kysely-pglite-dialect` (1st-party example) | Native dialect. Used by `test-kit-pg-kysely`. |
| **Knex** | `knex-pglite` (community) | Drop-in client. Used by `test-kit-pg-knex`. |
| **Drizzle** | `drizzle-orm/pglite` (1st-party) | Native driver included in Drizzle core. |
| **TypeORM** | `typeorm-pglite` (community) | Community adapter; wraps PGlite as a TypeORM driver. |
| **Prisma** | `@prisma/adapter-pg-worker` + PGlite | Prisma's driver adapter protocol; community examples exist. |
| **Orange ORM** | Built-in PGlite support | Niche ORM with native PGlite dialect. |

### ORMs / query builders **without** PGlite support

| Library | Status |
| :--- | :--- |
| **Sequelize** | No native adapter. No community adapter. `dialectModule` in v6 accepts a `pg`-compatible module, which we exploit via `pglite-pg-adapter`. **Sequelize v7 removes `dialectModule`**, closing this path. |
| **MikroORM** | No native PGlite adapter. Uses `knex` internally; theoretically possible via `knex-pglite`, but not validated. |

---

## 2. Approaches Evaluated for Sequelize

### 2a. `@middle-management/pglite-pg-adapter` via `dialectModule` ✅ (chosen)

- **What it does:** Wraps PGlite behind the standard `pg` module interface (`Client`, `Pool`). Injected into Sequelize v6 via `dialectModule`.
- **Pros:** Real PostgreSQL execution, aligns with test-kit's "no emulation" philosophy. Works with the existing Sequelize v6 codebase.
- **Cons:** The adapter is young (v0.0.4 as of March 2026). Requires workarounds for Sequelize internals: `lodash.cloneDeep` crash (solved via closure-based dialect module), callback-based `connect()`/`end()` bridging, and suppressing multi-statement `SET` queries that PGlite rejects.
- **Verdict:** Pragmatic and faithful. Recommended for the short/medium term.

### 2b. `pg-mem` via `dialectModule` ❌

- **What it does:** JavaScript-based in-memory PostgreSQL *emulator*. Intercepts SQL and executes it in a custom JS engine.
- **Pros:** Zero native dependencies, fast startup.
- **Cons:**
  - **Not real PostgreSQL.** SQL is parsed and executed by a JavaScript engine — subtle divergence on ENUM handling, introspection queries (`pg_type`, `pg_class`), and JSONB edge cases.
  - The `pg-mem` repository itself has an *empty* Sequelize compatibility test file (`adapters/adapters-tests/pg-mem-sequelize.spec.ts`), suggesting known compatibility gaps.
  - Contradicts test-kit's core philosophy: "run real Postgres via WASM, not a hand-rolled emulator."
- **Verdict:** Unsuitable. Tests would pass against an approximation, not the real engine.

### 2c. Testcontainers ❌

- **What it does:** Spins up a real PostgreSQL Docker container per test suite.
- **Pros:** Perfectly faithful — it *is* real Postgres.
- **Cons:** Requires Docker on the developer machine and in CI. Contradicts test-kit's "no infrastructure" principle. Slower cold start (~2-5s per container).
- **Verdict:** Valid for integration/E2E tests, but not for the lightweight component-test workflow test-kit targets.

### 2d. SQLite in-memory via `dialect: 'sqlite'` ❌

- **What it does:** Sequelize natively supports SQLite, which can run `:memory:` databases.
- **Pros:** Zero dependencies, instant startup.
- **Cons:** **Different SQL dialect.** PostgreSQL-specific syntax (JSONB operators, `::` casts, `ILIKE`, `ARRAY` types, `ON CONFLICT`, `RETURNING`) will fail or behave differently on SQLite. Tests become unreliable.
- **Verdict:** Unsuitable for testing PostgreSQL-targeted code.

---

## 3. ORM Migration Analysis

Given the absence of a native PGlite-Sequelize adapter, we evaluated whether migrating existing services from Sequelize v6 to an ORM with native PGlite support would be practical.

### Sequelize footprint in our codebase

- **10 repositories** use Sequelize v6 + `sequelize-typescript`: 8 services + 2 shared model libraries.
- Heavy reliance on Sequelize-specific features:
  - **Decorator-based models:** `@Table`, `@Column`, `@BelongsTo`, `@HasMany`, `@BelongsToMany`, `@Scopes`
  - **Lifecycle hooks:** `@BeforeSave`, `@AfterFind`, `@BeforeCreate`
  - **Query operators:** `Op.gt`, `Op.lt`, `Op.in`, `Op.like`, `Op.or`, `Op.and`
  - **Advanced features:** `DataType.VIRTUAL` (computed columns), polymorphic associations, `Sequelize.literal()` for raw SQL fragments, `$association.column$` nested `where` clauses, `findOrCreate`, `paranoid` (soft deletes)
- The heaviest service (`reports_service`) uses nearly every Sequelize feature; the lightest (`alerts-controller`) still uses `findOrCreate`, `Op` operators, and cross-table associations.

### Comparison with PGlite-native ORMs

| Feature | Sequelize v6 | TypeORM | Drizzle | Prisma | MikroORM |
| :--- | :--- | :--- | :--- | :--- | :--- |
| PGlite adapter | ❌ (via shim) | ✅ (`typeorm-pglite`) | ✅ (native) | ✅ (adapter protocol) | ❌ (knex internally) |
| Decorator models | ✅ | ✅ (similar) | ❌ (schema objects) | ❌ (schema file) | ✅ (similar) |
| Scopes | ✅ `@Scopes` | ❌ (manual) | ❌ | ❌ | ❌ |
| Lifecycle hooks | ✅ `@BeforeSave` etc. | ✅ `@BeforeInsert` etc. | ❌ | ❌ (middleware, different API) | ✅ |
| `Op` operators | ✅ | ❌ (query builder) | ❌ (SQL-like API) | ❌ (filter objects) | ❌ (query builder) |
| `findOrCreate` | ✅ | ❌ (manual upsert) | ❌ | ✅ `upsert` | ❌ |
| `DataType.VIRTUAL` | ✅ | ❌ | ❌ | ❌ | ✅ (virtual) |
| Paranoid soft deletes | ✅ built-in | ✅ `@DeleteDateColumn` | ❌ (manual) | ❌ (manual) | ✅ `@SoftDelete` |
| `$association.col$` WHERE | ✅ | ❌ | ❌ | ❌ | ❌ |

### Migration effort assessment

**TypeORM** is the closest match in terms of decorator style and feature set. However, migrating even a thin service like `alerts-controller` requires:

1. Rewriting all model definitions (different decorator API, no `@Scopes`)
2. Rewriting all query code (`findAll` → `find`, `Op.gt` → `MoreThan()`, etc.)
3. Replacing lifecycle hooks with TypeORM's subscriber/listener pattern
4. Replacing `findOrCreate` with manual `INSERT ... ON CONFLICT` or `upsert`
5. Replacing `Sequelize.literal()` with `QueryBuilder` raw expressions
6. Testing all edge cases around association loading, transaction handling, and raw queries

For heavier services (`reports_service`, `user-management-service`), the effort is a **major rewrite** — weeks of work per service plus extensive regression testing.

**Drizzle** and **Prisma** are even further from Sequelize's API (no decorators, no hooks, different query patterns), making migration substantially harder.

**Verdict:** Migrating away from Sequelize solely for PGlite test compatibility is not practical given the current codebase size and coupling. The `pglite-pg-adapter` shim is the right trade-off.

---

## 4. Recommendations for the Future

### Short-term (now)

Use `@vnatures/test-kit-pg-sequelize` with `pglite-pg-adapter` for component testing existing Sequelize v6 services. This preserves the codebase investment while enabling PGlite-backed tests with the same `DbProbe` workflow as Kysely and Knex.

### Medium-term (new services)

For **new services**, prefer an ORM/query builder with native PGlite support:

- **Knex** → `@vnatures/test-kit-pg-knex` (already available, well-tested)
- **Kysely** → `@vnatures/test-kit-pg-kysely` (already available, well-tested)
- **TypeORM** → Closest to Sequelize's decorator style. A `test-kit-pg-typeorm` package could be added using the community `typeorm-pglite` adapter.
- **Drizzle** → Modern, type-safe. A `test-kit-pg-drizzle` package could be added using its native PGlite driver.

This avoids the adapter shim for new code while allowing existing services to remain on Sequelize.

### Long-term (migration, if warranted)

If the organization decides to standardize on a single ORM:

1. **Start with thin services** (`alerts-controller`, `construction_rules_service`) as migration pilots.
2. **Prefer TypeORM** for the migration target — it has the most similar decorator-based model definition and is the easiest migration path from `sequelize-typescript`.
3. Add a `@vnatures/test-kit-pg-typeorm` package to support migrated services.
4. Migrate heavier services (`reports_service`, `user-management-service`) only after validating the pattern on simpler ones.

### Monitor

- **`@middle-management/pglite-pg-adapter`** maturity — track version updates and known issues.
- **Sequelize v7** — if v7 introduces a new pluggable dialect/driver system (replacing `dialectModule`), revisit the adapter approach.
- **PGlite ecosystem** — new Sequelize adapters may appear as PGlite adoption grows.
