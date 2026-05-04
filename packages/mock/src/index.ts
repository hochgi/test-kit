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
