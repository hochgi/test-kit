import type { ForwardablePendingCall, ForwardableProbe, ForwardableSelection } from '@vnatures/test-kit';
import type { SQSClient } from '@aws-sdk/client-sqs';

// ── SQS client probe ───────────────────────────────────────────────────────

/**
 * One recorded SQS call. Mirrors the S3 probe shape: `commandName` is the
 * constructor name of the AWS SDK command (a plain string, robust to
 * duplicate SDK copies in monorepos), `command` is the original command
 * object, `input` is the command's input shape.
 */
export interface SqsCall<TCommand = unknown> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

export interface SqsPendingCall<TCommand = unknown, TResult = unknown> extends ForwardablePendingCall<
    SqsCall<TCommand>,
    TResult
> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

export type SqsCommandConstructor = new (...args: any[]) => {
    readonly input: unknown;
};

export interface SqsProbe extends ForwardableProbe<SqsCall, SqsPendingCall> {
    /**
     * Typed sugar. With a constructor, narrows the selection to that command's
     * instance type. With a string, matches by commandName.
     */
    command<C extends SqsCommandConstructor>(
        ctor: C,
    ): ForwardableSelection<SqsCall<InstanceType<C>>, SqsPendingCall<InstanceType<C>>>;
    command(name: string): ForwardableSelection<SqsCall, SqsPendingCall>;
}

export type SqsClientType = SQSClient;
