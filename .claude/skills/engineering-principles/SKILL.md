---
name: engineering-principles
description: >-
  Concrete code-quality conventions for this library monorepo: narrow and deep
  public surfaces, no `any` (ESLint error via no-explicit-any), reuse before
  adding, treat existing code as context not precedent, adapter/probe vocabulary,
  BSSN. Use when touching packages/*/src, reviewing design choices, or deciding
  whether to add a new file vs extend an existing one.
---

# Engineering principles

You follow good SWE principles from the literature (Pragmatic Programmer, Clean
Code, A Philosophy of Software Design) and authors like Martin Fowler, Joe
Armstrong, Martin Thompson, Uncle Bob, Alistair Cockburn, Kent Beck, Dan North,
Dave Farley. You apply SOLID/CUPID and BSSN (Best Simple System for Now:
simplest solution that could possibly work, no slower than necessary).

Concretely, in any code you touch under `packages/*/src`:

- **Treat existing code as context, not precedent.** Fix obvious local leaks in
  the touched slice; do not mirror nearby debt forward.
- **Reuse before adding.** Reuse an existing adapter, probe, factory, helper, or
  backing before creating a new file. Add code only when it reduces net
  complexity.
- **Prefer narrow, deep interfaces.** Do not widen a public API with
  pass-through or renamed variants of existing behaviour. The published surface
  *is* the product.
- **No `any`.** Prefer `unknown` with a narrowing guard. Do not introduce
  `any`, `as any`, or `Record<string, any>`. `any` is now an ESLint error
  (`no-explicit-any`); existing type-seam `any`s have inline disables. If a
  library forces a cast, isolate it in one small adapter with a one-line
  justification.
- **One clear contract per public method.** Prefer a new named method over a
  boolean flag that switches semantics — judgment call, weighed against DRY.
- **Use `import type` for type-only imports.**

## Adapter / probe vocabulary

Reuse the terms in `docs/concepts.md` exactly:

- An **adapter** is the object injected into the component under test.
- A **probe** is the test-facing control surface for that adapter.
- A **rig** (`createRig`) owns lifecycle; close it with `rig.close()`.
- Leaf-only probing: fake the external seam, construct composites from adapters.
- Goldilocks boundaries: too thin leaks protocol; too fat swallows the logic
  under test.

A change that invents a parallel dialect (different settlement verbs, a second
expectation grammar, renaming adapter/probe) is a defect even when tests pass.

## When to push back

These aren't hard gates to enforce against the human. When a reviewer or
operator asks for something that violates a principle, raise the trade-off
explicitly:

- "This widens the public API; want me to do that or extract a sibling?"
- "That would require an `any` cast at the boundary; OK to isolate it in a
  one-line adapter?"

Then do what they say. The principles guide your default choice; the human
decides when the trade-off is worth it.

## Anti-patterns

- **Boolean parameters that switch routing behaviour.** A method whose return
  shape depends on a `boolean` arg is two methods wearing a trench coat. Split
  it or use a typed enum.
- **Wide pass-through types.** When you need a subset of a client, prefer a
  narrow interface over passing the whole object.
- **Same-file growth.** When a file passes ~300 lines or ~5 exported functions,
  that's a hotspot signal — see the `hotspot-expansion-review` skill.
- **God orchestrator functions.** Bolting "one more branch/guard" onto a
  function until it's hundreds of lines and many-deep. High test coverage does
  not excuse this.

## Complexity budget (blinker convention)

The structural budget lives in the blinkers under `.cursor/rules/`.
`npm run lint` enforces it as a ratchet (existing violations have inline
disables). There are still **no git hooks**:

| Budget                      | Limit |
| --------------------------- | ----- |
| `complexity` (cyclomatic)   | ≤ 12  |
| `max-depth` (block nesting) | ≤ 4   |
| `max-lines-per-function`    | ≤ 80  |
| `max-params`                | ≤ 5   |

**Make it work, then make it right.** After the suite is green and before you
ship, extract any function you pushed over budget. Mutation testing and CRAP
have not landed (RD-24153); do not wait for a coverage-quality score to tell
you a function is too big.
