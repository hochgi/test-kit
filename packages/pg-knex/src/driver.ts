/* eslint-disable max-classes-per-file */
import type { PGlite } from '@electric-sql/pglite';
import knex, { type Knex } from 'knex';
// knex-pglite ships a CJS module with `export = ClientPGLite`. With
// esModuleInterop:true, the default import IS the class.
import KnexPGLiteClientImport from 'knex-pglite';
import type { ProbeRoot } from '@hochgi/test-kit';
import type { QueryCall, QueryPendingCall } from '@hochgi/test-kit-sql';

export const KnexPGLiteClient = KnexPGLiteClientImport;

/**
 * Strip options that must be owned by test-kit (the user can't override
 * the client/connection/pool — those are how PGlite gets wired in).
 */
export function stripConflictingKnexOptions(cfg: Partial<Knex.Config> | undefined): Partial<Knex.Config> {
    if (!cfg) return {};
    const { client: _c, connection: _conn, pool: _p, ...rest } = cfg;
    return rest;
}

/**
 * Plain (un-probed) Knex over PGlite — used as the maintenance connection.
 * knex-pglite reads `connection().pglite` when connection is a function;
 * a plain `{ pglite }` object would be deep-cloned by Knex and break on
 * PGlite internals.
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
 * Probed Knex over PGlite — overrides the internal `_query` hook to route
 * every executed query through the probe. The KnexPGLiteClient subclass
 * captures the probeRoot getter (which we can't supply at class-construction
 * time because probeRoot is built later in the canonical wire-up).
 */
export function createProbedPgliteKnex(
    pglite: PGlite,
    getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>,
    extraConfig?: Partial<Knex.Config>,
): Knex {
    class ProbedPGLiteClient extends KnexPGLiteClient {
        // Knex Client typings omit `_query`; knex-pglite implements it. We
        // can't `super._query()` because TS doesn't know about it; look up
        // the parent prototype directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-underscore-dangle -- Knex Client typings omit `_query`; parent lookup is untyped
        async _query(connection: PGlite, obj: any): Promise<any> {
            type QueryHook = (c: PGlite, o: unknown) => Promise<unknown>;
            // eslint-disable-next-line @typescript-eslint/dot-notation
            const parentQuery = (KnexPGLiteClient.prototype as unknown as Record<string, QueryHook>)['_query'];
            const run = (): Promise<unknown> => parentQuery.call(this, connection, obj);
            const call: QueryCall = {
                sql: obj.sql as string,
                parameters: (obj.bindings ?? []) as ReadonlyArray<unknown>,
            };
            return getRoot().recordCall(call, run);
        }
    }

    const config = {
        ...stripConflictingKnexOptions(extraConfig),
        client: ProbedPGLiteClient,
        connection: () => ({ pglite }),
    } as Knex.Config;
    return knex(config);
}
