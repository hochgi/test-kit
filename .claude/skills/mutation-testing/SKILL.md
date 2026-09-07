---
name: mutation-testing
description: >-
  Stated missing gate: mutation testing and CRAP have not landed in this
  repository (RD-24153). Use when a phase asks whether green means anything,
  or when tempted to port a coverage-quality workflow from another repo.
---

# Mutation testing — not landed

This repository has **no mutation testing** and **no CRAP report**. That work
is RD-24153. Do not try to run a mutation or CRAP gate here: it has not
landed.

Tests import by package name and resolve through `dist/`. A mutant applied
to `src` is never loaded, so a naive mutation run would not exercise the
code under test. Until RD-24153 fixes that resolution, phase 5 can confirm
that green is real, not that green means anything.

Do not add a mutation or CRAP script as part of an ordinary packet. When the
gate lands, this skill will become the how-to.
