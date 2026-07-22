/**
 * Internal PGlite lifecycle helper shared across pg-* packages.
 *
 * Per docs/v2-architecture.md §"@test-kit/pglite-driver — shared PGlite
 * lifecycle helper". This package is `private: true` (workspace-internal);
 * pg-* packages depend on it directly.
 */
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';

/**
 * Narrow façade over PGlite's LISTEN/NOTIFY surface. Exposed so consumers
 * (and the pg-* probed adapters) can subscribe to a channel on the SAME
 * PGlite instance the probed ORM writes through — a separately created
 * listener would be a different database and never see the notification.
 *
 * PGlite delivers notifications asynchronously after the notifying
 * statement (and its transaction) commits.
 */
export interface PgliteNotifications {
    /**
     * Subscribe to a PostgreSQL NOTIFY `channel`. Returns an unsubscribe
     * function. `pg_notify(channel, payload)` (or `NOTIFY`) issued on the
     * same PGlite instance delivers `handler` with the payload string.
     */
    listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
    /** Stop listening to `channel` (optionally only the given handler). */
    unlisten(channel: string, handler?: (payload: string) => void): Promise<void>;
}

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
     * LISTEN/NOTIFY façade over the same PGlite instance. Subscribe to
     * channels and observe notifications issued through the probed ORM.
     */
    readonly notifications: PgliteNotifications;

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

    const notifications: PgliteNotifications = {
        async listen(channel, handler) {
            const unsub = await pglite.listen(channel, handler);
            return async () => {
                await unsub();
            };
        },
        async unlisten(channel, handler) {
            await pglite.unlisten(channel, handler);
        },
    };

    return {
        pglite,
        maintenance,
        notifications,
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
