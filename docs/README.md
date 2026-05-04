# Documentation

Reference documentation for `@vnatures/test-kit`. The root [`README.md`](../README.md)
covers installation, packages, and a guided tour. The docs in this folder
cover the deeper material.

## For consumers

- [`concepts.md`](concepts.md) — Mental model, vocabulary, and ergonomics.
  Read first if you are new to probe-driven component testing.
- [`architecture.md`](architecture.md) — Package layout and what each module
  owns. Useful when you are deciding which package to install or when
  navigating the source.
- [`api-surface.md`](api-surface.md) — Exhaustive API reference: every type,
  factory, and matching rule with their semantics and error contracts.

## For contributors

- [`internal/tech-design.md`](internal/tech-design.md) — Implementation
  specification: internal core API, storage model, rule resolution algorithm,
  per-domain implementation patterns, build/test/distribution choices.
- [`internal/migration-from-v1.md`](internal/migration-from-v1.md) — Mapping
  from the pre-OSS internal test-kit API to the v1.0.0 surface. Used by the
  vnatures team to rewrite legacy tests; does not apply to OSS adopters.
