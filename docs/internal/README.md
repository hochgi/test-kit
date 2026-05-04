# Internal Documentation

This folder contains documentation for **contributors and the vnatures team**.
OSS adopters can ignore everything here — the consumer-facing reference lives
one level up in [`../README.md`](../README.md).

## Contents

- [`tech-design.md`](tech-design.md) — Implementation specification for
  the engine, domain adapters, and infra. Anyone modifying the core probe
  engine, the SQL driver seam, or a domain adapter should read this first.
- [`migration-from-v1.md`](migration-from-v1.md) — Mapping from the
  pre-OSS internal test-kit API to v1.0.0. Used by the team to rewrite
  legacy tests in internal services. From an OSS adopter's perspective
  the OSS release is version 1 of a fresh library; there is no v1 to
  migrate from.
