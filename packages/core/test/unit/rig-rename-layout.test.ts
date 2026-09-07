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
 * branch also touches published library source*. The spec scenario is "WHEN a
 * change renames library vocabulary THEN the agent-sense zone is untouched".
 * P06 writes that zone on purpose and does not rename library vocabulary, so
 * the live-branch check applies only alongside a package src or examples/
 * touch — the conscious act this comment asked for.
 */
const APPEND_ONLY_PREFIXES = ['docs/internal/archive/'] as const;

function isAppendOnly(file: string): boolean {
    return APPEND_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

type Touch = { readonly added: boolean; readonly file: string };

function clean(file: string): string {
    return file.trim().replace(/^"|"$/g, '');
}

/**
 * A rename is an addition at its destination and a deletion at its source, so
 * the two sides must not share one status — treating both as "R" is what made
 * an archive move look like a rewrite of the archive. A copy, by contrast,
 * leaves its source untouched: only the destination is new, so the source must
 * not be recorded as a touch at all.
 */
function pushPaths(out: Touch[], status: string, paths: readonly string[]): void {
    const files = paths.map(clean).filter((file) => file !== '');
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

/** Pure classifier so the status handling above is testable without git. */
function offendingPathsFor(touches: readonly Touch[]): readonly string[] {
    const offenders = new Set<string>();
    for (const { added, file } of touches) {
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

/** Spec WHEN: a library-vocabulary rename lives under published source. */
function touchesLibrarySource(touches: readonly Touch[]): boolean {
    return touches.some(
        ({ file }) => (file.startsWith('packages/') && file.includes('/src/')) || file.startsWith('examples/'),
    );
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
        if (!touchesLibrarySource(touches)) {
            expect(touchesLibrarySource(touches)).toBe(false);
            return;
        }
        expect(offendingPaths(base)).toEqual([]);
    });
});
