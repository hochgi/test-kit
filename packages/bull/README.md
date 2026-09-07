# @vnatures/test-kit-bull

Drop-in probed Bull `Queue` adapter for component tests, backed by a
functional in-memory queue — no real Redis required.

## Why a drop-in Bull `Queue`?

`@nestjs/bull` consumers inject `bull.Queue` via `getQueueToken(name)`.
This package provides a probed drop-in replacement so tests can override
that provider without production refactors, while still exercising real
enqueue / consume lifecycle in-process.

The primary probed seam is the producer (`add`). Failure and hang
injection (`reject`, `intercept` + `rig.clock.advance`) model the
application-observable enqueue outcome (RD-23255 stale-socket failures).

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-bull
# peer: bull (consumer provides its own version)
```

## Quick start

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedBullQueue, maxRetriesPerRequestError } from "@vnatures/test-kit-bull";
import { getQueueToken } from "@nestjs/bull";

const rig = createRig();
const queue = rig.attach(createProbedBullQueue({ harness: rig, name: "exports" }));

// NestJS: override the queue provider — do NOT import BullModule.
// .overrideProvider(getQueueToken("exports")).useValue(queue.adapter)

// Default rule forwards add to the in-memory backing.
const job = await queue.adapter.add({ siteId: 1 });
expect(job.id).toBeDefined();

// Model an enqueue failure:
queue.probe.on("add").once().reject(maxRetriesPerRequestError());

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, reset, close } = createProbedBullQueue({ harness: rig, name });
```

- `adapter: Queue<TData>` — inject at `getQueueToken(name)`. Default rule
  forwards `add` to the in-memory backing.
- `probe: BullQueueProbe` — `.on('add')`, `.calls`, `.expect.*`,
  `.drain()`, `.drainAndReject()`.
- `reset()` — empties the in-memory queue between tests.
- `close()` — disposes the backing. Handled by `rig.close()` if attached.

## Supported Bull surface (v1)

Forwarded: `add`, `process` (concurrency 1), `getJob`, `getJobCounts`,
`getJobs`, `isReady`, `close`, and event registration (`on`/`once`).

Unsupported operations (priorities, retries/backoff, repeatable jobs,
rate-limiting, etc.) throw a loud error on `forward()` so tests must
program an explicit `answer` or `reject`.

## See also

- [`docs/concepts.md`](../../docs/concepts.md) for the boundary and backed-adapter model.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full probe reference.
