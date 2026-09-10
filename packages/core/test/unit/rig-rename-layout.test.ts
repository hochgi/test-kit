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

/**
 * `docs/internal/archive/` is protected against being *rewritten* — it holds the
 * agent-sense harness history (P05) that this rename must not touch. But it is
 * also where the pipeline's own final step writes: every fold moves a packet and
 * its applied delta into a new dated directory there. Flagging additions would
 * make this guard fail the archive step it is supposed to coexist with, on this
 * fold and on every future one. So: additions under the archive are allowed,
 * modifications and deletions are not.
 *
 * Every other protected prefix stays strict, including additions, *when the
 * library-source diff renames vocabulary*. The spec scenario is "WHEN a change
 * renames library vocabulary THEN the agent-sense zone is untouched". P06 and
 * P09 write the harness zone on purpose; the live-branch check applies only
 * when the library-source diff (a package `src/` tree or `examples/`) renames
 * vocabulary, not on any src touch.
 */
const APPEND_ONLY_PREFIXES = ['docs/internal/archive/'] as const;

function isAppendOnly(file: string): boolean {
    return APPEND_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

type Touch = { readonly added: boolean; readonly file: string };

/**
 * A rename is an addition at its destination and a deletion at its source, so
 * the two sides must not share one status — treating both as "R" is what made
 * an archive move look like a rewrite of the archive. A copy, by contrast,
 * leaves its source untouched: only the destination is new, so the source must
 * not be recorded as a touch at all.
 *
 * `-z` paths are already NUL-delimited, so they are stored verbatim. Empty
 * fields (the trailing NUL) are dropped; whitespace and quotes are not.
 */
function pushPaths(out: Touch[], status: string, paths: readonly string[]): void {
    const files = paths.filter((file) => file !== '');
    if (files.length === 0) return;
    if (status.startsWith('R')) {
        // Last path is the destination; anything before it is the source.
        files.slice(0, -1).forEach((file) => out.push({ added: false, file }));
        out.push({ added: true, file: files[files.length - 1] });
        return;
    }
    if (status.startsWith('C')) {
        out.push({ added: true, file: files[files.length - 1] });
        return;
    }
    // Committed-diff output is exactly "A"; porcelain can yield "AM"/"AA" for an
    // added file with further unstaged or conflicting state, which is still an
    // addition.
    const added = status.startsWith('A') || status.startsWith('?');
    files.forEach((file) => out.push({ added, file }));
}

/**
 * `git diff --name-status -z -M` emits `STATUS\0path\0` records, a rename/copy
 * carrying its source right after the path: `R100\0old\0new\0` (source first,
 * destination second). NUL-delimited output never quotes or escapes paths, so
 * a filename containing " -> " or a tab cannot be misparsed.
 */
function pushDiffZ(out: Touch[], raw: string): void {
    const fields = raw.split('\0');
    let i = 0;
    while (i < fields.length) {
        const status = (fields[i] ?? '').trim();
        if (status === '') {
            i += 1;
            continue;
        }
        if (status.startsWith('R') || status.startsWith('C')) {
            pushPaths(out, status, [fields[i + 1] ?? '', fields[i + 2] ?? '']);
            i += 3;
        } else {
            pushPaths(out, status, [fields[i + 1] ?? '']);
            i += 2;
        }
    }
}

/**
 * `git status --porcelain -z` emits `XY path\0` records — the status and path
 * share one field, separated by a space. A rename/copy is
 * `XY destination\0source\0`: destination in the record, source as the next
 * field. As with diff, NUL delimiters mean no quoting and no " -> " ambiguity.
 */
function pushStatusZ(out: Touch[], raw: string): void {
    const fields = raw.split('\0');
    let i = 0;
    while (i < fields.length) {
        const record = fields[i] ?? '';
        if (record.length <= 3) {
            i += 1;
            continue;
        }
        const status = record.slice(0, 2).trim();
        const destination = record.slice(3);
        if (status.startsWith('R') || status.startsWith('C')) {
            pushPaths(out, status, [fields[i + 1] ?? '', destination]);
            i += 2;
        } else {
            pushPaths(out, status, [destination]);
            i += 1;
        }
    }
}

/** Touched paths, each tagged with whether it was newly added. */
function touchedEntries(base: string): readonly Touch[] {
    const out: Touch[] = [];
    pushDiffZ(out, git(['diff', '--name-status', '-z', '-M', base, 'HEAD']));
    pushStatusZ(out, git(['status', '--porcelain', '-z']));
    return out;
}

/**
 * Collapse multiple touches of the same path into one net classification.
 * A path is an addition when any touch for it is an addition; it is a
 * non-addition only when every touch is a non-addition.
 */
function coalesceByPath(touches: readonly Touch[]): readonly Touch[] {
    const addedByPath = new Map<string, boolean>();
    for (const { added, file } of touches) {
        addedByPath.set(file, (addedByPath.get(file) ?? false) || added);
    }
    return [...addedByPath].map(([file, added]) => ({ added, file }));
}

/** Pure classifier so the status handling above is testable without git. */
function offendingPathsFor(touches: readonly Touch[]): readonly string[] {
    const offenders = new Set<string>();
    for (const { added, file } of coalesceByPath(touches)) {
        if (!isProtected(file)) continue;
        // An addition into an append-only zone is the archive step, not a leak.
        if (isAppendOnly(file) && added) continue;
        offenders.add(file);
    }
    return [...offenders].sort();
}

function offendingPaths(base: string): readonly string[] {
    return offendingPathsFor(touchedEntries(base));
}

function isLibrarySourcePath(file: string): boolean {
    return (file.startsWith('packages/') && file.includes('/src/')) || file.startsWith('examples/');
}

/**
 * Path filter for the spec WHEN. P06 and P09 write the harness zone on purpose;
 * the live check applies only when the library-source diff renames vocabulary,
 * not on any src touch. A harness-only PR that never touches a package `src/`
 * tree or `examples/` still skips the check.
 */
function touchesLibrarySource(touches: readonly Touch[]): boolean {
    return touches.some(({ file }) => isLibrarySourcePath(file));
}

function isCommentRemainder(remainder: string): boolean {
    return remainder.startsWith('//') || remainder.startsWith('/*') || remainder.startsWith('*');
}

function isExportStatement(remainder: string): boolean {
    return remainder.startsWith('export ') || remainder.startsWith('export{') || remainder.startsWith('export*');
}

/** Pure classifier: one unified-diff minus line, including the leading `-`. */
function minusLineSignalsVocabularyRename(line: string): boolean {
    if (!line.startsWith('-') || line.startsWith('---')) {
        return false;
    }
    const remainder = line.slice(1).trim();
    if (remainder === '' || isCommentRemainder(remainder)) {
        return false;
    }
    return isExportStatement(remainder);
}

function unifiedDiffSignalsVocabularyRename(diff: string): boolean {
    return diff.split('\n').some(minusLineSignalsVocabularyRename);
}

function nameStatusSignalsVocabularyRename(raw: string): boolean {
    for (const line of raw.split('\n')) {
        if (line.startsWith('D') && isLibrarySourcePath(line.slice(1).trim())) {
            return true;
        }
        if (line.startsWith('R')) {
            const paths = line.split('\t').slice(1);
            if (paths.some((file) => isLibrarySourcePath(file))) {
                return true;
            }
        }
    }
    return false;
}

function librarySourcePaths(touches: readonly Touch[]): readonly string[] {
    return [...new Set(touches.map(({ file }) => file).filter(isLibrarySourcePath))];
}

function librarySourceDiffRenamesVocabulary(base: string, touches: readonly Touch[]): boolean {
    const files = librarySourcePaths(touches);
    if (files.length === 0) {
        return false;
    }
    const nameStatus = git(['diff', '--name-status', base, '--', 'packages', 'examples']);
    if (nameStatusSignalsVocabularyRename(nameStatus)) {
        return true;
    }
    return unifiedDiffSignalsVocabularyRename(git(['diff', '-U0', base, '--', ...files]));
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

// The classification above only bites if the checkout happens to contain the
// relevant status — regressions could pass silently otherwise. So exercise
// every branch with synthetic statuses, independent of the live checkout.
// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('guard classification', () => {
    it('a rename adds its destination and deletes its source', () => {
        const out: Touch[] = [];
        pushPaths(out, 'R100', [
            'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md',
            'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta-moved.md',
        ]);
        expect(out).toEqual([
            { added: false, file: 'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md' },
            { added: true, file: 'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta-moved.md' },
        ]);
        // Moving an archived file away deletes it — the destination is fine,
        // the vanished source is an offender.
        expect(offendingPathsFor(out)).toEqual(['docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md']);
    });

    it('a copy leaves its source untouched — only the destination is new', () => {
        const out: Touch[] = [];
        pushPaths(out, 'C', ['.harness/pipeline.json', '.harness/pipeline-copy.json']);
        expect(offendingPathsFor(out)).toEqual(['.harness/pipeline-copy.json']);
    });

    it('an archive addition is allowed, even with further unstaged edits (`AM`)', () => {
        const out: Touch[] = [];
        pushPaths(out, 'AM', ['docs/internal/archive/2027-01-01-P99-x/delta.md']);
        expect(out).toEqual([{ added: true, file: 'docs/internal/archive/2027-01-01-P99-x/delta.md' }]);
        expect(offendingPathsFor(out)).toEqual([]);
    });

    it('a committed archive addition with unstaged edits is still an addition', () => {
        const file = 'docs/internal/archive/2027-01-01-P99-x/delta.md';
        expect(
            offendingPathsFor([
                { added: true, file },
                { added: false, file },
            ]),
        ).toEqual([]);
    });

    it('repeated non-additions of an archive path still offend', () => {
        const file = 'docs/internal/archive/2027-01-01-P99-x/delta.md';
        expect(
            offendingPathsFor([
                { added: false, file },
                { added: false, file },
            ]),
        ).toEqual([file]);
    });

    it('an untracked file is an addition', () => {
        const out: Touch[] = [];
        pushPaths(out, '??', ['docs/internal/archive/2027-01-01-P99-x/packet.md']);
        expect(offendingPathsFor(out)).toEqual([]);
    });

    it('an archive modification or deletion is flagged', () => {
        expect(
            offendingPathsFor([{ added: false, file: 'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md' }]),
        ).toEqual(['docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md']);
    });

    it('an addition outside the archive is flagged even though it is new', () => {
        expect(offendingPathsFor([{ added: true, file: '.claude/skills/new-skill/SKILL.md' }])).toEqual([
            '.claude/skills/new-skill/SKILL.md',
        ]);
    });

    it('files outside every protected zone never offend', () => {
        expect(offendingPathsFor([{ added: false, file: 'packages/core/src/rig.ts' }])).toEqual([]);
    });

    it('a porcelain filename containing " -> " is one path, not a rename', () => {
        const out: Touch[] = [];
        pushStatusZ(out, '?? .claude/a -> b.md\0');
        expect(out).toEqual([{ added: true, file: '.claude/a -> b.md' }]);
        expect(offendingPathsFor(out)).toEqual(['.claude/a -> b.md']);
    });

    it('a porcelain -z rename record is destination, then source as the next field', () => {
        const out: Touch[] = [];
        pushStatusZ(out, 'R  docs/new.md\0docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md\0');
        expect(out).toEqual([
            { added: false, file: 'docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md' },
            { added: true, file: 'docs/new.md' },
        ]);
        expect(offendingPathsFor(out)).toEqual(['docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md']);
    });

    it('a diff -z rename record is source, then destination', () => {
        const out: Touch[] = [];
        pushDiffZ(out, 'R100\0docs/old.md\0docs/new.md\0');
        expect(out).toEqual([
            { added: false, file: 'docs/old.md' },
            { added: true, file: 'docs/new.md' },
        ]);
    });

    it('diff -z plain records parse one path each, " -> " included', () => {
        const out: Touch[] = [];
        pushDiffZ(out, 'A\0.claude/x -> y.md\0M\0docs/README.md\0');
        expect(out).toEqual([
            { added: true, file: '.claude/x -> y.md' },
            { added: false, file: 'docs/README.md' },
        ]);
    });

    it('a -z path with leading or trailing whitespace is kept via porcelain', () => {
        const out: Touch[] = [];
        pushStatusZ(out, '??  leading.md\0');
        expect(out).toEqual([{ added: true, file: ' leading.md' }]);
    });

    it('a -z path with leading or trailing whitespace is kept via diff', () => {
        const out: Touch[] = [];
        pushDiffZ(out, 'A\0trailing.md \0');
        expect(out).toEqual([{ added: true, file: 'trailing.md ' }]);
    });

    it('a -z path with boundary quotes is kept via porcelain', () => {
        const out: Touch[] = [];
        pushStatusZ(out, '?? "quoted.md"\0');
        expect(out).toEqual([{ added: true, file: '"quoted.md"' }]);
    });

    it('a -z path with boundary quotes is kept via diff', () => {
        const out: Touch[] = [];
        pushDiffZ(out, 'A\0"quoted.md"\0');
        expect(out).toEqual([{ added: true, file: '"quoted.md"' }]);
    });
});

describe('library-vocabulary rename classifier', () => {
    it('comment-only and import-only src diffs are not a library-vocabulary rename', () => {
        expect(
            minusLineSignalsVocabularyRename('-// eslint-disable-next-line complexity -- existing function...'),
        ).toBe(false);
        expect(
            minusLineSignalsVocabularyRename(
                "-import { Sequelize, type Options as SequelizeOptions } from 'sequelize';",
            ),
        ).toBe(false);
        expect(minusLineSignalsVocabularyRename('-    return this.handleList(input);')).toBe(false);
        expect(minusLineSignalsVocabularyRename('-export function createHarness(...)')).toBe(true);
        expect(minusLineSignalsVocabularyRename("-export { createRig } from './rig';")).toBe(true);
        expect(minusLineSignalsVocabularyRename("-export * from './types';")).toBe(true);
    });

    it('a content-free library-source rename is a vocabulary rename', () => {
        expect(nameStatusSignalsVocabularyRename('R100\tpackages/core/src/harness.ts\tpackages/core/src/rig.ts')).toBe(
            true,
        );
        expect(nameStatusSignalsVocabularyRename('D\tpackages/core/src/harness.ts')).toBe(true);
        expect(nameStatusSignalsVocabularyRename('M\tpackages/core/src/rig.ts')).toBe(false);
    });
});

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
        const touches = touchedEntries(base);
        const pathHit = touchesLibrarySource(touches);
        if (!pathHit) {
            expect(pathHit).toBe(false);
            return;
        }
        const renamed = librarySourceDiffRenamesVocabulary(base, touches);
        if (!renamed) {
            expect(renamed).toBe(false);
            return;
        }
        expect(offendingPaths(base)).toEqual([]);
    });
});
