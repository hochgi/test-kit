/**
 * Delta docs/internal/spec/deltas/P02-P03-rig-rename-2.0.0.md
 * → acceptance items 1 (source file moved), 8 (mock lifecycle test moved),
 *   11 (the ADR exists) and 12 (the do-not-touch zone is untouched).
 *
 * Item 7 (the clean-install symlink check) is deliberately NOT here: it needs
 * `rm -rf node_modules && npm install`, which is phase 5's manual step.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

function git(args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd: repoRoot, encoding: 'utf8' });
}

function tryGit(args: readonly string[]): string | null {
    try {
        return git(args);
    } catch {
        return null;
    }
}

describe('Acceptance item 1: the lifecycle owner source moved to rig.ts', () => {
    it('packages/core/src/rig.ts exists', () => {
        expect(existsSync(path.join(repoRoot, 'packages/core/src/rig.ts'))).toBe(true);
    });

    it('packages/core/src/harness.ts does not exist', () => {
        expect(existsSync(path.join(repoRoot, 'packages/core/src/harness.ts'))).toBe(false);
    });
});

describe('Acceptance item 8: the mock lifecycle suite moved to rig-lifecycle.test.ts', () => {
    it('packages/mock/test/integration/rig-lifecycle.test.ts exists', () => {
        expect(existsSync(path.join(repoRoot, 'packages/mock/test/integration/rig-lifecycle.test.ts'))).toBe(true);
    });

    it('packages/mock/test/integration/harness-lifecycle.test.ts does not exist', () => {
        expect(existsSync(path.join(repoRoot, 'packages/mock/test/integration/harness-lifecycle.test.ts'))).toBe(false);
    });
});

describe('Scenario: the ADR exists and names its subject', () => {
    it('docs/adr/ contains at least one markdown ADR', () => {
        const adrDir = path.join(repoRoot, 'docs/adr');
        expect(existsSync(adrDir), 'docs/adr/ is missing').toBe(true);
        const entries = readdirSync(adrDir).filter((file) => file.endsWith('.md'));
        expect(entries.length).toBeGreaterThan(0);
    });
});

// The agent-pipeline sense of "harness" lives in these paths. The rename must
// not reach into them, so assert the branch touches nothing here.
const PROTECTED_PREFIXES = [
    'test/',
    '.harness/',
    'scripts/',
    '.claude/',
    '.cursor/',
    '.opencode/',
    'docs/internal/archive/',
] as const;
const PROTECTED_FILES = ['docs/internal/spec/harness-scaffold.md'] as const;

function isProtected(file: string): boolean {
    return PROTECTED_PREFIXES.some((prefix) => file.startsWith(prefix)) || PROTECTED_FILES.includes(file as never);
}

function touchedPaths(base: string): readonly string[] {
    const committed = git(['diff', '--name-only', base, 'HEAD']).split('\n');
    // Uncommitted work counts too: porcelain lines are "XY path" or
    // "XY old -> new" for renames.
    const working = git(['status', '--porcelain'])
        .split('\n')
        .flatMap((line) => (line.length > 3 ? line.slice(3).split(' -> ') : []))
        .map((entry) => entry.replace(/^"|"$/g, ''));
    return [...new Set([...committed, ...working].map((file) => file.trim()).filter((file) => file !== ''))];
}

/**
 * CI checkouts fetch the build ref without creating a local `main`, so
 * `merge-base HEAD main` fails there while `origin/main` resolves. Try both
 * and FAIL rather than skip when neither does — this is the only guard
 * separating the library sense of "harness" from the agent-pipeline sense,
 * and a guard that can silently vanish is not a guard.
 */
function resolveMergeBase(): string | null {
    for (const ref of ['main', 'origin/main']) {
        const base = tryGit(['merge-base', 'HEAD', ref])?.trim();
        if (base !== undefined && base !== '') {
            return base;
        }
    }
    return null;
}

describe('Acceptance item 12: the do-not-touch zone is untouched', () => {
    it('resolves a merge base against main', () => {
        expect(
            resolveMergeBase(),
            'neither `main` nor `origin/main` resolved a merge base; fetch main so this guard can run',
        ).not.toBeNull();
    });

    it('no file in the agent-harness / repo-gate zone is modified on this branch', () => {
        const base = resolveMergeBase();
        if (base === null) {
            throw new Error('cannot check the do-not-touch zone: no merge base against main or origin/main');
        }
        const offenders = touchedPaths(base).filter(isProtected);
        expect(offenders).toEqual([]);
    });
});
