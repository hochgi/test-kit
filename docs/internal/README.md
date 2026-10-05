# Internal Documentation

This folder contains documentation for **contributors**. If you only use the
packages, you can ignore everything here — the consumer-facing reference lives
one level up in [`../README.md`](../README.md).

## Contents

- [`tech-design.md`](tech-design.md) — Implementation specification for
  the engine, domain adapters, and infra. Anyone modifying the core probe
  engine, the SQL driver seam, or a domain adapter should read this first.
- [`spec/`](spec/) — Current truth per capability: EARS requirements and
  Gherkin scenarios that the repository's own tests enforce.
- [`packets/`](packets/) — Work packets in flight (input to `/spec-to-ship`).
- [`archive/`](archive/) — Applied packets and spec deltas, kept for the
  reasoning behind past decisions.
