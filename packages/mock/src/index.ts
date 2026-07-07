// Public API of @vnatures/test-kit-mock.
export type {
    AsyncMethodName,
    CheckedMethods,
    MethodArgs,
    MethodCall,
    MethodName,
    MethodPendingCall,
    MethodProbe,
    MethodResolvedReturn,
    MethodSelection,
    ProbedMock,
    SyncMethodName,
} from './types.js';

export { createProbedMock } from './factory.js';
export type { CreateProbedMockOptions } from './factory.js';

// ── Stream mocks (async-generator-shaped boundaries) ────────────────────────
export type {
    CheckedStreamMethods,
    ProbedStreamMock,
    StreamMethodArgs,
    StreamMethodCall,
    StreamMethodChunk,
    StreamMethodName,
    StreamMethodPendingCall,
    StreamMethodProbe,
    StreamMethodSelection,
} from './stream-types.js';

export { createProbedStreamMock } from './stream-factory.js';
export type { CreateProbedStreamMockOptions } from './stream-factory.js';
