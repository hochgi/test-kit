/**
 * Delta docs/internal/spec/deltas/P02-P03-rig-rename-2.0.0.md
 * → "Requirement: The lifecycle owner is named Rig" (acceptance item 2).
 *
 * Value exports are checked through the package entry point (the same
 * resolution every other test in this repo uses); the four type-only names
 * have no runtime footprint, so they are checked in the built declarations —
 * which is literally what the delta's scenario says is read.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as testKit from '@hochgi/test-kit';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const declarationFile = path.join(repoRoot, 'packages/core/dist/index.d.ts');

const newNames = ['Rig', 'RigRef', 'RigExpectations', 'CreateRigOptions', 'createRig'] as const;
const formerNames = ['Harness', 'HarnessRef', 'HarnessExpectations', 'CreateHarnessOptions', 'createHarness'] as const;

/**
 * `vite-plugin-dts` with `rollupTypes` emits one flat declaration file whose
 * public names all appear as `export declare <kind> <name>`. Matching that form
 * — rather than a bare substring — is what makes this an *exported name* check:
 * prose in a doc comment does not count.
 */
function declaresExport(declarations: string, name: string): boolean {
    return new RegExp(`^export declare (?:abstract class|class|const|function|interface|type) ${name}\\b`, 'm').test(
        declarations,
    );
}

function declarations(): string {
    expect(
        existsSync(declarationFile),
        'packages/core/dist/index.d.ts is missing — build packages/core before running this test',
    ).toBe(true);
    return readFileSync(declarationFile, 'utf8');
}

describe('Scenario: Rig surface is exported', () => {
    it('createRig is a callable export of @hochgi/test-kit', () => {
        expect(typeof testKit.createRig).toBe('function');
    });

    it.each(newNames)('%s is declared as an exported name', (name) => {
        expect(declaresExport(declarations(), name)).toBe(true);
    });
});

describe('Scenario: the former Harness names are gone', () => {
    it('createHarness is not a runtime export of @hochgi/test-kit', () => {
        expect(Object.keys(testKit)).not.toContain('createHarness');
    });

    it.each(formerNames)('%s does not appear as an exported name', (name) => {
        expect(declaresExport(declarations(), name)).toBe(false);
    });
});
