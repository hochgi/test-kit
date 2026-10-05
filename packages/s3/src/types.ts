import type {
    ForwardablePendingCall,
    ForwardableProbe,
    ForwardableSelection,
    PendingCallBase,
    Probe,
    Selection,
} from '@hochgi/test-kit';
import type { S3Client, ServiceInputTypes } from '@aws-sdk/client-s3';
import type { RequestPresigningArguments } from '@aws-sdk/types';
import type { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ── S3 client probe ────────────────────────────────────────────────────────

export interface S3Call<TCommand = unknown> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

export interface S3PendingCall<TCommand = unknown, TResult = unknown> extends ForwardablePendingCall<
    S3Call<TCommand>,
    TResult
> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK command constructor type seam
export type S3CommandConstructor = new (...args: any[]) => {
    readonly input: unknown;
};

export interface S3Probe extends ForwardableProbe<S3Call, S3PendingCall> {
    /**
     * Typed sugar. With a constructor, narrows the selection to that command's
     * instance type. With a string, matches by commandName.
     */
    command<C extends S3CommandConstructor>(
        ctor: C,
    ): ForwardableSelection<S3Call<InstanceType<C>>, S3PendingCall<InstanceType<C>>>;
    command(name: string): ForwardableSelection<S3Call, S3PendingCall>;
}

// ── Presigner probe ────────────────────────────────────────────────────────

export interface PresignerAdapter {
    signUrl: typeof getSignedUrl;
}

export interface PresignCall {
    readonly commandName: string;
    readonly commandInput: unknown;
    readonly options: RequestPresigningArguments | undefined;
}

export interface PresignPendingCall<TResult = string> extends PendingCallBase<PresignCall, TResult> {
    readonly commandName: string;
    readonly commandInput: unknown;
    readonly options: RequestPresigningArguments | undefined;
}

export interface PresignerProbe extends Probe<PresignCall, PresignPendingCall> {
    command<C extends S3CommandConstructor>(ctor: C): Selection<PresignCall, PresignPendingCall>;
    command(name: string): Selection<PresignCall, PresignPendingCall>;
}

export type S3ClientType = S3Client;
export type ServiceInputTypesType = ServiceInputTypes;
