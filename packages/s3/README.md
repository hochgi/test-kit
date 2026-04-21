# @vnatures/test-kit-s3

A disk-backed S3 fake and presigner fake for component tests, built on [`mock-aws-s3-v3`](https://www.npmjs.com/package/mock-aws-s3-v3).

## Why two seams?

S3 consumers in production touch two independent SDK surfaces:

- **`S3Client`** from `@aws-sdk/client-s3` — handles real requests (`PutObject`, `GetObject`, ...).
- **`getSignedUrl`** from `@aws-sdk/s3-request-presigner` — a standalone module-level function that constructs a pre-signed URL. It is **not** routed through `S3Client.send`, so no `S3Client` mock can intercept it.

This package therefore exposes two probed fakes — a probed `S3Client` and a probed `Presigner` — each with its own `S3Probe`. Your application code should depend on both boundaries via DI; production wires the real SDK, tests wire the probes.

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-s3
```

Peer dependencies (consumer must provide): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

## Quick start

```typescript
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createProbedS3Client, createProbedPresigner } from '@vnatures/test-kit-s3';

const probedS3 = createProbedS3Client({ bucket: 'my-bucket' });
const probedPresigner = createProbedPresigner();

// Default behavior for S3Client: alwaysForward — commands go through mock-aws-s3-v3,
// persisted to a per-instance tmpdir.
await probedS3.client.send(new PutObjectCommand({ Bucket: 'my-bucket', Key: 'a', Body: 'hello' }));
const res = await probedS3.client.send(new GetObjectCommand({ Bucket: 'my-bucket', Key: 'a' }));
await res.Body!.transformToString(); // 'hello'

// Default behavior for the presigner: forward throws NotImplementedError.
// You MUST program answers.
probedPresigner.probe.alwaysAnswer((call) => {
    const { commandInput, options } = call.input as import('@vnatures/test-kit-s3').PresignCallInput;
    const { Bucket, Key } = commandInput as { Bucket: string; Key: string };
    return `https://fake/${Bucket}/${Key}?expires=${options?.expiresIn ?? 0}`;
});

const url = await probedPresigner.presigner.signUrl(
    probedS3.client,
    new GetObjectCommand({ Bucket: 'my-bucket', Key: 'a' }),
    { expiresIn: 3600 },
);
// 'https://fake/my-bucket/a?expires=3600'

// Clean up between tests.
probedS3.reset();
// Or at suite end:
await probedS3.close();
```

## The three verbs: `forward` / `answer` / `reject`

Every intercepted call can be settled three ways:

- **`forward()`** — execute the "real" backend:
  - For `createProbedS3Client`: routes to the `mock-aws-s3-v3`-backed client. Works for the 12 commands it implements; any other command throws `NotImplementedError`.
  - For `createProbedPresigner`: always throws `NotImplementedError` — generating a real signed URL needs real credentials and network I/O. Always program an `answer` for presign calls.
- **`answer(output)`** — resolve the call with a caller-provided value. Essential for unsupported S3 commands and for all presign calls.
- **`reject(error)`** — fail the call.

## Porcelain API (pre-programmed behavior)

```typescript
const { probe } = probedS3;

// Permanent defaults (set one at a time; last write wins):
probe.alwaysForward();                 // default for probedS3
probe.alwaysAnswer((call) => ({ /* ... */ }));  // dynamic default
probe.alwaysReject(new Error('outage'));

// One-shot overrides (FIFO queue per command name):
probe.whenCalled(GetObjectCommand).thenForward();
probe.whenCalled(GetObjectCommand).thenAnswer({ /* ... */ });
probe.whenCalled(GetObjectCommand).thenReject(new Error('s3 down'));

probe.clearBehavior();  // reset both permanent default and queued one-shots
```

## Plumbing API (inspect / capture calls)

```typescript
// Wait for the next call of any kind:
const pending = await probe.expectNext();
expect(pending.commandName).toBe('PutObjectCommand');
pending.forward();   // or pending.answer(out) / pending.reject(err)

// Wait for a specific call:
const getPending = await probe.expectMatching((c) => c.commandName === 'GetObjectCommand');

// Observe without capturing:
probe.calls;                 // ReadonlyArray<S3Call>
probe.callsOf(PutObjectCommand);
probe.pendingCount();
```

## Recorded shape

- **`createProbedS3Client`** records each call as `{ commandName, input }` where `input` is the exact `command.input` the caller built. Asserting on this replaces the "was this call made?" questions the old fat-mock patterns couldn't answer.
- **`createProbedPresigner`** records each call as `{ commandName, input: PresignCallInput }` where `PresignCallInput = { commandInput, options }`. Tests can inspect `options.expiresIn` alongside `commandInput.Key`.

## `forward` is loud when it can't satisfy a call

`mock-aws-s3-v3` implements: `PutObject`, `GetObject`, `HeadObject`, `CopyObject`, `CreateBucket`, `DeleteBucket`, `DeleteObject`, `DeleteObjects`, `ListObjects`, `ListObjectsV2`, `GetObjectTagging`, `PutObjectTagging`. Anything else (e.g. `CreateMultipartUploadCommand`) throws `NotImplementedError` on forward — the test must program an explicit `answer` or `reject`. This is by design (BSSN): no silent partial fakes.

## Isolation notes

- `mock-aws-s3-v3` keys its internal bucket contexts by bucket name in a module-global Map. `createProbedS3Client` calls `resetMocks(bucket)` at construction to flush any stale state. Between tests in the same suite, call `.reset()`; at suite teardown, call `.close()`.
- Within a single Jest worker, tests run serially. Across workers, each worker has its own process and its own tmpdir, so isolation holds.

## Command-name reflection

Calls are recorded via `command.constructor.name` (e.g. `'GetObjectCommand'`). This is reliable for the first-party AWS SDK commands shipped in `@aws-sdk/client-s3`. If your test bundle aggressively minifies class names, pass the command name as a string to `whenCalled('GetObjectCommand').thenAnswer(...)` and assert via `probe.callsOf('GetObjectCommand')`.
