import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/core',
  'packages/mock',
  'packages/sql',
  'packages/pglite-driver',
  'packages/redis',
  'packages/s3',
  'packages/pg-kysely',
  'packages/pg-knex',
  'packages/pg-sequelize',
  'examples/grpc-client',
]);
