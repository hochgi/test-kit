/**
 * Delta docs/internal/spec/deltas/P02-P03-rig-rename-2.0.0.md
 * → "MODIFIED Requirement: Library docs describe the shipped lifecycle owner"
 *   (acceptance items 9 and 10).
 *
 * "Library doc" is defined exactly as test/docs-truth/docs-truth.test.ts
 * defines it, so the two suites cannot disagree about the corpus. This file
 * lives under packages/core/test/ because acceptance item 12 forbids touching
 * test/.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

interface Doc {
    readonly file: string;
    readonly content: string;
}

function gitLsFiles(paths: readonly string[]): readonly string[] {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: repoRoot, encoding: 'utf8' })
        .split('\0')
        .filter((file) => file !== '');
}

function isNoisePath(file: string): boolean {
    return file.startsWith('.claude/worktrees/') || file.split('/').includes('dist');
}

function isLibraryDoc(file: string): boolean {
    if (isNoisePath(file) || !file.endsWith('.md')) {
        return false;
    }
    if (file === 'README.md' || file === 'APPENDIX.md') {
        return true;
    }
    if (file.startsWith('docs/internal/spec/') || file.startsWith('docs/internal/packets/')) {
        return false;
    }
    if (file.startsWith('docs/internal/archive/')) {
        return false;
    }
    if (file.startsWith('docs/')) {
        return true;
    }
    return /^packages\/[^/]+\/README\.md$/.test(file);
}

const libraryDocs: readonly Doc[] = gitLsFiles(['README.md', 'APPENDIX.md', 'docs', 'packages'])
    .filter(isLibraryDoc)
    .map((file) => ({ file, content: readFileSync(path.join(repoRoot, file), 'utf8') }));

/**
 * The two error-message texts the delta explicitly keeps ("Harness is closed."
 * and "Harness closed with N unsettled waiter(s).") are quoted verbatim in the
 * docs. Everything else that spells `Harness` is an API/type/prose name of the
 * lifecycle owner and must now read `Rig`.
 */
function stripPreservedErrorText(content: string): string {
    return content.replace(/Harness is closed/g, '').replace(/Harness closed with/g, '');
}

const formerIdentifiers = ['createHarness', 'HarnessRef', 'HarnessExpectations', 'CreateHarnessOptions'] as const;

function docsContaining(pattern: RegExp): readonly string[] {
    return libraryDocs.filter((doc) => pattern.test(doc.content)).map((doc) => doc.file);
}

describe('Scenario: docs name Rig, not Harness', () => {
    it('the library-doc corpus is non-empty', () => {
        expect(libraryDocs.length).toBeGreaterThan(0);
    });

    it.each(formerIdentifiers)('no library doc contains the identifier %s', (identifier) => {
        expect(docsContaining(new RegExp(`\\b${identifier}\\b`))).toEqual([]);
    });

    it('no library doc uses Harness as a name (the two kept error texts aside)', () => {
        const offenders = libraryDocs
            .filter((doc) => /\bHarness\b/.test(stripPreservedErrorText(doc.content)))
            .map((doc) => doc.file);
        expect(offenders).toEqual([]);
    });

    it('Design Rule 9 in docs/concepts.md reads rig.clock.advance', () => {
        const concepts = libraryDocs.find((doc) => doc.file === 'docs/concepts.md');
        expect(concepts, 'docs/concepts.md is missing from the library-doc corpus').toBeDefined();
        const rule9 = /^9\.[\s\S]*?(?=^10\.)/m.exec(concepts?.content ?? '');
        expect(rule9, 'could not locate Design Rule 9 in docs/concepts.md').not.toBeNull();
        expect(rule9?.[0]).toContain('rig.clock.advance');
        expect(rule9?.[0]).not.toContain('harness.clock.advance');
    });
});

describe('Scenario: the SQL options object still reads harness and driver', () => {
    it('docs mentioning createProbedSqlAdapter still name both harness and driver', () => {
        const sqlDocs = libraryDocs.filter((doc) => /\bcreateProbedSqlAdapter\b/.test(doc.content));
        expect(sqlDocs.length).toBeGreaterThan(0);
        const joined = sqlDocs.map((doc) => doc.content).join('\n');
        expect(/harness[\s\S]{0,80}driver|driver[\s\S]{0,80}harness/.test(joined)).toBe(true);
    });

    it('no library doc shows the positional createProbedSqlAdapter(driver, harness, …) form', () => {
        expect(docsContaining(/createProbedSqlAdapter\(\s*driver\s*,\s*harness/)).toEqual([]);
    });
});
