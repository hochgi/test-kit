import { SQSClient } from '@aws-sdk/client-sqs';
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
import type { SqsCall, SqsCommandConstructor, SqsPendingCall, SqsProbe } from './types.js';
import { InMemorySqsBacking, SUPPORTED_SQS_COMMANDS } from './in-memory-backing.js';

export interface CreateProbedSqsAdapterOptions {
    readonly harness: Harness;
    /** Queue name; default `test-queue`. */
    readonly queueName?: string;
    /**
     * Queue URL; default derived from `queueName` as
     * `https://sqs.test/000000000000/<queueName>`. The backing keys queues by
     * URL, so the SUT's `QueueUrl` must match this (or a URL returned by a
     * `GetQueueUrlCommand` against the same backing).
     */
    readonly queueUrl?: string;
    /** Default visibility timeout (seconds) for the queue; default 30. */
    readonly defaultVisibilityTimeoutSeconds?: number;
    readonly defaultTimeout?: Duration;
}

export type ProbedSqsAdapter = ProbedAdapterWithLifecycle<SQSClient, SqsProbe> & {
    readonly queueUrl: string;
    readonly queueName: string;
};

export function createProbedSqsAdapter(options: CreateProbedSqsAdapterOptions): ProbedSqsAdapter {
    const queueName = options.queueName ?? 'test-queue';
    const queueUrl = options.queueUrl ?? `https://sqs.test/000000000000/${queueName}`;

    const backing = new InMemorySqsBacking(options.harness.clock, {
        name: queueName,
        url: queueUrl,
        defaultVisibilityTimeoutSeconds: options.defaultVisibilityTimeoutSeconds,
    });

    const root: ProbeRoot<SqsCall, SqsPendingCall> = createProbeRoot<SqsCall, SqsPendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeSqsPending(record as CallRecord<SqsCall, SqsPendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{ fn: (call: SqsCall) => boolean; label: string }>;
                    label: string;
                },
            },
        ],
    });

    const probe = root.probe as unknown as SqsProbe;
    (probe as { command: (arg: SqsCommandConstructor | string) => unknown }).command = (
        arg: SqsCommandConstructor | string,
    ) => {
        const name = typeof arg === 'string' ? arg : arg.name;
        return root.probe.filter(
            (call) => call.commandName === name,
            `commandName === '${name}'`,
        ) as unknown as ForwardableSelection<SqsCall, SqsPendingCall>;
    };

    // Application-facing SQSClient. Override `.send` directly (same rationale
    // as the S3 adapter): the SDK middleware pipeline is fragile across
    // duplicate SDK copies common in monorepo `file:` ref setups. Dispatch by
    // `command.constructor.name` (a plain string) instead.
    const adapter = new SQSClient({ region: 'us-east-1' });
    const probedSend = (command: unknown): Promise<unknown> => {
        const commandName =
            (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'UnknownCommand';
        const input = (command as { input?: unknown } | null)?.input ?? {};
        const call: SqsCall = { commandName, command, input };
        return root.recordCall(call, async () => {
            if (!SUPPORTED_SQS_COMMANDS.has(commandName)) {
                throw errors.unsupportedForward('SQS', commandName);
            }
            return backing.dispatch(commandName, input);
        });
    };
    (adapter as unknown as { send: typeof probedSend }).send = probedSend;

    return {
        adapter,
        probe,
        queueUrl,
        queueName,
        async reset() {
            backing.reset();
        },
        async close() {
            backing.clear();
            root.dispose();
        },
    };
}

function makeSqsPending(record: CallRecord<SqsCall, SqsPendingCall>): SqsPendingCall {
    const base = makeForwardablePending<SqsCall>(
        record as CallRecord<SqsCall, ForwardablePendingCall<SqsCall>>,
        record.call.commandName,
    );
    const pending = Object.create(base) as ForwardablePendingCall<SqsCall>;
    Object.defineProperty(pending, 'commandName', {
        get: () => record.call.commandName,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'command', {
        get: () => record.call.command,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'input', {
        get: () => record.call.input,
        enumerable: true,
        configurable: true,
    });
    return pending as SqsPendingCall;
}
