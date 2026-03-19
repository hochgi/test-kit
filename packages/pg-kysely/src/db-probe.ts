/* eslint-disable max-classes-per-file */
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresAdapter, PostgresQueryCompiler, PostgresIntrospector, CompiledQuery, sql } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';

import type { DatabaseConnection, Driver, Dialect, QueryResult } from 'kysely';

import type { BootstrapFn, TestDb } from './test-db';
import { dropAllUserTables } from './test-db';

// ── Timing helpers ──────────────────────────────────────────────────────────

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

// ── Public types ────────────────────────────────────────────────────────────

export interface QueryCall {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}

export interface PendingQuery {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
    readonly settled: boolean;
    forward(): void;
    reject(error: unknown): void;
}

// ── Internal state ──────────────────────────────────────────────────────────

type QueryInternal = {
    index: number;
    sql: string;
    parameters: ReadonlyArray<unknown>;
    deferred: Deferred<QueryResult<unknown>>;
    realConnection: DatabaseConnection;
    compiledQuery: CompiledQuery;
    settled: boolean;
};

type PlannedBehavior = { type: 'forward' } | { type: 'reject'; error: unknown };

type Waiter = {
    predicate: (call: QueryCall) => boolean;
    resolve: (pending: PendingQuery) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof realSetTimeout>;
};

// ── PendingQuery factory ────────────────────────────────────────────────────

function makePendingQuery(internal: QueryInternal): PendingQuery {
    return {
        get sql() {
            return internal.sql;
        },
        get parameters() {
            return internal.parameters;
        },
        get settled() {
            return internal.settled;
        },
        forward() {
            if (internal.settled) {
                throw new Error('Query is already settled.');
            }
            internal.settled = true;
            internal.realConnection.executeQuery(internal.compiledQuery).then(
                (result) => internal.deferred.resolve(result),
                (err) => internal.deferred.reject(toError(err)),
            );
        },
        reject(error: unknown) {
            if (internal.settled) {
                throw new Error('Query is already settled.');
            }
            internal.settled = true;
            internal.deferred.reject(toError(error));
        },
    };
}

// ── DbProbe ─────────────────────────────────────────────────────────────────

export class DbProbe {
    private readonly queue: QueryInternal[] = [];

    private readonly consumed = new Set<number>();

    private readonly waiters: Waiter[] = [];

    private readonly planned: PlannedBehavior[] = [];

    private permanent: PlannedBehavior | undefined;

    private nextIndex = 0;

    /** @internal — called by the intercepting connection */
    recordQuery(compiledQuery: CompiledQuery, realConnection: DatabaseConnection): Promise<QueryResult<unknown>> {
        const deferred = createDeferred<QueryResult<unknown>>();
        const index = this.nextIndex;
        this.nextIndex += 1;

        const internal: QueryInternal = {
            index,
            sql: compiledQuery.sql,
            parameters: compiledQuery.parameters,
            deferred,
            realConnection,
            compiledQuery,
            settled: false,
        };

        this.queue.push(internal);

        for (let i = 0; i < this.waiters.length; i += 1) {
            const waiter = this.waiters[i];
            if (waiter.predicate({ sql: internal.sql, parameters: internal.parameters })) {
                this.waiters.splice(i, 1);
                if (waiter.timer) realClearTimeout(waiter.timer);
                this.consumed.add(index);
                waiter.resolve(makePendingQuery(internal));
                return deferred.promise;
            }
        }

        const behavior = this.resolveBehavior();
        if (behavior) {
            this.applyBehavior(internal, behavior);
        }

        return deferred.promise;
    }

    // ── Plumbing: wait for queries ──────────────────────────────────────────

    async expectNext(timeoutMs = 5000): Promise<PendingQuery> {
        return this.expectMatching(() => true, timeoutMs);
    }

    async expectMatching(predicate: (call: QueryCall) => boolean, timeoutMs = 5000): Promise<PendingQuery> {
        for (const internal of this.queue) {
            if (
                !this.consumed.has(internal.index) &&
                !internal.settled &&
                predicate({ sql: internal.sql, parameters: internal.parameters })
            ) {
                this.consumed.add(internal.index);
                return makePendingQuery(internal);
            }
        }

        return new Promise<PendingQuery>((resolve, reject) => {
            const waiter: Waiter = { predicate, resolve, reject };
            waiter.timer = realSetTimeout(() => {
                this.removeWaiter(waiter);
                reject(new Error(`Timed out waiting for matching query after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    // ── Observation ─────────────────────────────────────────────────────────

    get queries(): ReadonlyArray<QueryCall> {
        return this.queue.map((q) => ({ sql: q.sql, parameters: q.parameters }));
    }

    pendingCount(): number {
        let count = 0;
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) count += 1;
        }
        return count;
    }

    // ── Porcelain: pre-program behavior ─────────────────────────────────────

    whenQueried(): { thenForward(): void; thenReject(error: unknown): void } {
        return {
            thenForward: () => {
                this.planned.push({ type: 'forward' });
            },
            thenReject: (error: unknown) => {
                this.planned.push({ type: 'reject', error });
            },
        };
    }

    alwaysForward(): void {
        this.permanent = { type: 'forward' };
    }

    alwaysReject(error: unknown): void {
        this.permanent = { type: 'reject', error };
    }

    /**
     * Clear any permanent behavior and planned queue.
     * After this call, queries that are not matched by a waiter will hang
     * until explicitly settled — same as a core TestProbe with no pre-programmed answers.
     */
    clearBehavior(): void {
        this.permanent = undefined;
        this.planned.length = 0;
    }

    // ── Drain helpers ───────────────────────────────────────────────────────

    drainWith(handler: (pending: PendingQuery) => void): void {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) {
                this.consumed.add(internal.index);
                handler(makePendingQuery(internal));
            }
        }
    }

    drain(): void {
        this.drainWith(() => {});
    }

    drainAndForwardAll(): void {
        this.drainWith((q) => {
            if (!q.settled) q.forward();
        });
    }

    drainAndRejectAll(error?: Error): void {
        this.drainWith((q) => {
            if (!q.settled) q.reject(error ?? new Error('drained'));
        });
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private resolveBehavior(): PlannedBehavior | undefined {
        if (this.planned.length > 0) {
            return this.planned.shift();
        }
        return this.permanent;
    }

    private applyBehavior(internal: QueryInternal, behavior: PlannedBehavior): void {
        if (internal.settled) return;
        internal.settled = true;
        if (behavior.type === 'forward') {
            internal.realConnection.executeQuery(internal.compiledQuery).then(
                (result) => internal.deferred.resolve(result),
                (err) => internal.deferred.reject(toError(err)),
            );
        } else {
            internal.deferred.reject(toError(behavior.error));
        }
    }

    private removeWaiter(waiter: Waiter): void {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
    }
}

// ── Intercepting connection & driver ────────────────────────────────────────

class ProbedConnection implements DatabaseConnection {
    /** @internal exposed for ProbedDriver to unwrap */
    readonly realConnection: DatabaseConnection;

    private readonly probe: DbProbe;

    constructor(real: DatabaseConnection, probe: DbProbe) {
        this.realConnection = real;
        this.probe = probe;
    }

    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        return this.probe.recordQuery(compiledQuery, this.realConnection) as Promise<QueryResult<R>>;
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

// ── Public factory ──────────────────────────────────────────────────────────

export interface ProbedTestDbOptions<DB> {
    bootstrap: BootstrapFn<DB>;
}

export interface ProbedTestDb<DB> extends TestDb<DB> {
    readonly probe: DbProbe;
}

export async function createProbedTestDb<DB>(options: ProbedTestDbOptions<DB>): Promise<ProbedTestDb<DB>> {
    const pglite = new PGlite();
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
            await maintenanceDb.destroy();
        } finally {
            await pglite.close();
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
                await maintenanceDb.destroy();
            } finally {
                await pglite.close();
            }
        },
    };
}
