// Public API of @vnatures/test-kit core.

// ── Duration ────────────────────────────────────────────────────────────────
export type { Duration } from './duration.js';
export { milliseconds, seconds, minutes } from './duration.js';

// ── Clock ───────────────────────────────────────────────────────────────────
export type { Clock, ManualClock, SinonFakeTimers } from './clock.js';
export { realClock, jestFakeClock, viFakeClock, sinonFakeClock, manualClock, autoDetectClock } from './clock.js';

// ── Errors (exported for diagnostics) ──────────────────────────────────────
export { errors, toError } from './errors.js';

// ── Public types ────────────────────────────────────────────────────────────
export type {
    CallMatcher,
    CallTypeGuard,
    ExpectOptions,
    RequiredWithinOptions,
    PendingCallBase,
    ForwardablePendingCall,
    PendingAnswer,
    NarrowPending,
    RuleBuilder,
    ForwardableRuleBuilder,
    Expectations,
    Selection,
    ForwardableSelection,
    Probe,
    ForwardableProbe,
    ProbeAdmin,
    ProbedAdapter,
    ProbedResource,
    ProbedAdapterWithLifecycle,
    // Internal types exposed for domain-package consumption:
    FilterChain,
    Deferred,
    CallRecord,
    RuleAction,
    RuleEntry,
    WaiterEntry,
    ObserverEntry,
    CallNotifier,
    HarnessRef,
    ProbeRootConfig,
    ProbeRoot,
} from './types.js';

export { emptyFilterChain } from './types.js';

// ── Probe engine ────────────────────────────────────────────────────────────
export { createProbeRoot, createDeferred, makePendingBase, makeForwardablePending } from './probe-engine.js';

// ── Stream probe engine (async-generator-shaped boundaries) ────────────────
export type {
    StreamPendingCallBase,
    StreamRuleBuilder,
    StreamExpectations,
    StreamSelection,
    StreamChunkOf,
    StreamProbe,
    // Internal types exposed for domain-package consumption:
    StreamRecord,
    StreamRuleAction,
    StreamRuleEntry,
    StreamWaiterEntry,
    StreamObserverEntry,
    StreamCallNotifier,
    StreamChannel,
    StreamProbeRootConfig,
    StreamProbeRoot,
} from './stream-types.js';
export { createStreamProbeRoot, createChannel, makeStreamPendingBase } from './stream-probe-engine.js';

// ── Harness (skeleton; full implementation in step 4) ──────────────────────
export type { Harness, CreateHarnessOptions, HarnessExpectations, Observation, SequenceResult } from './harness.js';
export { createHarness, observation } from './harness.js';
