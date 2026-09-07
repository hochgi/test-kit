import type { Duration, Rig, ProbedAdapterWithLifecycle } from '@vnatures/test-kit';
import type { QueryProbe } from '@vnatures/test-kit-sql';

/**
 * The application-facing MySQL boundary — a subset of mysql2's promise
 * `Pool` shape (`execute` / `query`). Every call is routed through the
 * probe as a {@link QueryCall} so tests can intercept, answer, reject, or
 * assert on individual statements.
 *
 * Inject this into production wiring wherever a `mysql2/promise` Pool
 * would go.
 */
export interface MysqlAdapter {
    /**
     * Execute a prepared statement via mysql2's binary/prepared protocol
     * (`pool.execute`). Routes through the probe.
     */
    execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;

    /**
     * Execute a text query via mysql2's text protocol (`pool.query`).
     * Supports statements that can't be prepared (e.g. `SHOW TABLES`).
     * Routes through the probe.
     */
    query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
}

/**
 * Metadata about the running MySQL Testcontainer, exposed for diagnostics
 * or for consumers that need to construct their own connection outside the
 * probed pool.
 */
export interface MysqlContainerInfo {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly connectionUri: string;
}

export interface CreateProbedMysqlAdapterOptions {
    readonly harness: Rig;
    /**
     * Called once on the maintenance pool (bypassing the probe) after the
     * container starts. Typically creates schemas / tables and seeds
     * reference data. Re-run on `reset()`.
     */
    readonly bootstrap: (maintenance: MaintenancePool) => Promise<void>;
    /** MySQL docker image (default `mysql:8.0`). */
    readonly image?: string;
    /** Database name (default `testdb`). */
    readonly database?: string;
    /** Username (default `testuser`). */
    readonly username?: string;
    /** Password (default `testpass`). */
    readonly password?: string;
    readonly defaultTimeout?: Duration;
}

/**
 * The maintenance pool bypasses the probe — used for bootstrap, seed, and
 * reset. Exposes the same `execute` / `query` surface as
 * {@link MysqlAdapter} but without probe interception.
 */
export interface MaintenancePool {
    execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
    query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
}

export type ProbedMysqlAdapter = ProbedAdapterWithLifecycle<MysqlAdapter, QueryProbe> & {
    /**
     * Seed rows into a table via the maintenance pool (bypasses the probe).
     * Uses a batched INSERT.
     */
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;

    /** Running container metadata. */
    readonly container: MysqlContainerInfo;
};
