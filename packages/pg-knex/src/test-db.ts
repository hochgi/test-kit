import { PGlite } from '@electric-sql/pglite';
import knex, { type Knex } from 'knex';
// knex-pglite ships a CJS module with `export = ClientPGLite`.
// With esModuleInterop:true the TypeScript compiler handles the interop and
// emits require() in the CJS output -- we can write clean import syntax here.
import KnexPGLiteClientImport from 'knex-pglite';

// knex-pglite declares `export = ClientPGLite` so the default import IS the class.
export const KnexPGLiteClient = KnexPGLiteClientImport;

export type BootstrapFn = (db: Knex) => Promise<void>;

export interface TestDbOptions {
    /**
     * DDL bootstrap: create tables, indexes, etc.
     * Called once at creation and again after each reset.
     * Should be idempotent (use IF NOT EXISTS).
     */
    bootstrap: BootstrapFn;
    /**
     * Extra Knex options merged into the PGlite client config (e.g. knex-stringcase,
     * migrations directory). `client`, `connection`, and `pool` are ignored.
     */
    knexConfig?: Partial<Knex.Config>;
}

/** @internal Strip options that must be owned by test-kit. */
export function stripConflictingKnexOptions(cfg: Partial<Knex.Config> | undefined): Partial<Knex.Config> {
    if (!cfg) return {};
    const { client: _c, connection: _conn, pool: _p, ...rest } = cfg;
    return rest;
}

/**
 * knex-pglite reads `connection().pglite` when connection is a function.
 * A plain `{ pglite }` object is deep-cloned by Knex and breaks on PGlite internals.
 *
 * @internal
 */
export function createPgliteKnex(pglite: PGlite, extraConfig?: Partial<Knex.Config>): Knex {
    const config = {
        ...stripConflictingKnexOptions(extraConfig),
        client: KnexPGLiteClient,
        connection: () => ({ pglite }),
    } as Knex.Config;
    return knex(config);
}

/**
 * Drop all user-created tables in the public schema.
 *
 * Uses `tablename` from `pg_tables` (a single lowercase word) which is
 * unaffected by knex-stringcase's camelCase transforms. Do NOT switch to
 * `information_schema.tables` (column `table_name`) without accounting for
 * the rename knex-stringcase would apply.
 *
 * @internal
 */
export async function dropAllUserTables(db: Knex): Promise<void> {
    const result = await db.raw<{ rows: Array<{ tablename: string }> }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = result.rows.map((r) => r.tablename);
    if (names.length === 0) return;

    const tableList = names.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
    await db.raw(`DROP TABLE IF EXISTS ${tableList} CASCADE`);
}

export interface TestDb {
    /** Knex instance wired to the in-memory PGlite database. */
    readonly db: Knex;

    /**
     * Drop all user tables and re-run the bootstrap.
     * Gives each test (or describe block) a clean slate.
     */
    reset(): Promise<void>;

    /**
     * Insert seed rows into a table.
     * Convenience wrapper around Knex insert; serializes
     * objects/arrays to JSON for JSONB columns automatically.
     */
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;

    /** Destroy the Knex instance and close the PGlite database. */
    close(): Promise<void>;
}

export async function createTestDb(options: TestDbOptions): Promise<TestDb> {
    const pglite = new PGlite();
    await pglite.waitReady;
    const db = createPgliteKnex(pglite, options.knexConfig);

    try {
        await options.bootstrap(db);
    } catch (err) {
        try {
            await db.destroy();
        } catch {
            /* ignore */
        }
        try {
            await pglite.close();
        } catch {
            /* ignore */
        }
        throw err;
    }

    return {
        db,

        async reset() {
            await dropAllUserTables(db);
            await options.bootstrap(db);
        },

        async seed(table, rows) {
            if (rows.length === 0) return;

            const prepared = rows.map((row) => {
                const out: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(row)) {
                    out[key] =
                        value !== null &&
                        typeof value === 'object' &&
                        !Buffer.isBuffer(value) &&
                        !(value instanceof Date)
                            ? JSON.stringify(value)
                            : value;
                }
                return out;
            });

            await db(table).insert(prepared);
        },

        async close() {
            try {
                await db.destroy();
            } catch {
                /* knex-pglite may have already closed PGlite */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed by destroy above */
            }
        },
    };
}
