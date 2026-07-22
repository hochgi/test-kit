# @vnatures/test-kit-s3

S3 client and presigner adapters for component tests, with an
in-memory backing — no disk, no network, no module-global state. The
backing dispatches on `command.constructor.name` (a string) so the
adapter is robust to having multiple `@aws-sdk/client-s3` copies in the
same test process.

## Why two seams?

S3 consumers in production touch two independent SDK surfaces:

- **`S3Client`** from `@aws-sdk/client-s3` — handles real requests
  (`PutObject`, `GetObject`, …).
- **`getSignedUrl`** from `@aws-sdk/s3-request-presigner` — a standalone
  module-level function that constructs a pre-signed URL. It is **not**
  routed through `S3Client.send`, so no `S3Client` mock can intercept
  it.

This package exposes two adapters — `createProbedS3Adapter` and
`createProbedPresignerAdapter` — each with its own probe. Production
wires the real SDK; tests wire the probes via DI.

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-s3
```

Peer dependencies (consumer must provide): `@aws-sdk/client-s3`.
`@aws-sdk/s3-request-presigner` is an **optional** peer — it's only needed if
you use `createProbedPresignerAdapter`. It's a type-only import in this
package (erased at runtime), so S3-only consumers can omit it; it's marked
`peerDependenciesMeta.optional` so npm won't auto-install or warn about it.

## Quick start

```typescript
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHarness } from "@vnatures/test-kit";
import {
    createProbedS3Adapter,
    createProbedPresignerAdapter,
} from "@vnatures/test-kit-s3";

const harness = createHarness();
const s3 = harness.attach(
    createProbedS3Adapter({ harness, bucket: "my-bucket" }),
);
const presigner = harness.attach(
    createProbedPresignerAdapter({ harness }),
);

// Default rule for s3.adapter is forward — commands hit the in-memory backing.
await s3.adapter.send(
    new PutObjectCommand({ Bucket: "my-bucket", Key: "a", Body: "hello" }),
);
const get = await s3.adapter.send(
    new GetObjectCommand({ Bucket: "my-bucket", Key: "a" }),
);
expect(await get.Body!.transformToString()).toBe("hello");

// Default rule for presigner is reject (NotImplementedError) — programming
// an answer is mandatory.
presigner.probe.always().answerWith((call) => {
    const { commandInput, options } = call.input;
    const { Bucket, Key } = commandInput as { Bucket: string; Key: string };
    return `https://fake/${Bucket}/${Key}?expires=${options?.expiresIn ?? 0}`;
});

const url = await presigner.adapter.signUrl(
    s3.adapter,
    new GetObjectCommand({ Bucket: "my-bucket", Key: "a" }),
    { expiresIn: 3600 },
);
expect(url).toBe("https://fake/my-bucket/a?expires=3600");

await harness.close();
```

## What each adapter returns

```typescript
const { adapter, probe, reset, close } =
    createProbedS3Adapter({ harness, bucket });

const { adapter, probe, close } =
    createProbedPresignerAdapter({ harness });
```

- `s3.adapter: S3Client` — `.send(command)` returns a Promise that the
  probe routes through.
- `presigner.adapter: { signUrl }` — drop-in replacement for
  `getSignedUrl`.
- `probe` — `.calls`, `.command(CommandClass)`, `.commandsOf(name)`,
  `.expect.*`, `.drain()`, `.drainAndReject(error)`.
- `reset()` (S3 only) — clears the in-memory store; useful between
  tests.
- `close()` — disposes; `harness.close()` runs it automatically.

## Three verbs: `forward` / `answer` / `reject`

Every intercepted call can be settled three ways:

- **`forward`** — execute the in-memory backing.
  - `createProbedS3Adapter` supports `PutObject`, `GetObject`,
    `HeadObject`, `DeleteObject`, `DeleteObjects`, `ListObjects`,
    `ListObjectsV2`, `CopyObject`, `GetObjectTagging`,
    `PutObjectTagging`, `CreateBucket`, `DeleteBucket`. Any other
    command throws `NotImplementedError`; tests must program an
    explicit `answer` or `reject`. This is by design — no silent
    partial fakes.
  - `ListObjects`/`ListObjectsV2` honor real pagination: `MaxKeys`
    (default 1000), `ContinuationToken` / `NextContinuationToken` (v2)
    and `Marker` / `NextMarker` (v1), `StartAfter` (v2, fallback when no
    `ContinuationToken`), `IsTruncated`, prefix filtering, `Delimiter` /
    `CommonPrefixes` rollup, and stable UTF-8 byte lexicographic key
    order across pages (matching S3's sort, not JavaScript's UTF-16).
  - `createProbedPresignerAdapter` always rejects on `forward` —
    generating a real signed URL needs real credentials. Tests must
    program an `answer`.
- **`answerWith((call) => out)`** / **`answer(out)`** — resolve with a
  caller-provided value.
- **`reject(error)`** — fail the call.

## Programming calls

```typescript
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Reject every Get; default-forward stays for everything else.
s3.probe.command(GetObjectCommand).always().reject(new Error("s3 outage"));

// One-shot: the next Put is rejected, then forwarding resumes.
s3.probe.command(PutObjectCommand).once().reject(new Error("transient"));

// Plumbing: capture and forward manually.
const promise = s3.adapter.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));
const next = await s3.probe.command(GetObjectCommand).expect.intercept();
expect(next.input).toMatchObject({ Bucket: "b", Key: "k" });
next.forward();
await promise;
```

## Recorded shape

Each call is recorded as `{ commandName, command, input, options }`:

- `commandName: string` — `command.constructor.name` (e.g.
  `"PutObjectCommand"`). Used by `command(...)` and `commandsOf(...)`.
- `command` — the original command instance.
- `input` — the command's `input` property (for S3) or the original
  call's command-input (for the presigner).
- `options` — only present on presigner calls; carries `expiresIn`,
  etc.

Querying:

```typescript
s3.probe.calls;                                  // ReadonlyArray
s3.probe.command(GetObjectCommand);              // filtered selection
s3.probe.commandsOf("GetObjectCommand");         // string filter (minified bundles)
```

## In-memory backing

Replaces the older `mock-aws-s3-v3` dependency. Highlights:

- Map-based store keyed by `${bucket}/${key}`.
- Dispatches on `command.constructor.name` (string), so the adapter
  works even when the consumer's `@aws-sdk/client-s3` version differs
  from any version this package may have installed transitively.
- Bodies returned by `GetObject` are `Readable` streams with
  `transformToString` and `transformToByteArray` helpers, just like the
  real SDK.
- `NoSuchKey` is thrown using the SDK's own class for missing keys.

## See also

- [`docs/api-surface.md`](../../docs/api-surface.md) — full reference.
- [`docs/concepts.md`](../../docs/concepts.md) — mental model.

