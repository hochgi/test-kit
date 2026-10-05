import type { ForwardablePendingCall, ForwardableProbe, ForwardableSelection } from '@hochgi/test-kit';

export interface QueryCall {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}

export interface QueryPendingCall<TResult = unknown> extends ForwardablePendingCall<QueryCall, TResult> {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}

export interface QueryProbe extends ForwardableProbe<QueryCall, QueryPendingCall> {
    /**
     * Typed sugar over filter for SQL matching. Strings match by exact
     * equality; RegExps via .test(); functions via predicate.
     */
    sql(match: string | RegExp | ((sql: string) => boolean)): ForwardableSelection<QueryCall, QueryPendingCall>;
}

/**
 * Seam between the shared SQL probe surface and per-ORM packages. Each
 * ORM (Kysely, Knex, Sequelize, ...) implements this against its own
 * dialect/adapter to translate the ORM's query event into a normalized
 * QueryCall + route it through the probe.
 */
export interface SqlDriver {
    /**
     * Translate the ORM's query into a QueryCall and route it through the
     * probe. The returned Promise is what the ORM hands back to the SUT.
     *
     * Implementations typically look like:
     *   onApplicationQuery(call) {
     *     return probeRoot.recordCall(call, () => realExecute(call));
     *   }
     */
    onApplicationQuery(call: QueryCall): Promise<unknown>;

    /**
     * Drop / truncate user tables on the maintenance connection (bypassing
     * the probe). Called by the harness on reset().
     */
    reset(): Promise<void>;

    /**
     * Dispose the ORM connection pool and the underlying PGlite handle.
     */
    close(): Promise<void>;
}
