# @vnatures/test-kit-mock

Programmable mock adapters for any TypeScript interface, built on top of
[`@vnatures/test-kit`](../core/README.md). Use this when the boundary is a
plain TypeScript interface — REST/gRPC clients, internal service
interfaces, factory abstractions.

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-mock
```

## Quick start

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedMock } from "@vnatures/test-kit-mock";

interface UserService {
    getUser(id: number): Promise<{ id: number; name: string }>;
    create(input: { name: string }): Promise<{ id: number }>;
}

const rig = createRig();
const users = rig.attach(
    createProbedMock<UserService>({
        harness: rig,
        methods: ["getUser", "create"],
    }),
);

// Porcelain — pre-program a default
users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });

await users.adapter.getUser(1);
// → { id: 1, name: "Alice" }

// Plumbing — capture the next call and answer it manually
const promise = users.adapter.create({ name: "Bob" });
const call = await users.probe.on("create").expect.intercept();
expect(call.args[0]).toEqual({ name: "Bob" });
call.answer({ id: 42 });
await promise; // → { id: 42 }
```

## What `createProbedMock` returns

```typescript
const { adapter, probe, close } = createProbedMock<T>({
    harness: rig,        // optional; recommended for shared lifecycle
    methods: [...],      // explicit allowlist of async method names
    defaultTimeout,      // optional override
});
```

- `adapter: T` — Proxy-based fake. Calling a listed method returns a
  Promise that the probe resolves. Accessing any non-listed property
  returns `undefined` (this is what makes the adapter safe to drop into
  NestJS providers, `JSON.stringify`, etc.).
- `probe: MethodProbe<T>` — test-facing handle. Supports `.on(method)`,
  `.filter(predicate)`, `.calls`, `.expect.*`, `.drain()`,
  `.drainAndReject(error)`.
- `close()` — disposes the underlying probe; runs automatically on
  `rig.close()` if attached.

## The `methods` allowlist

`methods` is mandatory and the type system enforces that every entry is
a Promise-returning method on `T`:

```typescript
interface T { foo(): Promise<void>; bar(): string }

createProbedMock<T>({ methods: ["bar"] });
//                              ^^^^^ TS2322 with a branded message:
//                                    "createProbedMock requires methods that
//                                     return Promise<...>"
```

The allowlist closes a category of bugs that open Proxy-based mocks
suffer from: framework probes (NestJS lifecycle hooks, Promise interop,
JSON serialization) cannot accidentally route through the probe and
hang. If a property is not in `methods`, it is simply not on the
adapter.

For sync dependencies, do not probe — use the real implementation.

## The rule grammar

`probe.on("method")` returns a `MethodSelection`. From there:

```typescript
// One-shot rules — consumed after one matching call:
probe.on("create").once().answer(value);
probe.on("create").once().answerWith((c) => derive(c.args));
probe.on("create").once().reject(error);

// Permanent rules — repeat indefinitely (lower priority than one-shots):
probe.on("getUser").always().answer(value);
probe.on("getUser").always().answerWith((c) => …);
probe.on("getUser").always().reject(error);
```

Multiple one-shot rules queue FIFO; multiple permanent rules apply LIFO.
A one-shot rule always wins over a permanent one (rule resolution is
documented in [`docs/api-surface.md`](../../docs/api-surface.md)).

## Plumbing assertions

```typescript
// Block until the next call to `create` arrives. Captures the call
// (rules don't get to fire), so the test must answer/reject it.
const call = await probe.on("create").expect.intercept();

// Notify-only — observes the call without consuming it. Useful when a
// rule has already programmed an answer and the test only wants to
// inspect arguments.
const observed = await probe.on("create").expect.observe();

// Negative assertion — fail if any matching call arrives in the window.
await probe.on("delete").expect.none({ within: milliseconds(100) });

// Cardinality.
await probe.on("publish").expect.atLeast(2);
await probe.on("publish").expect.exactly(3);
```

## Common patterns

### Timeouts

```typescript
import { seconds } from "@vnatures/test-kit";

it("times out when downstream does not respond", async () => {
    const responsePromise = sut.run();

    // Capture the call, never answer.
    await users.probe.on("getUser").expect.intercept();
    await rig.clock.advance(seconds(30));

    await expect(responsePromise).rejects.toThrow(/timed out/);
});
```

### Retries

```typescript
it("retries after a transient failure", async () => {
    const resultPromise = sut.run();

    const first = await users.probe.on("getUser").expect.intercept();
    first.reject(new Error("temporary"));

    await rig.clock.advance(seconds(2));

    const second = await users.probe.on("getUser").expect.intercept();
    second.answer({ id: 1, name: "Alice" });

    await expect(resultPromise).resolves.toBeDefined();
});
```

### Out-of-order concurrent calls

```typescript
it("answers parallel calls in the order the test chooses", async () => {
    const promise = sut.fetchBoth(1, 2);

    const call2 = await users.probe.on("getUser")
        .filter((c) => c.args[0] === 2, "id === 2")
        .expect.intercept();
    const call1 = await users.probe.on("getUser")
        .filter((c) => c.args[0] === 1, "id === 1")
        .expect.intercept();

    call2.answer({ id: 2, name: "Bob" });
    call1.answer({ id: 1, name: "Alice" });

    await expect(promise).resolves.toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
    ]);
});
```

### Pre-program preconditions, intercept the under-test boundary

```typescript
it("focuses on payment logic by pre-programming other deps", async () => {
    users.probe.on("getUser").always().answer(testUser);
    products.probe.on("getProduct").always().answer(testProduct);
    products.probe.on("reserveStock").always().answer(true);

    // The under-test boundary stays plumbing.
    payments.probe.on("charge").once().reject(new Error("declined"));

    await expect(sut.createOrder(1, items)).rejects.toThrow("declined");
});
```

## Streaming boundaries: `createProbedStreamMock`

`createProbedMock` fakes methods that return `Promise<T>` — settle once,
done. Some boundaries don't look like that: an `async *stream()` method
(or anything typed `(...) => AsyncIterable<T>`) yields zero or more chunks
over time and then completes or fails. `createProbedStreamMock` is the
sibling factory for exactly that shape.

```typescript
import { createProbedStreamMock } from "@vnatures/test-kit-mock";

interface Model {
    stream(prompt: string): AsyncIterable<{ text: string }>;
}

const { adapter, probe } = createProbedStreamMock<Model>({
    methods: ["stream"],
});

// Porcelain — replay a scripted sequence, then end normally.
probe.on("stream").always().answer([{ text: "hel" }, { text: "lo" }]);

for await (const chunk of adapter.stream("hi")) {
    console.log(chunk.text); // "hel", then "lo"
}
```

Rules mirror the Promise-based grammar but describe a sequence, not a
single value:

```typescript
// Yield chunks, then end.
probe.on("stream").once().answer(["a", "b"]);

// Derive chunks from the call, optionally failing partway through — have
// the source throw to simulate a mid-stream error (e.g. a provider
// disconnect) after some chunks were already delivered.
probe.on("stream").once().answerWith(async function* (call) {
    yield `chunk-for-${call.args[0]}`;
    throw new Error("connection dropped");
});

// Fail before any chunk is pushed.
probe.on("stream").once().reject(new Error("unauthorized"));

// Never close — consumption hangs (for timeout tests).
probe.on("stream").always().park();
```

Plumbing works the same way, except the pending call exposes
`push`/`end`/`error` instead of `answer`/`reject` — so a test can drive
the consumer's `for await` one chunk at a time, on its own schedule:

```typescript
const pending = await probe.on("stream").expect.intercept();
pending.push({ text: "first chunk" });
// ...assert on side effects the consumer produced from the first chunk...
pending.push({ text: "second chunk" });
pending.end(); // or pending.error(new Error("..."))
```

Use `createProbedStreamMock` for the boundary itself; if the real
dependency is a concrete class (not a plain interface) your SUT
constructs via `new`, write a thin subclass that delegates to the
mock's `adapter` — the same Goldilocks idea as injecting `Kysely`
instead of wrapping it, just applied to a class-shaped seam. See the
`component-testing` skill for a worked example against Strands'
`Model.stream()`.

## Working with fake timers

The rig auto-detects `vi.useFakeTimers()` and `jest.useFakeTimers()`
on construction. Use `rig.clock.advance(duration)` to drive the
SUT's timers; `expect.intercept`/`expect.observe` deadlines run on real
wall-clock time so a forgotten `clock.advance` produces a clean timeout
diagnostic instead of a 30s hang.

For Sinon, pass an installed `FakeTimers` instance explicitly:
`createRig({ clock: sinonFakeClock(timers) })`.

## See also

- [`@vnatures/test-kit`](../core/README.md) — core engine.
- [`docs/concepts.md`](../../docs/concepts.md) — mental model.
- [`docs/api-surface.md`](../../docs/api-surface.md) — exhaustive API
  reference.

