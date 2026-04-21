import { realSetTimeout, realClearTimeout, createDeferred, toError, type Deferred } from './internal';

// ── Public types ────────────────────────────────────────────────────────────

export interface S3Call {
    readonly commandName: string;
    readonly input: unknown;
}

export interface PendingS3Call {
    readonly commandName: string;
    readonly input: unknown;
    readonly settled: boolean;
    forward(): void;
    answer(output: unknown): void;
    reject(error: unknown): void;
}

export type AnswerFn = (call: S3Call) => unknown;

/** Narrow type for an SDK command constructor: `new GetObjectCommand(input).input === input`. */
export type CommandCtor = new (input: any) => { readonly input: unknown };

// ── Internal state ──────────────────────────────────────────────────────────

type CallInternal = {
    index: number;
    commandName: string;
    input: unknown;
    deferred: Deferred<unknown>;
    realFn: () => Promise<unknown>;
    settled: boolean;
};

type PlannedBehavior =
    | { type: 'forward' }
    | { type: 'answer'; value: unknown }
    | { type: 'answerFn'; fn: AnswerFn }
    | { type: 'reject'; error: unknown };

type Waiter = {
    predicate: (call: S3Call) => boolean;
    resolve: (pending: PendingS3Call) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof realSetTimeout>;
};

// ── PendingS3Call factory ───────────────────────────────────────────────────

function makePending(internal: CallInternal): PendingS3Call {
    return {
        get commandName() {
            return internal.commandName;
        },
        get input() {
            return internal.input;
        },
        get settled() {
            return internal.settled;
        },
        forward() {
            if (internal.settled) {
                throw new Error(`S3 call "${internal.commandName}" is already settled.`);
            }
            internal.settled = true;
            internal.realFn().then(
                (result) => internal.deferred.resolve(result),
                (err) => internal.deferred.reject(toError(err)),
            );
        },
        answer(output: unknown) {
            if (internal.settled) {
                throw new Error(`S3 call "${internal.commandName}" is already settled.`);
            }
            internal.settled = true;
            internal.deferred.resolve(output);
        },
        reject(error: unknown) {
            if (internal.settled) {
                throw new Error(`S3 call "${internal.commandName}" is already settled.`);
            }
            internal.settled = true;
            internal.deferred.reject(toError(error));
        },
    };
}

// ── S3Probe ─────────────────────────────────────────────────────────────────

export class S3Probe {
    private readonly queue: CallInternal[] = [];

    private readonly consumed = new Set<number>();

    private readonly waiters: Waiter[] = [];

    private readonly plannedByCommand = new Map<string, PlannedBehavior[]>();

    private permanent: PlannedBehavior | undefined = { type: 'forward' };

    private nextIndex = 0;

    /** @internal — called by the probed S3 client wrapper. */
    recordCall(commandName: string, input: unknown, realFn: () => Promise<unknown>): Promise<unknown> {
        const deferred = createDeferred<unknown>();
        const index = this.nextIndex;
        this.nextIndex += 1;

        const internal: CallInternal = {
            index,
            commandName,
            input,
            deferred,
            realFn,
            settled: false,
        };

        this.queue.push(internal);

        for (let i = 0; i < this.waiters.length; i += 1) {
            const waiter = this.waiters[i];
            if (waiter.predicate({ commandName, input })) {
                this.waiters.splice(i, 1);
                if (waiter.timer) realClearTimeout(waiter.timer);
                this.consumed.add(index);
                waiter.resolve(makePending(internal));
                return deferred.promise;
            }
        }

        const behavior = this.resolveBehavior(commandName);
        if (behavior) {
            this.applyBehavior(internal, behavior);
        }

        return deferred.promise;
    }

    // ── Plumbing: wait for calls ────────────────────────────────────────────

    async expectNext(timeoutMs = 5000): Promise<PendingS3Call> {
        return this.expectMatching(() => true, timeoutMs);
    }

    async expectMatching(predicate: (call: S3Call) => boolean, timeoutMs = 5000): Promise<PendingS3Call> {
        for (const internal of this.queue) {
            if (
                !this.consumed.has(internal.index) &&
                !internal.settled &&
                predicate({ commandName: internal.commandName, input: internal.input })
            ) {
                this.consumed.add(internal.index);
                return makePending(internal);
            }
        }

        return new Promise<PendingS3Call>((resolve, reject) => {
            const waiter: Waiter = { predicate, resolve, reject };
            waiter.timer = realSetTimeout(() => {
                this.removeWaiter(waiter);
                reject(new Error(`Timed out waiting for matching S3 call after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    // ── Observation ─────────────────────────────────────────────────────────

    get calls(): ReadonlyArray<S3Call> {
        return this.queue.map((c) => ({ commandName: c.commandName, input: c.input }));
    }

    pendingCount(): number {
        let count = 0;
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) count += 1;
        }
        return count;
    }

    callsOf(commandCtor: CommandCtor | string): ReadonlyArray<S3Call> {
        const name = typeof commandCtor === 'string' ? commandCtor : commandCtor.name;
        return this.queue
            .filter((c) => c.commandName === name)
            .map((c) => ({ commandName: c.commandName, input: c.input }));
    }

    // ── Porcelain: pre-program behavior ─────────────────────────────────────

    whenCalled(commandCtor: CommandCtor | string): {
        thenForward(): void;
        thenAnswer(output: unknown): void;
        thenReject(error: unknown): void;
    } {
        const name = typeof commandCtor === 'string' ? commandCtor : commandCtor.name;
        return {
            thenForward: () => {
                this.addPlannedBehavior(name, { type: 'forward' });
            },
            thenAnswer: (output: unknown) => {
                this.addPlannedBehavior(name, { type: 'answer', value: output });
            },
            thenReject: (error: unknown) => {
                this.addPlannedBehavior(name, { type: 'reject', error });
            },
        };
    }

    alwaysForward(): void {
        this.permanent = { type: 'forward' };
    }

    /**
     * Programs a permanent default answer computed per-call. `fn` receives the full
     * S3Call (commandName + input) and returns the output to resolve with.
     */
    alwaysAnswer(fn: AnswerFn): void {
        this.permanent = { type: 'answerFn', fn };
    }

    alwaysReject(error: unknown): void {
        this.permanent = { type: 'reject', error };
    }

    clearBehavior(): void {
        this.permanent = undefined;
        this.plannedByCommand.clear();
    }

    // ── Drain helpers ───────────────────────────────────────────────────────

    drainWith(handler: (pending: PendingS3Call) => void): void {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) {
                this.consumed.add(internal.index);
                handler(makePending(internal));
            }
        }
    }

    drain(): void {
        this.drainWith(() => {});
    }

    drainAndForwardAll(): void {
        this.drainWith((c) => {
            if (!c.settled) c.forward();
        });
    }

    drainAndRejectAll(error?: Error): void {
        this.drainWith((c) => {
            if (!c.settled) c.reject(error ?? new Error('drained'));
        });
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private addPlannedBehavior(commandName: string, behavior: PlannedBehavior): void {
        const list = this.plannedByCommand.get(commandName) ?? [];
        list.push(behavior);
        this.plannedByCommand.set(commandName, list);
    }

    private resolveBehavior(commandName: string): PlannedBehavior | undefined {
        const list = this.plannedByCommand.get(commandName);
        if (list && list.length > 0) {
            const behavior = list.shift();
            if (list.length === 0) this.plannedByCommand.delete(commandName);
            return behavior;
        }
        return this.permanent;
    }

    private applyBehavior(call: CallInternal, behavior: PlannedBehavior): void {
        if (call.settled) return;
        if (behavior.type === 'forward') {
            call.settled = true;
            call.realFn().then(
                (result) => call.deferred.resolve(result),
                (err) => call.deferred.reject(toError(err)),
            );
            return;
        }
        if (behavior.type === 'answer') {
            call.settled = true;
            call.deferred.resolve(behavior.value);
            return;
        }
        if (behavior.type === 'answerFn') {
            call.settled = true;
            try {
                const result = behavior.fn({ commandName: call.commandName, input: call.input });
                if (result && typeof (result as Promise<unknown>).then === 'function') {
                    (result as Promise<unknown>).then(
                        (v) => call.deferred.resolve(v),
                        (e) => call.deferred.reject(toError(e)),
                    );
                } else {
                    call.deferred.resolve(result);
                }
            } catch (error) {
                call.deferred.reject(toError(error));
            }
            return;
        }
        // reject
        call.settled = true;
        call.deferred.reject(toError(behavior.error));
    }

    private removeWaiter(waiter: Waiter): void {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
    }
}
