# P01 docs truth pass — 41 defects across the published docs

Ticket: RD-24142
Depends on: P00 (RD-24141)

Reconcile published and contributor docs with `packages/*/src`. The agent
harness's phase 1 grounds its vocabulary in these documents; they currently
document APIs that do not exist and signatures that will not compile.

Scope: markdown under `docs/` (except spec deltas, packets, and archive),
package READMEs, root `README.md` and `APPENDIX.md`, plus adjacent source
comments and test titles that name the same falsehoods. No public TypeScript
surface change; not a semver event.

Out: Harness → Rig rename (RD-24143); documenting every internal engine
export; mutation testing / CRAP (RD-24153).
