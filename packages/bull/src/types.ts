import type { ForwardablePendingCall, ForwardableProbe, ForwardableSelection } from '@vnatures/test-kit';
import type { Job, Queue } from 'bull';

export type BullQueueMethod = 'add' | 'process';

export interface BullQueueCall {
    readonly method: BullQueueMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface BullQueuePendingCall<TResult = unknown> extends ForwardablePendingCall<BullQueueCall, TResult> {
    readonly method: BullQueueMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface BullQueueProbe extends ForwardableProbe<BullQueueCall, BullQueuePendingCall> {
    on(method: BullQueueMethod): ForwardableSelection<BullQueueCall, BullQueuePendingCall>;
}

export type BullQueueType<TData> = Queue<TData>;
export type BullJobType<TData> = Job<TData>;
