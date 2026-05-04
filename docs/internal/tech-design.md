# Test-Kit Tech Design

This document is the implementation specification for test-kit. It
specifies the internal contracts between core and domain packages and
sketches the algorithms and data structures the engine uses.

It is intended to be precise enough that a contributor can sit down and
implement (or change) against it without further design conversation.
Where a decision could go either way, this doc picks one and states why.

## Reading Order

This is the contributor-facing companion to the consumer-facing docs:

- [`../concepts.md`](../concepts.md): mental model and ergonomics (what
  tests look like).
- [`../api-surface.md`](../api-surface.md): the public TypeScript API
  (what users import).
- [`../architecture.md`](../architecture.md): package layout (what code
  lives where).
- This document: implementation specification (how the internals are
  built).

Anything not specified here should follow the patterns established in
the three companion docs. Where this doc contradicts a companion, this
doc loses — fix it.

## Open Decisions Resolved In This Doc

The seven open decisions from the architecture doc, with chosen
positions:

1. **`core.createProbeRoot` signature** — see "Internal Core API."
2. **Internal storage representation** — single-array history,
   ordered-by-arrival; rule queues as plain arrays with index-based
   removal; waiter lists as plain arrays with predicate-eval-on-each.
   See "Internal Storage Model."
3. **Bundling tool** — Vite library mode (with `vite-plugin-dts` for
   `.d.ts` generation). Same tool as Vitest; matches the team's
   existing toolchain on application/SUT projects. See "Build &
   Distribution."
4. **Test runner for the kit's own tests** — Vitest. See "Testing
   Strategy."
5. **`@vnatures/test-kit-pglite-driver` published vs. private** — private
   (workspace-internal). Revisit only if a community ORM package
   wants to reuse it.
6. **Error class hierarchy** — plain `Error` and `RangeError` only.
   No `TestKitError` base class. Diagnostic information comes from
   the message string, not the type. See "Error Handling."
7. **Package naming** — deferred to release decision. The
   implementation uses `@vnatures/test-kit-*` as a placeholder; renaming is a
   global find-and-replace at release time, not a code change.

## Internal Storage Model

Each probe owns a single mutable state object. All operations on the
probe (and on selections derived from it) read or mutate this state.
Selections do not own state of their own; they hold a reference to
their parent probe and a frozen filter chain.

### Probe state struct

```typescript
interface ProbeState<TCall, TPending extends PendingCallBase<TCall>> {
    /**
     * All recorded calls in arrival order. Append-only during the
     * probe's lifetime; cleared by clearCalls() / resetProbe() /
     * harness.reset(). Each entry is an internal record (CallRecord),
     * not the public TCall view.
     */
    readonly history: CallRecord<TCall, TPending>[];

    /**
     * One-shot rules in registration order (FIFO). When a rule fires,
     * it is removed from this array.
     */
    readonly oneShotRules: RuleEntry<TCall, TPending>[];

    /**
     * Permanent rules in registration order. Tier-3 walks this array
     * from the END (LIFO match).
     */
    readonly permanentRules: RuleEntry<TCall, TPending>[];

    /**
     * Capturing waiters from expect.intercept() in registration order
     * (FIFO).
     */
    readonly capturingWaiters: WaiterEntry<TCall, TPending>[];

    /**
     * Observing waiters from expect.observe() in registration order
     * (FIFO).
     */
    readonly observingWaiters: ObserverEntry<TCall>[];

    /**
     * Domain-specific configuration captured at probe construction.
     */
    readonly config: ProbeConfig<TCall, TPending>;

    /**
     * Whether the probe's owning harness has been closed. After
     * close, all probe operations throw.
     */
    closed: boolean;
}
```

### Call records

Each call recorded by the probe gets a `CallRecord` that lives in
`history`:

```typescript
interface CallRecord<TCall, TPending extends PendingCallBase<TCall>> {
    /** Monotonic record ID. Used by waiters to skip already-considered records. */
    readonly id: number;

    /** The public-facing call shape (what selection.calls returns). */
    readonly call: TCall;

    /** The deferred backing the application's awaiting promise. */
    readonly deferred: Deferred<unknown>;

    /** True once any tier has acted on this call. */
    routed: boolean;

    /** True once the application's promise has settled (resolve/reject). */
    settled: boolean;

    /**
     * True if the call was matched by an explicit park rule (once or
     * always with .park()). Distinguishes "parked because no rule
     * matched" (routed=false, settled=false) from "parked because a
     * rule said so" (routed=true, settled=false).
     *
     * Used by retroactive intercept eligibility: a parked call is
     * retroactively interceptable iff routed=false.
     */
    ruleParked: boolean;

    /**
     * Optional forward function, supplied by the domain package at
     * recordCall time. Present only on backed adapters.
     */
    readonly forwardFn?: () => Promise<unknown>;
}
```

The `Deferred<T>` type is the standard "promise + resolve + reject"
triple:

```typescript
interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}
```

### Rule entries

```typescript
interface RuleEntry<TCall, TPending extends PendingCallBase<TCall>> {
    /** The filter chain attached to the selection that registered this rule. */
    readonly filter: FilterChain<TCall>;

    /** What the rule does when it fires. See RuleAction below. */
    readonly action: RuleAction<TCall, TPending>;

    /**
     * Tag identifying whether this rule was installed by the harness
     * (factory-default) or by user code. clearRules() with default
     * options preserves harness-installed rules.
     */
    readonly origin: 'harness' | 'user';
}

type RuleAction<TCall, TPending extends PendingCallBase<TCall>> =
    | { kind: 'answer'; value: PendingAnswer<TPending> }
    | { kind: 'answerWith'; fn: (call: TCall) => unknown | Promise<unknown> }
    | { kind: 'reject'; error: unknown }
    | { kind: 'forward' }    // only valid on backed adapters
    | { kind: 'park' };
```

### Waiter entries

```typescript
interface WaiterEntry<TCall, TPending extends PendingCallBase<TCall>> {
    readonly filter: FilterChain<TCall>;
    readonly resolve: (pending: TPending) => void;
    readonly reject: (error: Error) => void;
    readonly deadline: number;     // wall-clock ms; from realClock at registration time
    readonly timer: TimerHandle;   // globalThis.setTimeout handle
    readonly registeredAt: number; // monotonic counter; for FIFO ordering
}

interface ObserverEntry<TCall> {
    readonly filter: FilterChain<TCall>;
    readonly resolve: (call: TCall) => void;
    readonly reject: (error: Error) => void;
    readonly deadline: number;
    readonly timer: TimerHandle;
    readonly registeredAt: number;
}
```

### Filter chains

A filter chain is the conjunction of zero-or-more predicates accumulated
by a chain of `selection.filter(...)` calls. The probe root's filter
chain is empty (matches all calls).

```typescript
interface FilterChain<TCall> {
    /** Each predicate must return true for the chain to match. */
    readonly predicates: ReadonlyArray<{
        readonly fn: (call: TCall) => boolean;
        readonly label: string;
    }>;

    /** Concatenated label, joined by " AND ". Used in error messages. */
    readonly label: string;
}
```

`FilterChain` is immutable. `selection.filter(p, label)` returns a new
`Selection` whose chain is the parent's chain with one more predicate
appended; the parent's chain is unchanged.

Match check (used by every tier):

```typescript
function matches<TCall>(chain: FilterChain<TCall>, call: TCall): boolean {
    for (const p of chain.predicates) {
        if (!p.fn(call)) return false;
    }
    return true;
}
```

## Internal Core API

### `createProbeRoot`

The single factory function domain packages use to construct a probe.

```typescript
export function createProbeRoot<TCall, TPending extends PendingCallBase<TCall>>(
    config: ProbeRootConfig<TCall, TPending>,
): ProbeRoot<TCall, TPending>;

export interface ProbeRootConfig<TCall, TPending extends PendingCallBase<TCall>> {
    /** Harness reference. Required for backed adapters; optional for mocks. */
    readonly harness?: Harness;

    /**
     * Default expectation timeout when `within` is omitted on a
     * positive expectation. Overrides harness.defaultTimeout for
     * this probe. Falls back to harness.defaultTimeout, then to
     * seconds(5).
     */
    readonly defaultTimeout?: Duration;

    /**
     * Constructs the public-facing PendingCall for an internal
     * CallRecord. Domain packages provide this so they can inject
     * their domain-specific accessors (pending.method, pending.sql,
     * pending.commandName, etc.).
     */
    readonly pendingFactory: (record: CallRecord<TCall, TPending>) => TPending;

    /**
     * If truthy, the probe supports forward() on rules and pending
     * calls. Forward actions on rules are only legal when this is
     * true; the type system enforces this via ForwardableSelection.
     * The runtime check is a defense against `as any` escape hatches.
     */
    readonly forwardable?: boolean;

    /**
     * Optional default rules to install at construction. These are
     * marked origin: 'harness' so clearRules() preserves them.
     * Order matters: later entries are registered later (so they sit
     * on top of the LIFO permanent stack).
     */
    readonly defaultRules?: ReadonlyArray<{
        readonly action: RuleAction<TCall, TPending>;
        readonly filter: FilterChain<TCall>;
    }>;
}

export interface ProbeRoot<TCall, TPending extends PendingCallBase<TCall>> {
    /** The public Probe surface, returned to the user. */
    readonly probe: Probe<TCall, TPending>;

    /**
     * Domain-package-only entry point: record a call from the SUT.
     * The probe routes the call through rule resolution and returns
     * a Promise that the application awaits.
     *
     * For backed adapters, supply forwardFn. For mocks, omit it
     * (forward rules will throw at runtime).
     */
    recordCall(call: TCall, forwardFn?: () => Promise<unknown>): Promise<unknown>;

    /**
     * Domain-package-only: dispose internal state. Called by the
     * harness during close(). Cancels all in-flight waiters with the
     * standard "Harness closed with N unsettled waiter(s)" error.
     */
    dispose(): void;
}
```

The `ProbeRoot.probe` property is the user-facing object. The
`recordCall` and `dispose` properties are internal — domain packages
hold the `ProbeRoot` reference privately and only expose `probe` on
the returned `ProbedAdapter`.

### `recordCall` flow

This is the hot path. Every SUT call to a probed boundary lands here.

```typescript
function recordCall<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    call: TCall,
    forwardFn?: () => Promise<unknown>,
): Promise<unknown> {
    if (state.closed) {
        return Promise.reject(new Error('Harness is closed.'));
    }

    const record: CallRecord<TCall, TPending> = {
        id: state.history.length,
        call,
        deferred: createDeferred(),
        routed: false,
        settled: false,
        ruleParked: false,
        forwardFn,
    };
    state.history.push(record);

    // Tier 1a: notify all matching observers (notify-only, FIFO).
    for (const observer of state.observingWaiters.slice()) {
        if (matches(observer.filter, call)) {
            removeObserver(state, observer);
            clearTimeout(observer.timer);
            observer.resolve(call);
        }
    }

    // Tier 1b: oldest matching capturing waiter consumes.
    for (const waiter of state.capturingWaiters) {
        if (matches(waiter.filter, call)) {
            removeCapturingWaiter(state, waiter);
            clearTimeout(waiter.timer);
            record.routed = true;
            const pending = state.config.pendingFactory(record);
            waiter.resolve(pending);
            return record.deferred.promise;
        }
    }

    // Tier 2: oldest matching one-shot rule fires.
    for (let i = 0; i < state.oneShotRules.length; i++) {
        const rule = state.oneShotRules[i];
        if (matches(rule.filter, call)) {
            state.oneShotRules.splice(i, 1);
            applyRule(state, record, rule);
            return record.deferred.promise;
        }
    }

    // Tier 3: newest matching permanent rule fires (LIFO).
    for (let i = state.permanentRules.length - 1; i >= 0; i--) {
        const rule = state.permanentRules[i];
        if (matches(rule.filter, call)) {
            applyRule(state, record, rule);
            return record.deferred.promise;
        }
    }

    // Default: park (no rule matched). routed remains false →
    // retroactively interceptable.
    return record.deferred.promise;
}
```

### `applyRule`

Settles a record according to a rule's action. Sets `record.routed = true`
unconditionally; sets `record.settled` only when the action actually
resolves or rejects the deferred (not for park).

```typescript
function applyRule<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    record: CallRecord<TCall, TPending>,
    rule: RuleEntry<TCall, TPending>,
): void {
    record.routed = true;

    switch (rule.action.kind) {
        case 'answer':
            record.settled = true;
            record.deferred.resolve(rule.action.value);
            return;

        case 'reject':
            record.settled = true;
            record.deferred.reject(toError(rule.action.error));
            return;

        case 'answerWith': {
            // Run fn; resolve or reject based on its return value.
            // Sync throw → reject. Async rejection → reject. Hanging
            // Promise → never settles (record.settled stays false
            // until safety timeout).
            let result: unknown;
            try {
                result = rule.action.fn(record.call);
            } catch (err) {
                record.settled = true;
                record.deferred.reject(toError(err));
                return;
            }
            if (isPromise(result)) {
                result.then(
                    (value) => {
                        record.settled = true;
                        record.deferred.resolve(value);
                    },
                    (err) => {
                        record.settled = true;
                        record.deferred.reject(toError(err));
                    },
                );
            } else {
                record.settled = true;
                record.deferred.resolve(result);
            }
            return;
        }

        case 'forward':
            if (!record.forwardFn) {
                record.settled = true;
                record.deferred.reject(
                    new Error(`Cannot forward: this probe has no backing.`),
                );
                return;
            }
            record.forwardFn().then(
                (value) => {
                    record.settled = true;
                    record.deferred.resolve(value);
                },
                (err) => {
                    record.settled = true;
                    record.deferred.reject(toError(err));
                },
            );
            return;

        case 'park':
            record.ruleParked = true;
            // record.settled stays false; deferred is never settled
            // by this rule. Test must drain or close to clear it.
            return;
    }
}
```

### Retroactive intercept

When `expect.intercept` is called, the engine first walks history for
an already-arrived eligible match before registering a waiter:

```typescript
function intercept<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    options: ExpectOptions,
): Promise<TPending> {
    // Retroactive eligibility: routed=false (no rule of any kind
    // has acted on this call yet).
    for (const record of state.history) {
        if (!record.routed && matches(filter, record.call)) {
            record.routed = true;
            return Promise.resolve(state.config.pendingFactory(record));
        }
    }

    // Otherwise register a future waiter.
    return new Promise<TPending>((resolve, reject) => {
        const timeout = options.within ?? state.config.defaultTimeout;
        const timer = globalThis.setTimeout(
            () => {
                removeCapturingWaiter(state, waiter);
                reject(new Error(
                    `Timed out after ${timeout.milliseconds}ms waiting for next call matching ${filter.label}.`,
                ));
            },
            timeout.milliseconds,
        );
        const waiter: WaiterEntry<TCall, TPending> = {
            filter,
            resolve,
            reject,
            deadline: Date.now() + timeout.milliseconds,
            timer,
            registeredAt: nextWaiterId(),
        };
        state.capturingWaiters.push(waiter);
    });
}
```

`expect.observe` is structurally identical except: no retroactive walk
(observers don't fire on past calls — they're notified on incoming
calls only); resolves with `TCall` instead of `TPending`; uses
`observingWaiters` instead of `capturingWaiters`.

### `expect.none`

Real-wall-clock wait, then check history. Does NOT advance virtual time.

```typescript
function none<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    options: RequiredWithinOptions,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        globalThis.setTimeout(
            () => {
                queueMicrotask(() => {
                    const matching = state.history.filter((r) => matches(filter, r.call));
                    if (matching.length === 0) {
                        resolve();
                    } else {
                        reject(new Error(
                            `Expected no calls matching ${filter.label} within ${options.within.milliseconds}ms, but received ${matching.length}.`,
                        ));
                    }
                });
            },
            options.within.milliseconds,
        );
    });
}
```

`within: ms(0)` → setTimeout fires on next tick, microtask flush, then
check. Common idiom for "right now after the event loop drains."

### `expect.atLeast` and `expect.exactly`

`atLeast(n, { within })`: resolve as soon as `n` matching calls have
been recorded; reject on timeout.

`exactly(n, { within })`: wait the full window, then assert exactly `n`.

Both implementations are similar in shape:

```typescript
function atLeast<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    n: number,
    options: ExpectOptions,
): Promise<ReadonlyArray<TCall>> {
    const timeout = options.within ?? state.config.defaultTimeout;

    return new Promise((resolve, reject) => {
        const check = () => state.history.filter((r) => matches(filter, r.call)).map((r) => r.call);

        // Already met?
        const initial = check();
        if (initial.length >= n) {
            resolve(initial);
            return;
        }

        // Otherwise register a polling check on each new call. The
        // probe's recordCall fires a notification hook that evaluates
        // pending atLeast/exactly waiters.
        const handle = subscribeToCalls(state, () => {
            const current = check();
            if (current.length >= n) {
                cleanup();
                resolve(current);
            }
        });

        const timer = globalThis.setTimeout(() => {
            cleanup();
            reject(new Error(
                `Timed out after ${timeout.milliseconds}ms waiting for atLeast(${n}) calls matching ${filter.label}. Got ${check().length}.`,
            ));
        }, timeout.milliseconds);

        const cleanup = () => {
            unsubscribeFromCalls(state, handle);
            clearTimeout(timer);
        };
    });
}
```

`subscribeToCalls` adds a callback to a probe-internal "every recorded
call" hook. The hook fires inside `recordCall` after history mutation
and tier-1 dispatch. This avoids a third waiter type while letting
`atLeast`/`exactly` react to incoming calls.

`exactly` is similar but waits the full window before checking:

```typescript
function exactly<TCall, TPending>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    n: number,
    options: RequiredWithinOptions,
): Promise<ReadonlyArray<TCall>> {
    return new Promise((resolve, reject) => {
        globalThis.setTimeout(() => {
            queueMicrotask(() => {
                const matching = state.history
                    .filter((r) => matches(filter, r.call))
                    .map((r) => r.call);
                if (matching.length === n) {
                    resolve(matching);
                } else {
                    reject(new Error(
                        `Expected exactly ${n} calls matching ${filter.label} within ${options.within.milliseconds}ms, but received ${matching.length}.`,
                    ));
                }
            });
        }, options.within.milliseconds);
    });
}
```

### Pending call settlement

The pending object returned by `intercept` (and by `pendingFactory`)
exposes settlement methods that mutate the underlying record:

```typescript
function makePendingBase<TCall, TPending>(
    record: CallRecord<TCall, TPending>,
    label: string,
): PendingCallBase<TCall, unknown> {
    const settle = (action: () => void) => {
        if (record.settled) {
            throw new Error(`Pending call '${label}' is already settled.`);
        }
        record.settled = true;
        action();
    };

    return {
        get call() { return record.call; },
        get settled() { return record.settled; },
        answer(value: unknown) {
            settle(() => record.deferred.resolve(value));
        },
        answerWith(fn) {
            settle(() => {
                let result: unknown;
                try {
                    result = fn(record.call);
                } catch (err) {
                    record.deferred.reject(toError(err));
                    return;
                }
                if (isPromise(result)) {
                    result.then(
                        (v) => record.deferred.resolve(v),
                        (e) => record.deferred.reject(toError(e)),
                    );
                } else {
                    record.deferred.resolve(result);
                }
            });
        },
        reject(error: unknown) {
            settle(() => record.deferred.reject(toError(error)));
        },
    };
}
```

Domain `pendingFactory` implementations call `makePendingBase` and
then add their domain-specific accessors (`pending.method`,
`pending.args`, `pending.sql`, `pending.parameters`, `pending.command`,
etc.) on top.

Forwardable variants add a `forward()` method:

```typescript
function makeForwardablePending<TCall, TPending>(
    record: CallRecord<TCall, TPending>,
    label: string,
): ForwardablePendingCall<TCall, unknown> {
    const base = makePendingBase(record, label);
    return {
        ...base,
        forward() {
            if (record.settled) {
                throw new Error(`Pending call '${label}' is already settled.`);
            }
            if (!record.forwardFn) {
                throw new Error(
                    `Cannot forward: this probe has no backing.`,
                );
            }
            record.settled = true;
            record.forwardFn().then(
                (v) => record.deferred.resolve(v),
                (e) => record.deferred.reject(toError(e)),
            );
        },
    };
}
```

## Mock Adapter Implementation

The `@vnatures/test-kit-mock` package's `createProbedMock` uses
`createProbeRoot` to construct the probe, then wraps it in a Proxy.

```typescript
export function createProbedMock<T extends object, M extends readonly string[]>(
    options: CreateProbedMockOptions<T, M>,
): ProbedMock<T> {
    const root = createProbeRoot<MethodCall, MethodPendingCall>({
        harness: undefined,
        defaultTimeout: options.defaultTimeout,
        pendingFactory: (record) => {
            const base = makePendingBase(record, record.call.method);
            return {
                ...base,
                method: record.call.method,
                args: record.call.args,
            } as MethodPendingCall;
        },
        forwardable: false,
    });

    const methodSet = new Set<string>(options.methods as readonly string[]);

    const adapter = new Proxy({} as T, {
        get(_target, prop) {
            if (typeof prop !== 'string' || !methodSet.has(prop)) {
                return undefined;
            }
            return (...args: unknown[]) =>
                root.recordCall({ method: prop, args });
        },
    });

    return {
        adapter,
        probe: enrichWithMethodSugars(root.probe, methodSet),
        reset: () => {
            // clearCalls() per ProbedResource contract.
            // (Probe state object exposes a clearCalls method.)
            root.probe.clearCalls();
        },
        close: () => {
            root.dispose();
        },
    };
}

function enrichWithMethodSugars<T extends object>(
    probe: Probe<MethodCall, MethodPendingCall>,
    methodSet: Set<string>,
): MethodProbe<T> {
    return Object.assign(probe, {
        on<K extends AsyncMethodName<T>>(method: K) {
            if (!methodSet.has(method)) {
                // Defensive: caller declared method outside the
                // declared list. TS should prevent this; runtime
                // check guards against `as any` escape.
                throw new Error(
                    `Method '${method}' was not declared in createProbedMock methods.`,
                );
            }
            return probe.filter(
                (call): call is MethodCall<K> => call.method === method,
                `method === '${method}'`,
            );
        },
    }) as MethodProbe<T>;
}
```

The `CheckedMethods<T, M>` type machinery (see "Type Machinery" below)
ensures sync methods can't reach the runtime in the first place; the
runtime `methodSet.has(prop)` check is a sanity guard, not the primary
defense.

## SQL Adapter Implementation

### `SqlDriver` (final)

The driver interface in `@vnatures/test-kit-sql`:

```typescript
export interface SqlDriver {
    /**
     * Translate the ORM's internal query event into a normalized
     * QueryCall and route it through the probe. Returns the Promise
     * the ORM will hand back to the caller.
     *
     * Implementation pattern:
     *   onApplicationQuery(call) {
     *       return this.probeRoot.recordCall(call, () => this.realExecute(call));
     *   }
     */
    onApplicationQuery(call: QueryCall): Promise<unknown>;

    /**
     * Truncate all user tables on the maintenance connection,
     * bypassing the probe. Called by harness.reset() when the
     * adapter implements ProbedResource.reset().
     */
    reset(): Promise<void>;

    /**
     * Dispose the ORM connection pool and the underlying PGlite
     * instance.
     */
    close(): Promise<void>;
}
```

Note: `forward()` is NOT a separate method on the driver. Forwarding
happens via the `forwardFn` closure passed to `recordCall` (see the
implementation pattern comment above). The driver's `onApplicationQuery`
constructs the closure once per call and hands it to the probe; the
probe invokes it from its rule resolution machinery when a forward
rule fires (or when a `pending.forward()` is called).

### `@vnatures/test-kit-pglite-driver`

Internal package shared across pg-* packages. Exposes:

```typescript
export interface PgliteHandle {
    /** The PGlite instance; ORM packages connect through this. */
    readonly pglite: PGlite;

    /**
     * Maintenance connection that bypasses any per-ORM connection
     * pool. Used by seed and reset operations. Returns a raw query
     * executor.
     */
    readonly maintenance: {
        execute(sql: string, parameters?: unknown[]): Promise<unknown>;
    };

    /**
     * Truncate every user table (excluding system schemas). Used by
     * SqlDriver.reset() implementations.
     */
    truncateAllUserTables(): Promise<void>;

    /**
     * Dispose the PGlite instance and any pooled connections.
     */
    close(): Promise<void>;
}

export interface PgliteHandleOptions {
    /**
     * Bootstrap callback that runs against the maintenance connection
     * to set up schema. The pg-* packages adapt this from their typed
     * bootstrap signature.
     */
    readonly bootstrap: (maintenance: PgliteHandle['maintenance']) => Promise<void>;
}

export async function createPgliteHandle(
    options: PgliteHandleOptions,
): Promise<PgliteHandle>;
```

Each pg-* package wraps `createPgliteHandle` inside its factory, then
wires the ORM atop `handle.pglite` for the application path and atop
`handle.maintenance` for seed/reset.

### Per-ORM driver implementation pattern

Sketch for `pg-kysely`:

```typescript
export async function createProbedKyselyAdapter<DB>(
    options: CreateProbedKyselyAdapterOptions<DB>,
): Promise<ProbedKyselyAdapter<DB>> {
    const handle = await createPgliteHandle({
        bootstrap: async (maintenance) => {
            // Bridge: construct a Kysely instance over the
            // maintenance connection for the user's bootstrap
            // callback.
            const maintenanceKysely = createKyselyOverMaintenance(maintenance);
            await options.bootstrap(maintenanceKysely);
        },
    });

    let probeRoot: ProbeRoot<QueryCall, QueryPendingCall>;

    const driver: SqlDriver = {
        onApplicationQuery(call) {
            return probeRoot.recordCall(
                call,
                () => handle.maintenance.execute(call.sql, [...call.parameters]),
            );
        },
        reset: () => handle.truncateAllUserTables(),
        close: () => handle.close(),
    };

    // Wire Kysely's dialect to call driver.onApplicationQuery for
    // every query the application issues.
    const kysely = new Kysely<DB>({
        dialect: createProbedKyselyDialect(driver),
    });

    // Create the probe. Forward rule installed as the harness default.
    const sqlAdapter = createProbedSqlAdapter({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        driver,
    });
    probeRoot = sqlAdapter.probeRoot;

    return {
        adapter: kysely,
        probe: sqlAdapter.probe,
        seed: makeSeed(kysely, handle.maintenance),
        reset: () => driver.reset(),
        close: () => driver.close(),
    };
}
```

`createProbedSqlAdapter` (in `@vnatures/test-kit-sql`) wraps `createProbeRoot`
to install the default `always().forward()` rule and return the wired
probe + the `ProbeRoot` reference for the driver to use:

```typescript
export interface ProbedSqlAdapter {
    readonly probe: QueryProbe;
    readonly probeRoot: ProbeRoot<QueryCall, QueryPendingCall>;
}

export function createProbedSqlAdapter(options: {
    readonly harness: Harness;
    readonly defaultTimeout?: Duration;
    readonly driver: SqlDriver;
}): ProbedSqlAdapter {
    const root = createProbeRoot<QueryCall, QueryPendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain,
            },
        ],
        pendingFactory: (record) => {
            const base = makeForwardablePending(record, summarizeSql(record.call.sql));
            return {
                ...base,
                sql: record.call.sql,
                parameters: record.call.parameters,
            } as QueryPendingCall;
        },
    });

    const probe = enrichWithSqlSugar(root.probe);
    return { probe, probeRoot: root };
}
```

`pg-knex` and `pg-sequelize` follow the same pattern, differing only
in the ORM-specific dialect/driver wiring and the typed bootstrap/seed
signatures.

## Cache, S3, Presigner Implementations

### `@vnatures/test-kit-redis`

Single-package, single-backing. Pattern:

```typescript
export function createProbedCacheAdapter(
    options: CreateProbedCacheAdapterOptions,
): ProbedCacheAdapter {
    const redis = new IoRedisMock();
    const root = createProbeRoot<CacheCall, CachePendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        defaultRules: [
            { action: { kind: 'forward' }, filter: emptyFilterChain },
        ],
        pendingFactory: (record) => {
            const base = makeForwardablePending(record, record.call.method);
            return {
                ...base,
                method: record.call.method,
                args: record.call.args,
            } as CachePendingCall;
        },
    });

    const adapter: CacheAdapter = {
        get: (key) => root.recordCall(
            { method: 'get', args: [key] },
            () => redis.get(serializeKey(key)),
        ),
        set: (input, ttl) => root.recordCall(
            { method: 'set', args: [input, ttl] },
            () => redis.set(/* ... */),
        ),
        // ... del, setnx, getSet
    };

    return {
        adapter,
        probe: enrichWithCacheSugar(root.probe),
        reset: async () => {
            await redis.flushall();
        },
        close: async () => {
            await redis.quit();
            root.dispose();
        },
    };
}
```

### `@vnatures/test-kit-s3`

S3Client adapter wraps `mock-aws-s3`. The S3 client's `send(command)`
method is intercepted: each command's class name and input are
captured into an `S3Call`, then routed through `root.recordCall`.

```typescript
export function createProbedS3Adapter(
    options: CreateProbedS3AdapterOptions,
): ProbedS3Adapter {
    const localDir = options.localDirectory ?? mkdtempSync('test-kit-s3-');
    const backing = createMockS3Backing(localDir, options.bucket);

    const root = createProbeRoot<S3Call, S3PendingCall>({
        // ... similar to cache
        forwardable: true,
        defaultRules: [
            { action: { kind: 'forward' }, filter: emptyFilterChain },
        ],
        pendingFactory: makeS3Pending,
    });

    const client: S3Client = {
        send: (command: S3Command) => {
            const call: S3Call = {
                commandName: command.constructor.name,
                command,
                input: (command as any).input,
            };
            return root.recordCall(call, () => backing.execute(command));
        },
        // ... other S3Client methods that delegate to send
    } as unknown as S3Client;

    return {
        adapter: client,
        probe: enrichWithS3Sugar(root.probe),
        bucket: options.bucket,
        localDirectory: localDir,
        reset: () => backing.empty(),
        close: async () => {
            if (!options.localDirectory) {
                rmSync(localDir, { recursive: true, force: true });
            }
            root.dispose();
        },
    };
}
```

The presigner adapter is similar but with no backing and no default
rule. Forward rules and `pending.forward()` are unavailable (the type
system enforces this; runtime throws if reached via `as any`).

## Harness Implementation

### `attach`

Single implementation, two type signatures:

```typescript
export function createHarness(options?: CreateHarnessOptions): Harness {
    const state = {
        clock: options?.clock ?? autoDetectClock(),
        defaultTimeout: options?.defaultTimeout ?? seconds(5),
        safetyTimeout: options?.safetyTimeout ?? seconds(30),
        registered: [] as ProbedAdapter<any, any>[],
        closed: false,
    };

    const harness: Harness = {
        get clock() { return state.clock; },
        get defaultTimeout() { return state.defaultTimeout; },
        expect: makeHarnessExpectations(state),
        attach(adapter: any): any {
            if (state.closed) {
                throw new Error('Harness is closed.');
            }
            if (isPromise(adapter)) {
                return adapter.then((a: ProbedAdapter<any, any>) =>
                    harness.attach(a),
                );
            }
            state.registered.push(adapter);
            return adapter;
        },
        async reset(opts?: { keepRules?: boolean }) {
            if (state.closed) throw new Error('Harness is closed.');
            for (const adapter of state.registered) {
                if ('reset' in adapter && typeof adapter.reset === 'function') {
                    await adapter.reset();
                }
                if (!opts?.keepRules && 'probe' in adapter) {
                    adapter.probe.resetProbe();
                }
            }
        },
        async close() {
            if (state.closed) return;
            state.closed = true;
            // Reverse-registration order.
            for (let i = state.registered.length - 1; i >= 0; i--) {
                const adapter = state.registered[i];
                if ('close' in adapter && typeof adapter.close === 'function') {
                    try {
                        await adapter.close();
                    } catch (e) {
                        // Don't let one adapter's close failure
                        // block others.
                        console.error('Adapter close failed:', e);
                    }
                }
            }
            // ProbeRoot.dispose() called by adapter.close() handles
            // waiter cancellation per probe.
        },
    };

    return harness;
}
```

### Safety timeout

Each waiter (capturing or observing) is registered with two timers:

1. The user-specified `within` timer (or `defaultTimeout`). Fires the
   "Timed out after Nms waiting for ..." error.
2. The harness safety timer. Fires the "Test exceeded the harness
   safety timeout (30000ms wall-clock) ..." error if the per-call
   `within` timer hasn't fired first.

Both are real wall-clock timers via `globalThis.setTimeout`. The
`within` timer almost always fires first; the safety timer is the
last-resort failsafe for tests that omit `within` and rely on
`defaultTimeout` longer than safety.

Implementation: when registering a waiter, install both timers; when
the waiter resolves or one timer fires, clear the other.

### `harness.expect.sequence` and `allOf`

Both helpers register on multiple probes simultaneously and coordinate
their resolution.

`sequence([s0, s1, s2], { within })`:

```typescript
async function sequence(steps, options) {
    const results: unknown[] = new Array(steps.length);
    let nextIdx = 0;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const remaining = options.within.milliseconds - elapsedSinceStart();
        if (remaining <= 0) {
            throw new Error(timeoutMessage(steps, i, /* satisfied */ i));
        }

        const opt = { within: ms(remaining) };
        const result = isObservation(step)
            ? await step.selection.expect.observe(opt)
            : await step.expect.intercept(opt);
        results[i] = result;
    }

    return results as SequenceResult<typeof steps>;
}
```

This is sequential: step 0 must complete before step 1 begins. If a
step times out, the error message names which step was unmet.

`allOf` is the same shape but parallel:

```typescript
async function allOf(steps, options) {
    return Promise.all(
        steps.map((step) =>
            isObservation(step)
                ? step.selection.expect.observe(options)
                : step.expect.intercept(options),
        ),
    );
}
```

If any step rejects (timeout), `Promise.all` rejects. We wrap to
produce a unified diagnostic naming all unsatisfied steps:

```typescript
async function allOf(steps, options) {
    const results = await Promise.allSettled(steps.map(/* ... */));
    const unsatisfied = results
        .map((r, i) => ({ r, i, label: stepLabel(steps[i]) }))
        .filter(({ r }) => r.status === 'rejected');
    if (unsatisfied.length > 0) {
        throw new Error(
            `allOf expectation timed out after ${options.within.milliseconds}ms. ${steps.length - unsatisfied.length}/${steps.length} steps satisfied. Unsatisfied: [${unsatisfied.map((u) => u.label).join(', ')}].`,
        );
    }
    return results.map((r: any) => r.value) as SequenceResult<typeof steps>;
}
```

## Clock Implementations

```typescript
export function realClock(): Clock {
    return {
        now: () => Date.now(),
        async advance() {
            throw new Error(
                'realClock cannot advance time. Configure the harness with a fake clock to use clock.advance().',
            );
        },
    };
}

export function jestFakeClock(): Clock {
    return {
        now: () => Date.now(),
        async advance(d) {
            const jest = (globalThis as any).jest;
            if (!jest || typeof jest.advanceTimersByTime !== 'function') {
                throw new Error(
                    'jestFakeClock requires jest.useFakeTimers() to be active before clock.advance() is called.',
                );
            }
            jest.advanceTimersByTime(d.milliseconds);
            // Allow microtasks queued by the fake timers to drain.
            await Promise.resolve();
        },
    };
}

export function viFakeClock(): Clock {
    return {
        now: () => Date.now(),
        async advance(d) {
            const vi = (globalThis as any).vi;
            if (!vi || typeof vi.advanceTimersByTime !== 'function') {
                throw new Error(
                    'viFakeClock requires vi.useFakeTimers() to be active before clock.advance() is called.',
                );
            }
            await vi.advanceTimersByTimeAsync(d.milliseconds);
        },
    };
}

export function sinonFakeClock(timers: SinonFakeTimers): Clock {
    return {
        now: () => timers.now,
        async advance(d) {
            await timers.tickAsync(d.milliseconds);
        },
    };
}

export function manualClock(): Clock & { tickAll(): Promise<void> } {
    let now = 0;
    const scheduled: Array<{ at: number; fn: () => void }> = [];
    return {
        now: () => now,
        async advance(d) {
            now += d.milliseconds;
            await tickPending(now, scheduled);
        },
        async tickAll() {
            await tickPending(Infinity, scheduled);
        },
    };
}

function autoDetectClock(): Clock {
    const vi = (globalThis as any).vi;
    if (vi?.isFakeTimers?.() === true) return viFakeClock();
    const jest = (globalThis as any).jest;
    if (jest?.getTimerCount && typeof jest.advanceTimersByTime === 'function') {
        // Heuristic: jest exposes timer functions when fake timers are
        // installed. There's no clean isFakeTimers() check.
        return jestFakeClock();
    }
    return realClock();
}
```

## Error Handling

All errors are plain `Error` (or `RangeError` for invalid `Duration`
values). No custom error class hierarchy. Reasons:

- The error messages are designed as public UX. Tests usually pattern-
  match on message substrings (e.g., `expect(err.message).toContain('Timed out')`),
  not on instance type.
- A custom hierarchy adds API surface (every consumer must import
  `TimeoutError`, `SettlementError`, etc. to do `instanceof` checks)
  for marginal benefit.
- Optional Jest/Vitest matcher integrations (post-v1) can wrap these
  errors in matcher-friendly types if needed.

Error message templates live in `@vnatures/test-kit/errors.ts` as plain
functions:

```typescript
export const errors = {
    timeout: (label: string, ms: number) =>
        new Error(`Timed out after ${ms}ms waiting for next call matching ${label}.`),
    none: (label: string, ms: number, n: number) =>
        new Error(`Expected no calls matching ${label} within ${ms}ms, but received ${n}.`),
    exactly: (label: string, n: number, ms: number, actual: number) =>
        new Error(`Expected exactly ${n} calls matching ${label} within ${ms}ms, but received ${actual}.`),
    doubleSettle: (label: string) =>
        new Error(`Pending call '${label}' is already settled.`),
    unsupportedForward: (domain: string, name: string) =>
        new Error(`Cannot forward ${domain} call '${name}': no local backing implementation supports it. Use .answer(...) or .reject(...).`),
    realClockAdvance: () =>
        new Error('realClock cannot advance time. Configure the harness with a fake clock to use clock.advance().'),
    jestFakeNotActive: () =>
        new Error('jestFakeClock requires jest.useFakeTimers() to be active before clock.advance() is called.'),
    safetyTimeout: (ms: number) =>
        new Error(`Test exceeded the harness safety timeout (${ms}ms wall-clock). This usually means the test is hung; check for missing settlements or unmet expectations.`),
    harnessClosed: () =>
        new Error('Harness is closed.'),
    closeWithUnsettledWaiters: (n: number) =>
        new Error(`Harness closed with ${n} unsettled waiter(s).`),
    sequenceOrder: (i: number, iLabel: string, j: number, jLabel: string) =>
        new Error(`Sequence expectation failed: step ${i} (${iLabel}) matched before step ${j} (${jLabel}) was satisfied.`),
    sequenceTimeout: (totalMs: number, satisfied: number, total: number, label: string) =>
        new Error(`Sequence expectation timed out after ${totalMs}ms. Steps satisfied: ${satisfied}/${total}. First unsatisfied step: ${label}.`),
    allOfTimeout: (totalMs: number, satisfied: number, total: number, labels: string[]) =>
        new Error(`allOf expectation timed out after ${totalMs}ms. ${satisfied}/${total} steps satisfied. Unsatisfied: [${labels.join(', ')}].`),
};
```

Domain packages import from this central registry. They do not hand-
write error strings.

## Type Machinery

### `CheckedMethods<T, M>`

```typescript
export type AsyncMethodName<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => Promise<unknown>
        ? Extract<K, string>
        : never;
}[keyof T];

export type CheckedMethods<T, M extends ReadonlyArray<string>> =
    Exclude<M[number], AsyncMethodName<T>> extends never
        ? M
        : ReadonlyArray<AsyncMethodName<T>> & {
              readonly __test_kit_error: 'createProbedMock requires methods that return Promise<...>';
              readonly __sync_methods_cannot_be_probed: Exclude<M[number], AsyncMethodName<T>>;
              readonly __how_to_fix:
                  "For sync dependencies, use the real implementation in tests. See 'Synchronous Dependencies: Use The Real Thing' in the docs.";
          };

export function createProbedMock<
    T extends object,
    const M extends readonly string[] = readonly AsyncMethodName<T>[],
>(options: { methods: CheckedMethods<T, M>; defaultTimeout?: Duration }): ProbedMock<T>;
```

Validation cases the TS POC must cover:

1. All methods async, all listed → compiles; user gets typed `MethodProbe<T>`.
2. Some sync method listed → compile error names the sync method.
3. Method name not on T → compile error (string literal not in `AsyncMethodName<T>`).
4. Empty `methods: []` → compiles; no methods are intercepted (legal but useless).
5. `methods` typed as `string[]` (not `as const`) → compile error or
   degraded narrowing. Decide whether to require `const` in factory
   signature or recommend it in docs.

### `NarrowPending<TPending, TNarrow>`

```typescript
export type NarrowPending<TPending, TNarrow> =
    TPending extends PendingCallBase<infer TCall, infer TResult>
        ? TNarrow extends TCall
            ? PendingCallBase<TNarrow, TResult>
            : never
        : never;
```

Used by `selection.filter<TNarrow>(typeGuard)` to narrow the pending
type along with the call type.

### `SequenceResult<S>`

```typescript
export type SequenceResult<S extends ReadonlyArray<Selection<any, any> | Observation<any>>> = {
    [K in keyof S]:
        S[K] extends Selection<any, infer P> ? P :
        S[K] extends Observation<infer T> ? T :
        never;
};
```

Validation cases:

1. All-Selection input → tuple of pending types.
2. All-Observation input → tuple of TCall types.
3. Mixed → tuple of mixed types in input order.

### TS POC scope

A standalone TS file (`packages/core/test/types/poc.ts`) that:

- Defines a few sample interfaces (one all-async, one mixed, one with
  generics).
- Calls `createProbedMock` with each, asserting type narrowing on the
  returned probe.
- Constructs filter chains and asserts narrow types propagate.
- Builds `harness.expect.sequence` with mixed Selection/Observation
  steps and asserts the result tuple is correctly typed.
- Includes intentional negative tests (sync method in list, wrong
  method name, etc.) commented out with `// @ts-expect-error`
  directives so the POC compiles cleanly while documenting the
  expected failures.

The POC compiles as part of `npm run typecheck` in `packages/core`.

## Testing Strategy

### Test runner

Vitest, sharing the Vite installation used for builds. One tool, one
config language.

Configuration:

- ESM-first; no transpilation overhead.
- Fake timers via `@sinonjs/fake-timers` (Vitest's built-in, exposed
  through `vi.useFakeTimers({ toFake: [...] })`).
- Vitest workspaces (or `vitest --project`) for cross-package test runs.
- Coverage via v8 (Vitest default).

Per-package `vitest.config.ts` (often unnecessary — the package's
`vite.config.ts` doubles as Vitest config because Vitest reads the
same `defineConfig`):

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    typecheck: {
      enabled: true,
      include: ['test/types/**/*.ts'],
    },
  },
});
```

Vitest's `typecheck` mode runs the `expect-type` tests as part of the
test suite, so type-level regressions fail CI alongside runtime
regressions. The test/types/ folder doesn't need a separate runner.

### Layered tests per package

Each package ships:

- **`test/unit/`** — narrow unit tests on internal modules. Mostly
  for `core` and `pglite-driver`; smaller packages get fewer.
- **`test/integration/`** — end-to-end tests that exercise the
  package's public API against a realistic SUT. For domain packages,
  these double as worked examples in the docs.
- **`test/types/`** — type-level tests using `expect-type` (chosen
  over `tsd` because it integrates with Vitest natively). The TS POC
  lives here for `core`.

### Cross-package integration tests

A separate `examples/` directory at the repo root hosts worked
examples that span multiple packages. The mandated `examples/grpc-client/`
entry (the extender's-guide example) lives here, as does any future
"realistic SUT" demonstration.

The `examples/` directory's tests run as part of CI but are not
shipped as a published package.

### Type-level test infrastructure

`expect-type` provides assertions like:

```typescript
import { expectTypeOf } from 'expect-type';

expectTypeOf<MethodProbe<UserService>>().toMatchTypeOf<Probe<MethodCall, MethodPendingCall>>();

// Negative: intentional compile error
// @ts-expect-error -- canParse is sync, not allowed in methods
createProbedMock<Validator>({ methods: ['canParse', 'parse'] });
```

The `// @ts-expect-error` directive both documents the expected
failure and ensures the test fails if TypeScript stops reporting the
error (e.g., if `CheckedMethods` regresses).

## Build & Distribution

### Bundling: Vite library mode + `vite-plugin-dts`

Each package gets a `vite.config.ts` and a `package.json`. Vite handles
ESM+CJS dual output via its library mode (which delegates to Rollup for
production builds); `vite-plugin-dts` generates the `.d.ts` files. Same
config language as the Vitest test runs.

`vite.config.ts` (per package, ~25 lines):

```typescript
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (fmt) => `index.${fmt === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      // Mark workspace siblings, peer deps, and node built-ins as external.
      external: [
        /^@test-kit\//,
        /^node:/,
        // Per-package additions (e.g., 'kysely', 'knex', '@aws-sdk/...').
      ],
    },
    sourcemap: true,
    minify: false,        // libraries should not minify; consumer's bundler does.
    target: 'node20',     // matches engines.node in package.json.
  },
  plugins: [
    dts({
      rollupTypes: true,  // Bundle .d.ts into a single file per entry.
      tsconfigPath: './tsconfig.json',
    }),
  ],
});
```

`package.json` (per package):

```json
{
  "name": "@vnatures/test-kit",
  "version": "2.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  }
}
```

Notes:

- Vite library mode delegates production builds to Rollup, which produces
  smaller output and better tree-shaking than esbuild's bundler. This is
  the right choice for libraries even though Vite uses esbuild during dev.
- `vite-plugin-dts` with `rollupTypes: true` produces one bundled
  `.d.ts` per entry. Cleaner than per-source-file `.d.ts` and simpler
  for consumers.
- `external` declarations are explicit: workspace siblings (matched by
  the `^@vnatures/test-kit` regex), `node:` built-ins, and any peer
  dependencies. Anything not externalized gets bundled into the output.
  Each package adds its own peer/dep externals (e.g., `'kysely'`,
  `'knex'`, `'@aws-sdk/client-s3'`).
- `target: 'node20'` matches the `engines.node: ">=20"` declaration. No
  legacy-Node downleveling.
- `minify: false` — libraries should not minify. The consumer's bundler
  decides minification policy.

The same Vite installation is used for tests via Vitest (which is built
on Vite). One node_modules entry point handles both.

### TypeScript project references

Root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/mock" },
    { "path": "./packages/sql" },
    { "path": "./packages/pglite-driver" },
    { "path": "./packages/pg-kysely" },
    { "path": "./packages/pg-knex" },
    { "path": "./packages/pg-sequelize" },
    { "path": "./packages/redis" },
    { "path": "./packages/s3" }
  ]
}
```

Each package's `tsconfig.json` extends the base and declares its
references explicitly. This enables fast `tsc --build --watch` across
the monorepo.

### Workspace `package.json`

Root scripts:

```json
{
  "private": true,
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "build": "tsc --build && npm run build --workspaces --if-present",
    "typecheck": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint packages",
    "format": "prettier --write \"packages/**/*.ts\"",
    "clean": "tsc --build --clean && rimraf packages/*/dist"
  },
  "devDependencies": {
    "vite": "^5.x",
    "vite-plugin-dts": "^4.x",
    "vitest": "^2.x",
    "expect-type": "^1.x",
    "@sinonjs/fake-timers": "^11.x",
    "typescript": "^5.x",
    "eslint": "^9.x",
    "prettier": "^3.x",
    "rimraf": "^5.x"
  }
}
```

`tsc --build` runs first to validate the TypeScript project graph
(catches cross-package type errors fast, without bundling). Then each
package's `vite build` produces the actual `dist/` output. The two
passes are complementary: `tsc` for type-check, Vite for emit.

Hoisting Vite, Vitest, and the TS toolchain to the workspace root
keeps each package's `package.json` small (just the package's
production deps and peer deps). Per-package `package.json` lists no
`devDependencies` for tooling that's already at the root.

## Implementation Order

A suggested sequence that lets each layer be tested before the next is
built on top:

1. **`@vnatures/test-kit` foundations**: `Duration`, `Clock` (all 5
   variants), `Harness` skeleton without `attach`/`reset`/`close`
   wiring.
2. **`createProbeRoot` + storage model**: implement the full state
   struct, `recordCall`, the four-tier rule resolution engine,
   `applyRule`, retroactive intercept logic.
3. **Selection / RuleBuilder / Expectations**: the public API layer
   on top of the engine. `intercept`, `observe`, `none`, `atLeast`,
   `exactly`, `calledTimes`, `neverCalled`, `called`. `filter` chain
   composition.
4. **Harness wire-up**: `attach` (sync + Promise), `reset`,
   `close`, safety timeout, `harness.expect.sequence`/`allOf`.
5. **TS POC**: validate the type machinery before building domain
   packages on top.
6. **`@vnatures/test-kit-mock`**: simplest domain package; validates the
   `createProbeRoot` contract end-to-end without backings.
7. **`@vnatures/test-kit-redis`**: introduces a backing, default forward
   rule, lifecycle (`reset`/`close` plumbing).
8. **`@vnatures/test-kit-s3`**: introduces hybrid behavior (some commands
   forward, others fail loudly), command-class extraction.
9. **`@vnatures/test-kit-pglite-driver`**: shared PGlite helper.
10. **`@vnatures/test-kit-sql` + `@vnatures/test-kit-pg-kysely`**: first SQL adapter,
    establishes the `SqlDriver` pattern.
11. **`@vnatures/test-kit-pg-knex`, `@vnatures/test-kit-pg-sequelize`**: copy the
    Kysely pattern with ORM-specific driver implementations.
12. **`examples/grpc-client/`**: worked extender example. Compiles
    and tests in CI as a smoke test for the extender contract.
13. **Documentation polish**: ensure every `v2-*.md` example actually
    compiles against the real implementation. Move any working
    examples into `examples/` if not already there.

Each step is independently testable. Steps 1-4 form the core engine
and can ship as `@vnatures/test-kit` v2.0.0-alpha.1 to validate the API
shape with internal users before the domain packages stabilize.

## Performance Considerations

The probe engine runs on the test path, not the production path.
Performance constraints are correspondingly loose:

- **Filter chain evaluation** is O(predicates × matching rules) per
  incoming call. With typical test setups (3-10 rules, 1-3 predicates
  each), this is sub-millisecond.
- **History scan** (for retroactive intercept) is O(history). With
  typical test lengths (10s-100s of calls), sub-millisecond.
- **`atLeast`/`exactly` history scans** on every new call: O(history)
  per call per active waiter. Avoid registering many concurrent
  `atLeast` waiters on the same probe.

Optimization is not a v1 priority. If profiling later shows hot
paths, the candidates are: memoizing filter chain results within a
single `recordCall`, precomputing per-method indices in `MethodProbe`
to skip non-matching rules, switching one-shot queue from array-with-
splice to linked list.

## Concurrency and Single-Threadedness

JavaScript's single-threaded execution simplifies the design:

- No locks needed. Every probe operation runs to completion before
  the next operation begins.
- "Concurrent" `recordCall`s from the SUT are actually sequential at
  the rule resolution level; only their resulting Promises run
  concurrently.
- `expect.intercept` / `expect.observe` race-free: the order they
  observe calls is the order calls arrive at `recordCall`.

The one subtle case: `answerWith(asyncFn)` runs `asyncFn` before
returning; if `asyncFn` itself triggers more SUT activity that
generates probe calls, those calls are recorded in their natural
arrival order, and the original deferred is settled when `asyncFn`'s
Promise settles. No deadlock potential because no probe operation
blocks the event loop.

## Out Of Scope For Tech Design

These are deferred to implementation choice (where the engineer can
make the call with code in front of them):

- Exact memory layout of probe state (struct vs. class vs. closure).
- Whether `FilterChain` is a class or a plain object.
- Whether `subscribeToCalls` (used by `atLeast`/`exactly`) reuses the
  observer mechanism or is a separate notification list.
- Specific Vite library mode configuration tuning beyond the sketch
  above (e.g., chunking strategy if the package grows large enough to
  warrant code splitting; sourcemap variant choice;
  `vite-plugin-dts` advanced options).
- Whether the `examples/grpc-client/` uses a real gRPC library or a
  mock to demonstrate the pattern.
- Logging / debug-output strategy (e.g., a `harness.debug()` mode that
  logs every rule resolution decision).
