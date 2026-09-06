# Specs

`docs/internal/spec/<capability>.md` holds **current truth** — one file per
capability, not per packet.

A packet does not add a document here. It writes a **delta** to
`deltas/<packet>.md` (`## ADDED / MODIFIED / REMOVED Requirements`), which the
orchestrator folds into the capability file after the PR merges. The packet and
its applied delta then move to `docs/internal/archive/{date}-{packet}/`.

The point is that you can open one file and know what is true today, instead of
reconciling fourteen historical documents. See the `write-spec` skill for the
delta format.
