import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';

export interface BootstrapFn<DB> {
    (db: Kysely<DB>): Promise<void>;
}

export interface TestDbOptions<DB> {
    /**
     * DDL bootstrap: create tables, indexes, etc.
     * Called once at creation and again after each reset.
     * Should be idempotent (use IF NOT EXISTS).
     */
    bootstrap: BootstrapFn<DB>;
}

/** @internal Drop all user-created tables in the public schema. */
export async function dropAllUserTables<DB>(db: Kysely<DB>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const result = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `.execute(db);

    const names = result.rows.map((r) => r.tablename);
    if (names.length === 0) return;

    const tableList = names.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
    await sql.raw(`DROP TABLE IF EXISTS ${tableList} CASCADE`).execute(db);
}

export interface TestDb<DB> {
    /** Kysely instance wired to the in-memory PGlite database. */
    readonly db: Kysely<DB>;

    /**
     * Drop all user tables and re-run the bootstrap.
     * Gives each test (or describe block) a clean slate.
     */
    reset(): Promise<void>;

    /**
     * Insert seed rows into a table.
     * Convenience wrapper around Kysely insertInto; serializes
     * objects/arrays to JSON for JSONB columns automatically.
     */
    seed<T extends keyof DB & string>(table: T, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;

    /** Destroy the Kysely instance and close the PGlite database. */
    close(): Promise<void>;
}

export async function createTestDb<DB>(options: TestDbOptions<DB>): Promise<TestDb<DB>> {
    const pglite = new PGlite();
    await pglite.waitReady;
    const db = new Kysely<DB>({ dialect: new PGliteDialect(pglite) });

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

            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            await (db.insertInto(table as any).values(prepared as any) as any).execute();
        },

        async close() {
            try {
                await db.destroy();
            } catch {
                /* PGlite may already be closed */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed by destroy above */
            }
        },
    };
}
