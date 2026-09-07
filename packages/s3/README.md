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
import { createRig } from "@vnatures/test-kit";
import {
    createProbedS3Adapter,
    createProbedPresignerAdapter,
} from "@vnatures/test-kit-s3";

const rig = createRig();
const s3 = rig.attach(
    createProbedS3Adapter({ harness: rig, bucket: "my-bucket" }),
);
const presigner = rig.attach(
    createProbedPresignerAdapter({ harness: rig }),
);

// Default rule for s3.adapter is forward — commands hit the in-memory backing.
await s3.adapter.send(
    new PutObjectCommand({ Bucket: "my-bucket", Key: "a", Body: "hello" }),
);
const get = await s3.adapter.send(
    new GetObjectCommand({ Bucket: "my-bucket", Key: "a" }),
);
expect(await get.Body!.transformToString()).toBe("hello");

// Calls park with no default rule — programming an answer is mandatory.
presigner.probe.always().answerWith((call) => {
    const { commandInput, options } = call;
    const { Bucket, Key } = commandInput as { Bucket: string; Key: string };
    return `https://fake/${Bucket}/${Key}?expires=${options?.expiresIn ?? 0}`;
});

const url = await presigner.adapter.signUrl(
    s3.adapter,
    new GetObjectCommand({ Bucket: "my-bucket", Key: "a" }),
    { expiresIn: 3600 },
);
expect(url).toBe("https://fake/my-bucket/a?expires=3600");

await rig.close();
```

## What each adapter returns

```typescript
const { adapter, probe, reset, close } =
    createProbedS3Adapter({ harness: rig, bucket });

const { adapter, probe, close } =
    createProbedPresignerAdapter({ harness: rig });
```

- `s3.adapter: S3Client` — `.send(command)` returns a Promise that the
  probe routes through.
- `presigner.adapter: { signUrl }` — drop-in replacement for
  `getSignedUrl`.
- `probe` — `.calls`, `.command(CommandClass)`, `.command(name)`,
  `.expect.*`, `.drain()`, `.drainAndReject(error)`.
- `reset()` (S3 only) — clears the in-memory store; useful between
  tests.
- `close()` — disposes; `rig.close()` runs it automatically.

## Three verbs: `forward` / `answer` / `reject`

Every intercepted call can be settled three ways:

- **`forward`** — execute the in-memory backing.
  - `createProbedS3Adapter` supports `PutObject`, `GetObject`,
    `HeadObject`, `DeleteObject`, `DeleteObjects`, `ListObjects`,
    `ListObjectsV2`, `CopyObject`, `GetObjectTagging`,
    `PutObjectTagging`, `CreateBucket`, `DeleteBucket`. Any other
    command throws a plain `Error` from `errors.unsupportedForward`;
    tests must program an explicit `answer` or `reject`. This is by
    design — no silent partial fakes.
  - `ListObjects`/`ListObjectsV2` honor real pagination: `MaxKeys`
    (default **and hard cap** 1000 — values above 1000 are silently
    clamped, matching real S3), `ContinuationToken` /
    `NextContinuationToken` (v2) and `Marker` / `NextMarker` (v1),
    `StartAfter` (v2, fallback when no `ContinuationToken`),
    `IsTruncated`, prefix filtering, `Delimiter` / `CommonPrefixes`
    rollup, and stable UTF-8 byte lexicographic key order across pages
    (matching S3's sort, not JavaScript's UTF-16).
  - `createProbedPresignerAdapter` has no default rule — calls park
    until the test answers or rejects them. Generating a real signed
    URL needs real credentials, so `forward` has no backing.
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

S3 client calls are recorded as `{ commandName, command, input }`:

- `commandName: string` — `command.constructor.name` (e.g.
  `"PutObjectCommand"`). Used by `command(...)`.
- `command` — the original command instance.
- `input` — the command's `input` property.

Presigner calls are recorded as `{ commandName, commandInput, options }`
at the top level (no nested `input` field):

- `commandName: string` — the command constructor name.
- `commandInput` — the command's input.
- `options` — presign options (`expiresIn`, etc.).

Querying:

```typescript
s3.probe.calls;                                  // ReadonlyArray
s3.probe.command(GetObjectCommand);              // constructor filter
s3.probe.command("GetObjectCommand");            // string filter (minified bundles)
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
- **ETag** is the MD5 of the stored body, quoted
  (`"${md5(body)}"`) — real AWS semantics for non-multipart objects.
  Rewriting a key with different bytes yields a different ETag;
  identical bytes under different keys share an ETag. Tagging does not
  change the ETag. `CopyObject` reports the ETag of the copied body
  (equals the source for a plain copy).
- **Conditional requests** on `GetObject` / `HeadObject` / `PutObject`:
  - `IfMatch` — 412 `PreconditionFailed` when the current ETag differs
    (GET/HEAD/PUT compare-and-swap).
  - `IfNoneMatch` — 304 `NotModified` on GET/HEAD when it matches;
    `IfNoneMatch: '*'` on PUT is create-only (412 when the key exists).
  Errors use `S3ServiceException` with the canonical `.name` and
  `$metadata.httpStatusCode`, matching the `NoSuchKey` discrimination
  pattern (`err.name === '…'` works cross-SDK-copy).
- `NoSuchKey` is thrown using the SDK's own class for missing keys.
- `VersionId` / object versioning is **not** modelled — the store is
  last-write-wins per key.

## See also

- [`docs/api-surface.md`](../../docs/api-surface.md) — full reference.
- [`docs/concepts.md`](../../docs/concepts.md) — mental model.

