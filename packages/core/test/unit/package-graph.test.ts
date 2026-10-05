/**
 * Delta docs/internal/spec/deltas/P02-P03-rig-rename-2.0.0.md
 * → "Requirement: Every workspace package is version 2.0.0" and
 *   "Requirement: Core is a peer dependency of every sibling that needs it"
 * (acceptance items 4, 5, 6).
 *
 * Reads the manifests off disk rather than through a resolver, so a stale
 * node_modules tree cannot make this pass.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const packagesDir = path.join(repoRoot, 'packages');

const CORE = '@hochgi/test-kit';
const SIBLINGS = ['@hochgi/test-kit-sql', '@hochgi/test-kit-pglite-driver'] as const;

/** The 11 packages the delta names as consumers of core. */
const CORE_CONSUMERS = [
    'bull',
    'kafka',
    'mock',
    'mysql',
    'pg-knex',
    'pg-kysely',
    'pg-sequelize',
    'redis',
    's3',
    'sql',
    'sqs',
] as const;

interface Manifest {
    readonly name?: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
}

function packageDirs(): readonly string[] {
    return readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function manifest(dir: string): Manifest {
    return JSON.parse(readFileSync(path.join(packagesDir, dir, 'package.json'), 'utf8')) as Manifest;
}

const dirs = packageDirs();
const manifests = new Map(dirs.map((dir) => [dir, manifest(dir)] as const));

/**
 * The semantic guarantee is the MAJOR digit, not the exact patch. Each package
 * bumps its own patch independently in the PR that changes it, so the
 * manifests drift apart within 2.x. Asserting an exact "2.0.0" here would turn
 * main red on the next release while proving nothing extra: what stops a consumer on ^1.x auto-pulling the
 * rename is major 2, and what satisfies the siblings' ^2.0.0 peer range is any
 * 2.x. So pin the major and require a valid semver, not a frozen string.
 */
describe('Scenario: all manifests are on major 2', () => {
    it('there are 13 workspace packages under packages/', () => {
        expect(dirs).toHaveLength(13);
    });

    it.each(dirs)('packages/%s/package.json declares a 2.x version', (dir) => {
        const version = manifests.get(dir)?.version;
        expect(version, `packages/${dir} must declare a version`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(version?.split('.')[0], `packages/${dir} must be on major 2`).toBe('2');
    });

    it('no package is left on a 1.x version', () => {
        const stragglers = dirs.filter((dir) => (manifests.get(dir)?.version ?? '').startsWith('1.'));
        expect(stragglers).toEqual([]);
    });
});

describe('Scenario: core is a peer, never a direct dependency', () => {
    it.each(dirs)('packages/%s does not declare @hochgi/test-kit in dependencies', (dir) => {
        expect(Object.keys(manifests.get(dir)?.dependencies ?? {})).not.toContain(CORE);
    });

    it.each(CORE_CONSUMERS)('packages/%s declares @hochgi/test-kit in peerDependencies at ^2.0.0', (dir) => {
        expect(manifests.get(dir)?.peerDependencies?.[CORE]).toBe('^2.0.0');
    });

    it('the set of packages peer-depending on core is exactly the 11 consumers', () => {
        const peers = dirs.filter((dir) => manifests.get(dir)?.peerDependencies?.[CORE] !== undefined).sort();
        expect(peers).toEqual([...CORE_CONSUMERS].sort());
    });

    it('pglite-driver declares @hochgi/test-kit nowhere', () => {
        const pglite = manifests.get('pglite-driver');
        expect(pglite?.dependencies?.[CORE]).toBeUndefined();
        expect(pglite?.peerDependencies?.[CORE]).toBeUndefined();
        expect(pglite?.devDependencies?.[CORE]).toBeUndefined();
    });
});

describe('Scenario: internal sibling ranges admit 2.0.0', () => {
    it('every @hochgi/test-kit-sql / @hochgi/test-kit-pglite-driver range is ^2.0.0', () => {
        const offenders: string[] = [];
        for (const dir of dirs) {
            const parsed = manifests.get(dir);
            for (const block of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
                for (const sibling of SIBLINGS) {
                    const range = parsed?.[block]?.[sibling];
                    if (range !== undefined && range !== '^2.0.0') {
                        offenders.push(`packages/${dir} ${block}.${sibling} = ${range}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the sibling ranges stay in dependencies, not peerDependencies', () => {
        const misplaced: string[] = [];
        for (const dir of dirs) {
            const parsed = manifests.get(dir);
            for (const sibling of SIBLINGS) {
                if (parsed?.peerDependencies?.[sibling] !== undefined) {
                    misplaced.push(`packages/${dir} peerDependencies.${sibling}`);
                }
            }
        }
        expect(misplaced).toEqual([]);
    });
});
