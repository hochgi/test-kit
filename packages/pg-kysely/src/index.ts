export { createProbedKyselyAdapter } from './factory.js';
export type { CreateProbedKyselyAdapterOptions, ProbedKyselyAdapter } from './factory.js';

export type { QueryCall, QueryPendingCall, QueryProbe, SqlDriver } from '@vnatures/test-kit-sql';

/**
 * Re-export the PGlite type-parser registry from the same `@electric-sql/pglite`
 * copy that the probed Kysely adapter uses internally. Consumer tests that
 * need to override type parsers (e.g. for TIMESTAMP columns) MUST mutate this
 * exported `types` rather than importing from `@electric-sql/pglite` directly,
 * because npm tends to install duplicate copies of pglite when a probe-driven
 * test-kit is consumed via `file:` references — and only mutations on the
 * SAME copy as pg-kysely's internal usage take effect.
 */
export { types as pgliteTypes } from '@electric-sql/pglite';
