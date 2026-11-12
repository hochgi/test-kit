import type { PGlite, QueryOptions, Results, Transaction } from '@electric-sql/pglite';
import type { ProbeRoot } from '@hochgi/test-kit';
import type { QueryCall, QueryPendingCall, SqlDriver } from '@hochgi/test-kit-sql';
import type { PgliteHandle } from '@hochgi/test-kit-pglite-driver';

type GetRoot = () => ProbeRoot<QueryCall, QueryPendingCall>;
type RunQuery = (sql: string, params: unknown[] | undefined, options: QueryOptions | undefined) => Promise<Results>;
type QueryFn = PGlite['query'];

export interface ProbedPgliteOptions {
    readonly pglite: PGlite;
    readonly getRoot: GetRoot;
    /** Run every application statement as this role (`SET LOCAL ROLE`, unprobed). */
    readonly role?: string;
}

/**
 * A pass-through Proxy over the PGlite instance. `query()` routes through the
 * probe; `transaction(cb)` runs the real transaction and hands `cb` a tx client
 * whose `query()` is probed the same way. BEGIN/COMMIT/ROLLBACK and the role
 * statement go straight to PGlite and are never calls.
 */
export function createProbedPglite(options: ProbedPgliteOptions): PGlite {
    const { pglite, getRoot } = options;
    const setRole = options.role === undefined ? undefined : `SET LOCAL ROLE ${quoteIdentifier(options.role)}`;
    const enter = async (tx: Transaction): Promise<void> => {
        if (setRole !== undefined) await tx.query(setRole);
    };

    const runTopLevel: RunQuery =
        setRole === undefined
            ? (sql, params, opts) => pglite.query(sql, params, opts)
            : (sql, params, opts) =>
                  pglite.transaction(async (tx) => {
                      await enter(tx);
                      return tx.query(sql, params, opts);
                  });

    const transaction: PGlite['transaction'] = (callback) =>
        pglite.transaction(async (tx) => {
            await enter(tx);
            return callback(
                passThrough(
                    tx,
                    probedQuery(getRoot, (sql, params, opts) => tx.query(sql, params, opts)),
                ),
            );
        });

    return passThrough(pglite, probedQuery(getRoot, runTopLevel), transaction);
}

/** SqlDriver over the probed client: application queries go through the probe; reset/close hit the handle. */
export function createDrizzleSqlDriver(handle: PgliteHandle, probed: PGlite): SqlDriver {
    return {
        // The application path records calls through the probed client's own
        // query()/transaction() directly; createProbedSqlAdapter never calls this
        // member. It exists to satisfy the SqlDriver contract.
        onApplicationQuery: (call) => probed.query(call.sql, [...call.parameters]),
        reset: () => handle.truncateAllUserTables(),
        close: () => handle.close(),
    };
}

function probedQuery(getRoot: GetRoot, run: RunQuery): QueryFn {
    const query = (sql: string, params?: unknown[], opts?: QueryOptions): Promise<unknown> =>
        getRoot().recordCall({ sql, parameters: [...(params ?? [])] }, () => run(sql, params, opts));
    // Forward resolves with PGlite's own Results; answer(value) is a documented
    // pass-through, so the caller's value stands in for Results unchanged.
    return query as QueryFn;
}

function passThrough<T extends PGlite | Transaction>(
    target: T,
    query: QueryFn,
    transaction?: PGlite['transaction'],
): T {
    return new Proxy(target, {
        get(real, prop) {
            if (prop === 'query') return query;
            if (prop === 'transaction' && transaction !== undefined) return transaction;
            const value: unknown = Reflect.get(real, prop, real);
            return typeof value === 'function' && prop !== 'constructor' ? value.bind(real) : value;
        },
    });
}

/** Quote as a Postgres identifier: wrap in double quotes, double any embedded `"`. */
function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}
