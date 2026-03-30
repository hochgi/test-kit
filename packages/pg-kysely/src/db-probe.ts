/* eslint-disable max-classes-per-file */
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresAdapter, PostgresQueryCompiler, PostgresIntrospector } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { DbProbe } from '@vnatures/test-kit';

import type { DatabaseConnection, Driver, Dialect, QueryResult, CompiledQuery } from 'kysely';

import type { BootstrapFn, TestDb } from './test-db';
import { dropAllUserTables } from './test-db';

// Re-export so consumers can import everything from this package without
// needing to add @vnatures/test-kit as a direct dependency.
export { DbProbe } from '@vnatures/test-kit';
export type { QueryCall, PendingQuery } from '@vnatures/test-kit';

// ── Intercepting connection & driver ─────────────────────────────────────────

class ProbedConnection implements DatabaseConnection {
    /** @internal exposed for ProbedDriver to unwrap */
    readonly realConnection: DatabaseConnection;

    private readonly probe: DbProbe;

    constructor(real: DatabaseConnection, probe: DbProbe) {
        this.realConnection = real;
        this.probe = probe;
    }

    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        const forwardFn = () => this.realConnection.executeQuery(compiledQuery);
        return this.probe.recordQuery(
            { sql: compiledQuery.sql, parameters: [...compiledQuery.parameters] },
            forwardFn,
        ) as Promise<QueryResult<R>>;
    }

    async *streamQuery<R>(compiledQuery: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
        // Stream queries bypass the probe and go directly to PGlite.
        // Intercepting async iterators adds significant complexity with
        // marginal value — the probe covers executeQuery which handles
        // the vast majority of real-world queries.
        yield* this.realConnection.streamQuery<R>(compiledQuery, chunkSize);
    }
}

class ProbedDriver implements Driver {
    private readonly realDriver: Driver;

    private readonly probe: DbProbe;

    constructor(realDialect: Dialect, probe: DbProbe) {
        this.realDriver = realDialect.createDriver();
        this.probe = probe;
    }

    async init(): Promise<void> {
        await this.realDriver.init();
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        const realConn = await this.realDriver.acquireConnection();
        return new ProbedConnection(realConn, this.probe);
    }

    async beginTransaction(connection: DatabaseConnection, settings: any): Promise<void> {
        const unwrapped = (connection as ProbedConnection).realConnection;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await this.realDriver.beginTransaction(unwrapped, settings);
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        const unwrapped = (connection as ProbedConnection).realConnection;
        await this.realDriver.commitTransaction(unwrapped);
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        const unwrapped = (connection as ProbedConnection).realConnection;
        await this.realDriver.rollbackTransaction(unwrapped);
    }

    async releaseConnection(connection: DatabaseConnection): Promise<void> {
        const unwrapped = (connection as ProbedConnection).realConnection;
        await this.realDriver.releaseConnection(unwrapped);
    }

    async destroy(): Promise<void> {
        await this.realDriver.destroy();
    }
}

class ProbedDialect implements Dialect {
    private readonly realDialect: PGliteDialect;

    private readonly driver: ProbedDriver;

    constructor(pglite: PGlite, probe: DbProbe) {
        this.realDialect = new PGliteDialect(pglite);
        this.driver = new ProbedDriver(this.realDialect, probe);
    }

    createAdapter() {
        return new PostgresAdapter();
    }

    createDriver(): Driver {
        return this.driver;
    }

    createQueryCompiler() {
        return new PostgresQueryCompiler();
    }

    createIntrospector(db: Kysely<any>) {
        return new PostgresIntrospector(db);
    }
}

// ── Public factory ────────────────────────────────────────────────────────────

export interface ProbedTestDbOptions<DB> {
    /** PGlite extensions to load. See `TestDbOptions.extensions`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensions?: Record<string, any>;
    bootstrap: BootstrapFn<DB>;
}

export interface ProbedTestDb<DB> extends TestDb<DB> {
    readonly probe: DbProbe;
}

export async function createProbedTestDb<DB>(options: ProbedTestDbOptions<DB>): Promise<ProbedTestDb<DB>> {
    const pglite = new PGlite(options.extensions ? { extensions: options.extensions } : undefined);
    await pglite.waitReady;
    const probe = new DbProbe();
    const dialect = new ProbedDialect(pglite, probe);
    const db = new Kysely<DB>({ dialect });

    // Unprobed Kysely instance for maintenance (reset/seed/bootstrap).
    // Shares the same PGlite so data is visible to both, but bypasses
    // the probe so alwaysReject/clearBehavior can't block cleanup.
    const maintenanceDb = new Kysely<DB>({ dialect: new PGliteDialect(pglite) });

    probe.alwaysForward();

    try {
        await options.bootstrap(maintenanceDb);
    } catch (err) {
        try {
            await db.destroy();
        } catch {
            /* ignore */
        }
        try {
            await maintenanceDb.destroy();
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
        probe,

        async reset() {
            await dropAllUserTables(maintenanceDb);
            await options.bootstrap(maintenanceDb);
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
            await (maintenanceDb.insertInto(table as any).values(prepared as any) as any).execute();
        },

        async close() {
            try {
                await db.destroy();
            } catch {
                /* PGlite may already be closed */
            }
            try {
                await maintenanceDb.destroy();
            } catch {
                /* PGlite may already be closed */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed by a destroy above */
            }
        },
    };
}
