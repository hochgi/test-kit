import {
    createProbeRoot,
    errors,
    makePendingBase,
    type CallRecord,
    type Duration,
    type Rig,
    type PendingCallBase,
    type ProbeRoot,
    type ProbedAdapterWithLifecycle,
    type Selection,
} from '@vnatures/test-kit';
import type { RequestPresigningArguments } from '@aws-sdk/types';
import type {
    PresignCall,
    PresignerAdapter,
    PresignerProbe,
    PresignPendingCall,
    S3CommandConstructor,
} from '../types.js';

export interface CreateProbedPresignerAdapterOptions {
    readonly harness: Rig;
    readonly defaultTimeout?: Duration;
}

export type ProbedPresignerAdapter = ProbedAdapterWithLifecycle<PresignerAdapter, PresignerProbe>;

export function createProbedPresignerAdapter(options: CreateProbedPresignerAdapterOptions): ProbedPresignerAdapter {
    const root: ProbeRoot<PresignCall, PresignPendingCall> = createProbeRoot<PresignCall, PresignPendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: false,
        pendingFactory: (record) => makePresignPending(record as CallRecord<PresignCall, PresignPendingCall>),
        // No default rule. Calls park; tests must answer or reject explicitly.
    });

    const probe = root.probe as unknown as PresignerProbe;
    (probe as { command: (arg: S3CommandConstructor | string) => unknown }).command = (
        arg: S3CommandConstructor | string,
    ) => {
        const name = typeof arg === 'string' ? arg : arg.name;
        return root.probe.filter(
            (call) => call.commandName === name,
            `commandName === '${name}'`,
        ) as unknown as Selection<PresignCall, PresignPendingCall>;
    };

    // The presigner adapter wraps the user's `getSignedUrl`-shaped call into
    // a recorded probe call. We don't import getSignedUrl from the AWS SDK —
    // we just expose a function with the same shape that goes through the probe.
    // The fact that our adapter has no backing means `forward()` and
    // `default forward` both throw — tests must answer or reject.
    const signUrl = ((
        _client: unknown,
        command: { constructor?: { name?: string }; input?: unknown },
        optsArg?: RequestPresigningArguments,
    ): Promise<string> => {
        const commandName = command.constructor?.name ?? 'UnknownCommand';
        const call: PresignCall = {
            commandName,
            commandInput: command.input,
            options: optsArg,
        };
        return root.recordCall(call, () =>
            Promise.reject(errors.unsupportedForward('presigner', commandName)),
        ) as Promise<string>;
    }) as PresignerAdapter['signUrl'];

    const adapter: PresignerAdapter = { signUrl };

    return {
        adapter,
        probe,
        async reset() {
            // No external state to reset for the presigner.
        },
        async close() {
            root.dispose();
        },
    };
}

function makePresignPending(record: CallRecord<PresignCall, PresignPendingCall>): PresignPendingCall {
    const base = makePendingBase<PresignCall>(
        record as CallRecord<PresignCall, PendingCallBase<PresignCall>>,
        record.call.commandName,
    );
    const pending = Object.create(base) as PendingCallBase<PresignCall>;
    Object.defineProperty(pending, 'commandName', {
        get: () => record.call.commandName,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'commandInput', {
        get: () => record.call.commandInput,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'options', {
        get: () => record.call.options,
        enumerable: true,
        configurable: true,
    });
    return pending as PresignPendingCall;
}
