/**
 * Type-level tests for CheckedMethods<T, M>.
 *
 * Per docs/api-surface.md §"Mock Adapter API":
 *   The branded error type fires when M contains any sync method name from T,
 *   producing a TypeScript diagnostic that names the offending method and
 *   prescribes the fix (use the real implementation in tests).
 *
 * Run via Vitest typecheck mode:
 *   vitest run --typecheck (configured per package's vite.config.ts)
 */
import { expectTypeOf } from 'expect-type';
import {
    createProbedMock,
    type AsyncMethodName,
    type CheckedMethods,
    type MethodProbe,
    type ProbedMock,
} from '@hochgi/test-kit-mock';

interface AllAsync {
    getUser(id: number): Promise<{ id: number }>;
    updateUser(id: number, patch: object): Promise<void>;
}

interface MixedAsyncSync {
    isEnabled(flag: string): boolean; // sync — should be real
    refresh(): Promise<void>; // async — leaf boundary
}

interface NoAsync {
    computeFoo(): number;
    computeBar(): boolean;
}

// ── Positive cases — should compile ────────────────────────────────────────

const valid = createProbedMock<AllAsync>({
    methods: ['getUser', 'updateUser'],
});

expectTypeOf(valid).toMatchTypeOf<ProbedMock<AllAsync>>();
expectTypeOf(valid.adapter).toMatchTypeOf<AllAsync>();
expectTypeOf(valid.probe).toMatchTypeOf<MethodProbe<AllAsync>>();

const onlyOne = createProbedMock<MixedAsyncSync>({
    methods: ['refresh'], // omit the sync method — compiles fine
});
expectTypeOf(onlyOne.adapter).toMatchTypeOf<MixedAsyncSync>();

// AsyncMethodName<T> filters out sync methods.
expectTypeOf<AsyncMethodName<AllAsync>>().toEqualTypeOf<'getUser' | 'updateUser'>();
expectTypeOf<AsyncMethodName<MixedAsyncSync>>().toEqualTypeOf<'refresh'>();
expectTypeOf<AsyncMethodName<NoAsync>>().toEqualTypeOf<never>();

// ── Negative cases — must produce a TS diagnostic ──────────────────────────

// @ts-expect-error -- isEnabled is sync; CheckedMethods rejects with the branded error type.
createProbedMock<MixedAsyncSync>({ methods: ['isEnabled', 'refresh'] });

// @ts-expect-error -- 'computeFoo' is sync; rejected.
createProbedMock<NoAsync>({ methods: ['computeFoo'] });

// @ts-expect-error -- 'nonexistent' is not a method on AllAsync.
createProbedMock<AllAsync>({ methods: ['nonexistent'] });

// CheckedMethods<T, M> resolves to M when M is all-async, or to a branded error
// type otherwise. We can verify the branded type structure directly.
type ValidMethods = ['getUser', 'updateUser'];
expectTypeOf<CheckedMethods<AllAsync, ValidMethods>>().toEqualTypeOf<ValidMethods>();

// When the methods list contains a sync method, the error type's discriminator
// names the offending method explicitly.
type InvalidMethods = ['isEnabled', 'refresh'];
type InvalidResult = CheckedMethods<MixedAsyncSync, InvalidMethods>;
expectTypeOf<InvalidResult>().not.toEqualTypeOf<InvalidMethods>();

// The branded error type carries the diagnostic strings as readonly properties.
type ErrorBrand = {
    readonly __test_kit_error: 'createProbedMock requires methods that return Promise<...>';
    readonly __sync_methods_cannot_be_probed: 'isEnabled';
    readonly __how_to_fix: "For sync dependencies, use the real implementation in tests. See 'Synchronous Dependencies: Use The Real Thing' in the docs.";
};
expectTypeOf<InvalidResult>().toMatchTypeOf<Partial<ErrorBrand>>();
