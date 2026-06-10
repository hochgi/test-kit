import {
    createProbeRoot,
    emptyFilterChain,
    errors,
    makeForwardablePending,
    type CallRecord,
    type Duration,
    type ForwardablePendingCall,
    type ForwardableSelection,
    type Harness,
    type ProbeRoot,
    type ProbedAdapterWithLifecycle,
} from '@vnatures/test-kit';
import type { Queue } from 'bull';
import { InMemoryBullQueue, type AddOptions, type BullProcessor } from './backing.js';
import type { BullQueueCall, BullQueueMethod, BullQueuePendingCall, BullQueueProbe } from './types.js';

/**
 * Real Bull `Queue` methods this in-memory adapter deliberately does not
 * implement (yet). Accessing one returns a function that throws a clear,
 * actionable error rather than silently faking the operation.
 *
 * Everything *not* listed here and not in the supported surface falls through
 * to `undefined` (see the Proxy below), so framework introspection — NestJS
 * lifecycle hooks (`onModuleDestroy`, …), thenable checks (`then`), and test
 * matchers (`asymmetricMatch`, `$$typeof`) — stays safe. This mirrors the
 * `createProbedMock` rule: close the open category instead of enumerating it.
 */
const KNOWN_UNSUPPORTED_METHODS: ReadonlySet<string> = new Set([
    'pause',
    'resume',
    'empty',
    'clean',
    'obliterate',
    'count',
    'addBulk',
    'getJobLogs',
    'removeJobs',
    'getRepeatableJobs',
    'removeRepeatable',
    'removeRepeatableByKey',
    'getCompleted',
    'getFailed',
    'getDelayed',
    'getActive',
    'getWaiting',
    'getWaitingChildren',
    'whenCurrentJobsFinished',
]);

export interface CreateProbedBullQueueOptions<TData = unknown> {
    readonly harness: Harness;
    readonly name?: string;
    readonly defaultJobOptions?: AddOptions;
    readonly defaultTimeout?: Duration;
    readonly backing?: InMemoryBullQueue<TData>;
}

export type ProbedBullQueue<TData = unknown> = ProbedAdapterWithLifecycle<Queue<TData>, BullQueueProbe> & {
    readonly name: string;
};

export function maxRetriesPerRequestError(message = 'Reached the max retries per request limit'): Error {
    const err = new Error(message);
    err.name = 'MaxRetriesPerRequestError';
    return err;
}

export function createProbedBullQueue<TData = unknown>(
    options: CreateProbedBullQueueOptions<TData>,
): ProbedBullQueue<TData> {
    const name = options.name ?? 'test-queue';
    const backing = options.backing ?? new InMemoryBullQueue<TData>(name);

    const root: ProbeRoot<BullQueueCall, BullQueuePendingCall> = createProbeRoot<
        BullQueueCall,
        BullQueuePendingCall
    >({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeBullPending(record as CallRecord<BullQueueCall, BullQueuePendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{ fn: (call: BullQueueCall) => boolean; label: string }>;
                    label: string;
                },
            },
        ],
    });

    const probe = root.probe as unknown as BullQueueProbe;
    (probe as { on: (method: BullQueueMethod) => unknown }).on = (method: BullQueueMethod) =>
        root.probe.filter(
            (call) => call.method === method,
            `method === '${method}'`,
        ) as unknown as ForwardableSelection<BullQueueCall, BullQueuePendingCall>;

    const defaultJobOptions = options.defaultJobOptions;

    const baseAdapter = {
        // Bull exposes the queue identifier on `queue.name`; consumers and
        // @nestjs/bull read it, so the drop-in adapter must expose it too.
        name,

        add(
            nameOrData: string | TData,
            dataOrOpts?: TData | AddOptions,
            maybeOpts?: AddOptions,
        ): Promise<unknown> {
            const args =
                typeof nameOrData === 'string'
                    ? maybeOpts !== undefined
                      ? [nameOrData, dataOrOpts, maybeOpts]
                      : [nameOrData, dataOrOpts]
                    : dataOrOpts !== undefined
                      ? [nameOrData, dataOrOpts]
                      : [nameOrData];
            return root.recordCall({ method: 'add', args }, async () => {
                if (typeof nameOrData === 'string') {
                    const mergedOpts = mergeJobOptions(defaultJobOptions, maybeOpts);
                    return backing.add(nameOrData, dataOrOpts as TData, mergedOpts);
                }
                const mergedOpts = mergeJobOptions(defaultJobOptions, dataOrOpts as AddOptions | undefined);
                return backing.add(nameOrData, mergedOpts);
            });
        },

        process(...args: unknown[]): Promise<void> {
            return root.recordCall({ method: 'process', args }, async () => {
                const { name: jobName, handler } = extractProcessor<TData>(args);
                if (jobName !== undefined) {
                    backing.process(jobName, handler);
                } else {
                    backing.process(handler);
                }
            }) as Promise<void>;
        },

        getJob(jobId: string | number): Promise<unknown> {
            return backing.getJob(jobId);
        },

        getJobCounts(): Promise<unknown> {
            return backing.getJobCounts();
        },

        getJobs(types: string[]): Promise<unknown> {
            return backing.getJobs(types);
        },

        isReady(): Promise<void> {
            return backing.isReady();
        },

        close(): Promise<void> {
            return backing.close();
        },

        on: backing.on.bind(backing),
        once: backing.once.bind(backing),
        off: backing.off.bind(backing),
        removeListener: backing.removeListener.bind(backing),
        emit: backing.emit.bind(backing),
        listenerCount: backing.listenerCount.bind(backing),
        listeners: backing.listeners.bind(backing),
        rawListeners: backing.rawListeners.bind(backing),
        eventNames: backing.eventNames.bind(backing),
        prependListener: backing.prependListener.bind(backing),
        prependOnceListener: backing.prependOnceListener.bind(backing),
    };

    const adapter = new Proxy(baseAdapter, {
        get(target, prop, receiver) {
            // Loud failure only for known Bull methods we don't implement.
            // Unknown props (framework hooks, `then`, matcher symbols) fall
            // through to `undefined` so introspection stays safe.
            if (typeof prop === 'string' && !(prop in target) && KNOWN_UNSUPPORTED_METHODS.has(prop)) {
                return unsupportedMethod(prop);
            }
            return Reflect.get(target, prop, receiver);
        },
    }) as unknown as Queue<TData>;

    return {
        adapter,
        probe,
        name,
        async reset() {
            backing.reset();
        },
        async close() {
            await backing.close();
            root.dispose();
        },
    };
}

function mergeJobOptions(
    defaults: AddOptions | undefined,
    overrides: AddOptions | undefined,
): AddOptions | undefined {
    if (!defaults && !overrides) return undefined;
    return { ...defaults, ...overrides };
}

function extractProcessor<TData>(args: ReadonlyArray<unknown>): {
    name: string | undefined;
    handler: BullProcessor<TData>;
} {
    // Bull overloads: process(handler), process(concurrency, handler),
    // process(name, handler), process(name, concurrency, handler). The handler
    // is the last function arg; the job name, when present, is the leading
    // string arg. `concurrency` is intentionally ignored — in a deterministic
    // in-memory runner it has no observable effect on the SUT.
    let handler: BullProcessor<TData> | undefined;
    for (let i = args.length - 1; i >= 0; i -= 1) {
        if (typeof args[i] === 'function') {
            handler = args[i] as BullProcessor<TData>;
            break;
        }
    }
    if (!handler) {
        throw new Error('createProbedBullQueue: process() requires a handler function.');
    }
    const name = typeof args[0] === 'string' ? args[0] : undefined;
    return { name, handler };
}

function unsupportedMethod(method: string): () => never {
    return () => {
        throw errors.unsupportedForward('Bull', method);
    };
}

function makeBullPending(record: CallRecord<BullQueueCall, BullQueuePendingCall>): BullQueuePendingCall {
    const base = makeForwardablePending<BullQueueCall>(
        record as CallRecord<BullQueueCall, ForwardablePendingCall<BullQueueCall>>,
        record.call.method,
    );
    const pending = Object.create(base) as ForwardablePendingCall<BullQueueCall>;
    Object.defineProperty(pending, 'method', {
        get: () => record.call.method,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'args', {
        get: () => record.call.args,
        enumerable: true,
        configurable: true,
    });
    return pending as BullQueuePendingCall;
}
