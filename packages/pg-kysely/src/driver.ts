/* eslint-disable max-classes-per-file */
import type { PGlite } from '@electric-sql/pglite';
import {
    type CompiledQuery,
    type DatabaseConnection,
    type Dialect,
    type Driver,
    type Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type QueryResult,
    type TransactionSettings,
} from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import type { ProbeRoot } from '@vnatures/test-kit';
import type { QueryCall, QueryPendingCall, SqlDriver } from '@vnatures/test-kit-sql';
import type { PgliteHandle } from '@vnatures/test-kit-pglite-driver';

class ProbedConnection implements DatabaseConnection {
    readonly realConnection: DatabaseConnection;
    private readonly getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>;

    constructor(real: DatabaseConnection, getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>) {
        this.realConnection = real;
        this.getRoot = getRoot;
    }

    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        const call: QueryCall = {
            sql: compiledQuery.sql,
            parameters: [...compiledQuery.parameters],
        };
        const result = await this.getRoot().recordCall(call, () => this.realConnection.executeQuery(compiledQuery));
        return result as QueryResult<R>;
    }

    async *streamQuery<R>(compiledQuery: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
        yield* this.realConnection.streamQuery<R>(compiledQuery, chunkSize);
    }
}

class ProbedDriver implements Driver {
    private readonly realDriver: Driver;
    private readonly getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>;

    constructor(realDialect: Dialect, getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>) {
        this.realDriver = realDialect.createDriver();
        this.getRoot = getRoot;
    }

    async init(): Promise<void> {
        await this.realDriver.init();
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        const real = await this.realDriver.acquireConnection();
        return new ProbedConnection(real, this.getRoot);
    }

    async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
        await this.realDriver.beginTransaction((connection as ProbedConnection).realConnection, settings);
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        await this.realDriver.commitTransaction((connection as ProbedConnection).realConnection);
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        await this.realDriver.rollbackTransaction((connection as ProbedConnection).realConnection);
    }

    async releaseConnection(connection: DatabaseConnection): Promise<void> {
        await this.realDriver.releaseConnection((connection as ProbedConnection).realConnection);
    }

    async destroy(): Promise<void> {
        await this.realDriver.destroy();
    }
}

export class ProbedKyselyDialect implements Dialect {
    private readonly realDialect: PGliteDialect;
    private readonly driver: ProbedDriver;

    constructor(pglite: PGlite, getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>) {
        this.realDialect = new PGliteDialect(pglite);
        this.driver = new ProbedDriver(this.realDialect, getRoot);
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

    createIntrospector(db: Kysely<unknown>) {
        return new PostgresIntrospector(db);
    }
}

/**
 * Build a Kysely SqlDriver implementation atop a PGlite handle.
 * Maintenance connection bypasses the probe.
 */
export function createKyselySqlDriver(
    handle: PgliteHandle,
    getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>,
): SqlDriver {
    return {
        onApplicationQuery(call: QueryCall) {
            // ORM dialect calls recordCall on every executeQuery via ProbedConnection.
            // This onApplicationQuery is unused in the kysely impl path because the
            // dialect intercepts directly. The SqlDriver still implements it for the
            // generic-SQL test fixture compatibility.
            return getRoot().recordCall(call, () => handle.maintenance.execute(call.sql, [...call.parameters]));
        },
        async reset() {
            await handle.truncateAllUserTables();
        },
        async close() {
            await handle.close();
        },
    };
}
