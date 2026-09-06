import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
    'packages/core',
    'packages/mock',
    'packages/sql',
    'packages/pglite-driver',
    'packages/redis',
    'packages/bull',
    'packages/s3',
    'packages/sqs',
    'packages/kafka',
    'packages/mysql',
    'packages/pg-kysely',
    'packages/pg-knex',
    'packages/pg-sequelize',
    'examples/grpc-client',
    'test/ci-gate',
    'test/docs-truth',
]);
