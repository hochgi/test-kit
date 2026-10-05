import {
    createProbeRoot,
    emptyFilterChain,
    makeForwardablePending,
    type CallRecord,
    type Duration,
    type ForwardablePendingCall,
    type ForwardableSelection,
    type Rig,
    type ProbeRoot,
} from '@hochgi/test-kit';
import type { QueryCall, QueryPendingCall, QueryProbe, SqlDriver } from './types.js';

export interface CreateProbedSqlAdapterOptions {
    readonly harness: Rig;
    readonly defaultTimeout?: Duration;
    readonly driver: SqlDriver;
}

export interface ProbedSqlAdapter {
    readonly probe: QueryProbe;
    readonly probeRoot: ProbeRoot<QueryCall, QueryPendingCall>;
}

/**
 * Construct the probe + sugar layer used by every pg-* package. The
 * returned probeRoot is the seam the SqlDriver implementation calls
 * recordCall against.
 *
 * Example:
 *   let probeRoot;
 *   const driver: SqlDriver = {
 *     onApplicationQuery(call) {
 *       return probeRoot.recordCall(call, () => realExecute(call));
 *     },
 *     reset, close,
 *   };
 *   const adapter = createProbedSqlAdapter({ harness, driver });
 *   probeRoot = adapter.probeRoot;
 */
export function createProbedSqlAdapter(options: CreateProbedSqlAdapterOptions): ProbedSqlAdapter {
    const root: ProbeRoot<QueryCall, QueryPendingCall> = createProbeRoot<QueryCall, QueryPendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeQueryPending(record as CallRecord<QueryCall, QueryPendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{
                        fn: (call: QueryCall) => boolean;
                        label: string;
                    }>;
                    label: string;
                },
            },
        ],
    });

    // Add `sql(match)` typed sugar to the probe.
    const probe = root.probe as unknown as QueryProbe;
    (probe as { sql: (match: string | RegExp | ((s: string) => boolean)) => unknown }).sql = (
        match: string | RegExp | ((s: string) => boolean),
    ) => {
        const predicate = (call: QueryCall): boolean => {
            if (typeof match === 'string') return call.sql === match;
            if (match instanceof RegExp) return match.test(call.sql);
            return match(call.sql);
        };
        const label =
            typeof match === 'string'
                ? `sql === ${JSON.stringify(match)}`
                : match instanceof RegExp
                  ? `sql matches ${match.toString()}`
                  : 'sql matches predicate';
        return root.probe.filter(predicate, label) as unknown as ForwardableSelection<QueryCall, QueryPendingCall>;
    };

    return { probe, probeRoot: root };
}

function makeQueryPending(record: CallRecord<QueryCall, QueryPendingCall>): QueryPendingCall {
    const summary = summarizeSql(record.call.sql);
    const base = makeForwardablePending<QueryCall>(
        record as CallRecord<QueryCall, ForwardablePendingCall<QueryCall>>,
        summary,
    );
    const pending = Object.create(base) as ForwardablePendingCall<QueryCall>;
    Object.defineProperty(pending, 'sql', {
        get: () => record.call.sql,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'parameters', {
        get: () => record.call.parameters,
        enumerable: true,
        configurable: true,
    });
    return pending as QueryPendingCall;
}

function summarizeSql(sql: string): string {
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 60)}…`;
}
