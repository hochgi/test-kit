import { S3Client } from '@aws-sdk/client-s3';
import {
    createProbeRoot,
    emptyFilterChain,
    errors,
    makeForwardablePending,
    type CallRecord,
    type Duration,
    type ForwardablePendingCall,
    type ForwardableSelection,
    type Rig,
    type ProbeRoot,
    type ProbedAdapterWithLifecycle,
} from '@vnatures/test-kit';
import type { S3Call, S3CommandConstructor, S3PendingCall, S3Probe } from '../types.js';
import { InMemoryS3Backing } from './in-memory-backing.js';

/**
 * Commands the in-memory backing implements end-to-end. Any command outside
 * this set throws the templated unsupportedForward error on forward; tests
 * must answer or reject explicitly.
 *
 * The dispatcher inside `InMemoryS3Backing.dispatch` is the source of truth
 * for what's actually wired up — this set is the public contract that
 * `forward()` will succeed for.
 */
const SUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
    'PutObjectCommand',
    'GetObjectCommand',
    'HeadObjectCommand',
    'DeleteObjectCommand',
    'DeleteObjectsCommand',
    'ListObjectsCommand',
    'ListObjectsV2Command',
    'CopyObjectCommand',
    'GetObjectTaggingCommand',
    'PutObjectTaggingCommand',
    'CreateBucketCommand',
    'DeleteBucketCommand',
]);

export interface CreateProbedS3AdapterOptions {
    readonly harness: Rig;
    readonly bucket: string;
    /**
     * Deprecated. Retained for source-compat with v1; ignored by the
     * in-memory backing. Will be removed in a future major release.
     */
    readonly localDirectory?: string;
    readonly defaultTimeout?: Duration;
}

export type ProbedS3Adapter = ProbedAdapterWithLifecycle<S3Client, S3Probe> & {
    readonly bucket: string;
    /**
     * Always an empty string for in-memory backing. Retained for source-
     * compat with v1; ignore.
     */
    readonly localDirectory: string;
};

export function createProbedS3Adapter(options: CreateProbedS3AdapterOptions): ProbedS3Adapter {
    const { bucket } = options;
    if (!bucket || typeof bucket !== 'string') {
        throw new Error('createProbedS3Adapter: `bucket` (string) is required.');
    }

    // In-memory backing — no disk I/O, no SDK-copy fragility, no
    // mock-aws-s3-v3 dependency. Dispatch by `command.constructor.name` (a
    // plain string) is robust to consumers and test-kit-s3 having different
    // copies of @aws-sdk/client-s3, which is common with `file:` workspace
    // refs and dev-time monorepo setups.
    const backing = new InMemoryS3Backing([bucket]);

    const root: ProbeRoot<S3Call, S3PendingCall> = createProbeRoot<S3Call, S3PendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeS3Pending(record as CallRecord<S3Call, S3PendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{
                        fn: (call: S3Call) => boolean;
                        label: string;
                    }>;
                    label: string;
                },
            },
        ],
    });

    const probe = root.probe as unknown as S3Probe;
    (probe as { command: (arg: S3CommandConstructor | string) => unknown }).command = (
        arg: S3CommandConstructor | string,
    ) => {
        const name = typeof arg === 'string' ? arg : arg.name;
        return root.probe.filter(
            (call) => call.commandName === name,
            `commandName === '${name}'`,
        ) as unknown as ForwardableSelection<S3Call, S3PendingCall>;
    };

    // The application-facing S3Client. We can't rely on the SDK's middleware
    // pipeline (commands from a different SDK copy wouldn't traverse it
    // correctly), so we override `.send` directly. The override extracts
    // `commandName` (a string) and `input` from the user's command and
    // dispatches into the in-memory backing — no instanceof gymnastics.
    const adapter = new S3Client({ region: 'us-east-1' });
    const probedSend = (command: unknown): Promise<unknown> => {
        const commandName =
            (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'UnknownCommand';
        const input = (command as { input?: unknown } | null)?.input ?? {};
        const call: S3Call = { commandName, command, input };
        return root.recordCall(call, async () => {
            if (!SUPPORTED_COMMANDS.has(commandName)) {
                throw errors.unsupportedForward('S3', commandName);
            }
            return backing.dispatch(commandName, input);
        });
    };
    (adapter as unknown as { send: typeof probedSend }).send = probedSend;

    return {
        adapter,
        probe,
        bucket,
        localDirectory: '',
        async reset() {
            backing.reset();
        },
        async close() {
            backing.clear();
            root.dispose();
        },
    };
}

function makeS3Pending(record: CallRecord<S3Call, S3PendingCall>): S3PendingCall {
    const base = makeForwardablePending<S3Call>(
        record as CallRecord<S3Call, ForwardablePendingCall<S3Call>>,
        record.call.commandName,
    );
    const pending = Object.create(base) as ForwardablePendingCall<S3Call>;
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
    return pending as S3PendingCall;
}
