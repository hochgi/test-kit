/**
 * Internal PGlite lifecycle helper shared across pg-* packages.
 *
 * Per docs/v2-architecture.md §"@test-kit/pglite-driver — shared PGlite
 * lifecycle helper". This package is `private: true` (workspace-internal);
 * pg-* packages depend on it directly.
 */
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';

export interface PgliteHandle {
    /** The PGlite instance. ORM packages connect through this. */
    readonly pglite: PGlite;

    /**
     * Maintenance query executor — direct PGlite, bypasses any ORM and any
     * probe wrapper. Used by pg-* `seed` and `reset` helpers so those don't
     * appear in probe.calls.
     */
    readonly maintenance: {
        execute(
            sql: string,
            parameters?: ReadonlyArray<unknown>,
        ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>;
    };

    /**
     * Drop every user-created table in the public schema. Called by
     * SqlDriver.reset() implementations.
     */
    truncateAllUserTables(): Promise<void>;

    /** Dispose the PGlite instance. */
    close(): Promise<void>;
}

export interface CreatePgliteHandleOptions {
    /**
     * PGlite extensions to load at construction. Pass extension objects from
     * `@electric-sql/pglite/contrib/*`. Activate them inside your bootstrap
     * via `CREATE EXTENSION IF NOT EXISTS "..."`.
     */
    readonly extensions?: Record<string, unknown>;
}

export async function createPgliteHandle(options?: CreatePgliteHandleOptions): Promise<PgliteHandle> {
    const pgliteOptions: PGliteOptions | undefined = options?.extensions
        ? ({ extensions: options.extensions } as PGliteOptions)
        : undefined;
    const pglite = new PGlite(pgliteOptions);
    await pglite.waitReady;

    const maintenance: PgliteHandle['maintenance'] = {
        async execute(sql, parameters) {
            const result = (await pglite.query(sql, parameters as unknown[] | undefined)) as { rows?: unknown[] };
            return {
                rows: (result.rows ?? []) as ReadonlyArray<Record<string, unknown>>,
            };
        },
    };

    return {
        pglite,
        maintenance,
        async truncateAllUserTables() {
            const result = await pglite.query<{ tablename: string }>(
                `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
            );
            const names = result.rows.map((r) => r.tablename);
            if (names.length === 0) return;
            const list = names.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
            await pglite.query(`DROP TABLE IF EXISTS ${list} CASCADE`);
        },
        async close() {
            try {
                await pglite.close();
            } catch {
                // PGlite may already be closed by an ORM destroy(). Ignore.
            }
        },
    };
}
