---
name: hotspot-expansion-review
description: >-
  Pre-check before adding logic to a large method, adapter, probe, or factory.
  Identifies extraction seams to avoid making hotspots worse. Use when touching
  a method longer than ~40 lines, a file longer than ~300 lines, or adding a
  new code path to an existing orchestrator.
---

# Hotspot Expansion Review

Run this pre-pass **before writing any new logic** in an existing hotspot.

## Step 1 — Measure the hotspot

Read the target method/file. Note:

- Method line count (threshold: ~40 lines; hard budget 80)
- Max nesting depth (threshold: 2 levels; hard budget 4)
- Parameter count (threshold: 4 positional params; hard budget 5)
- Number of distinct responsibilities (parse options, attach adapter, program
  probe, settle pending call, tear down, etc.)

If all metrics are below threshold, skip this skill and proceed normally.

## Step 2 — Identify one extraction seam

Pick the **one** seam that would give the most readability improvement:

| Smell                                        | Extraction pattern                                              |
| -------------------------------------------- | --------------------------------------------------------------- |
| Deep nesting (`for > if > for`)              | Extract inner body into a named helper                          |
| Long sequential phases                       | Split into orchestrator + named phase methods                   |
| Multiple output collectors built in one loop | Extract per-collector logic into helpers; assemble in orchestrator |
| High parameter count (>4)                    | Group related params into a typed object                        |
| Repeated conditional chains                  | Extract into a lookup or strategy map                           |

## Step 3 — Extract before extending

1. Extract the chosen seam as a **refactor-only** step (no new behavior).
2. Verify tests still pass (`npm test` for the touched workspace; build first
   if that package's tests resolve through `dist/`).
3. Then add the new logic to the now-smaller method.

If the hotspot is too tangled to extract safely, call it out to the user rather
than piling on more code.

## Checklist

Before writing new logic in a hotspot, confirm:

- [ ] I measured the method and it is above at least one threshold
- [ ] I identified one extraction seam
- [ ] I extracted it as a standalone commit or step before adding new behavior
- [ ] The method I am extending now reads as orchestration of named steps
