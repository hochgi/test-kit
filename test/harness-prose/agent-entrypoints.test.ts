import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const glossaryTerms = [
    'Rig',
    'Adapter',
    'Probe',
    'Selection',
    'Filter',
    'Call',
    'Pending Call',
    'Backing',
    'Rule',
    'Settlement',
    'Porcelain',
    'Plumbing',
    'Goldilocks boundary',
    'Harness',
    'Blinker',
    'Packet',
] as const;

const layoutPaths = ['packages/', 'examples/', 'docs/', '.cursor/', '.claude/', '.opencode/', '.harness/'] as const;

const checkCommands = ['npm run check', 'npm run build', 'npm test'] as const;

const testingGotchas = ['pretest', 'dist', 'npm run check', 'husky', 'lefthook', 'Docker', 'mysql'] as const;

const specToShipPhases = ['spec-to-ship', 'spec-author', 'test-author', 'coder', 'reviewer', 'verifier'] as const;

const distinctiveModelIds = ['cursor-grok-4.6-xhigh', 'claude-opus-4-8', 'litellm/vn-'] as const;

const staleDraftMarkers = ['prettify', 'mock-aws-s3-v3', 'no Docker needed'] as const;

const claudeInventoryPaths = [
    '.claude/agents',
    '.claude/commands',
    '.claude/skills',
    '.cursor/skills',
    '.harness/models.json',
] as const;

const claudeDomainPins = [
    'createRig',
    'createHarness',
    'Goldilocks',
    'Pending Call',
    'once()',
    'always()',
    ...distinctiveModelIds,
] as const;

const glossaryForbiddenFenceLanguages = ['typescript', 'ts', 'bash', 'sh'] as const;

const renameAdrPath = 'docs/adr/0001-rename-the-lifecycle-owner-to-rig-and-ship-2-0-0.md';

type MarkdownHeading = {
    readonly level: number;
    readonly title: string;
    readonly lineIndex: number;
};

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readExisting(relative: string): string {
    const abs = path.join(repoRoot, relative);
    expect(existsSync(abs), `${relative} must exist`).toBe(true);
    return readUtf8(abs);
}

function gitLsFiles(pathspecs: readonly string[]): string[] {
    const listed = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return listed.split('\0').filter((file) => file !== '');
}

function hasTrackedRootFile(fileName: string): boolean {
    const abs = path.join(repoRoot, fileName);
    if (!existsSync(abs)) {
        return false;
    }
    return gitLsFiles([fileName]).includes(fileName);
}

function normalizeHeadingTitle(raw: string): string {
    return raw
        .replace(/\s*\{#[^}]+\}\s*$/, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/[*_`]/g, '')
        .trim();
}

function markdownHeadings(content: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = [];
    const lines = content.split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) {
            continue;
        }
        if (line.startsWith('```')) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            continue;
        }
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            headings.push({ level: match[1].length, title: normalizeHeadingTitle(match[2]), lineIndex: i });
        }
    }
    return headings;
}

function sectionBody(content: string, heading: MarkdownHeading, allHeadings: readonly MarkdownHeading[]): string {
    const lines = content.split('\n');
    const next = allHeadings.find(
        (candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level,
    );
    const end = next === undefined ? lines.length : next.lineIndex;
    return lines.slice(heading.lineIndex + 1, end).join('\n');
}

function sectionForTerm(content: string, term: string): string {
    const headings = markdownHeadings(content);
    const heading = headings.find((candidate) => candidate.title.toLowerCase() === term.toLowerCase());
    if (heading === undefined) {
        return '';
    }
    return sectionBody(content, heading, headings);
}

function avoidListFromSection(section: string): string {
    const marker = '_Avoid_:';
    const start = section.indexOf(marker);
    if (start === -1) {
        return '';
    }
    return section.slice(start + marker.length);
}

function definitionFromSection(section: string): string {
    const marker = '_Avoid_:';
    const start = section.indexOf(marker);
    const body = start === -1 ? section : section.slice(0, start);
    return body.trim();
}

function avoidListBodies(content: string): string[] {
    const parts = content.split('_Avoid_:');
    if (parts.length <= 1) {
        return [];
    }
    return parts.slice(1).map((part) => {
        const cut = part.search(/\n#{1,6}\s/);
        return (cut === -1 ? part : part.slice(0, cut)).trim();
    });
}

function fenceInfoStrings(markdown: string): string[] {
    const infos: string[] = [];
    const pattern = /^```([^\n]*)/gm;
    let match = pattern.exec(markdown);
    while (match !== null) {
        infos.push(match[1] ?? '');
        match = pattern.exec(markdown);
    }
    return infos;
}

function fenceLanguage(info: string): string {
    const token = info.trim().split(/\s+/)[0];
    return token === undefined ? '' : token.toLowerCase();
}

function hasForbiddenGlossaryFence(markdown: string): boolean {
    const forbidden = new Set<string>(glossaryForbiddenFenceLanguages);
    return fenceInfoStrings(markdown).some((info) => forbidden.has(fenceLanguage(info)));
}

function headingNamesTheme(headings: readonly MarkdownHeading[], pattern: RegExp): boolean {
    return headings.some((heading) => pattern.test(heading.title));
}

function expectContains(content: string, fragments: readonly string[], label: string): void {
    for (const fragment of fragments) {
        expect(content.includes(fragment), `${label} must contain ${fragment}`).toBe(true);
    }
}

function expectDoesNotContain(content: string, fragments: readonly string[], label: string): void {
    for (const fragment of fragments) {
        expect(content.includes(fragment), `${label} must not contain ${fragment}`).toBe(false);
    }
}

function namesGitRemoteVn(content: string): boolean {
    return /(?<![\w])vn(?!atures)(?![\w])/.test(content);
}

function omitsOrForbidsMergeOntoMainWhilePrOpen(content: string): boolean {
    if (/do not (?:squash-)?merge/i.test(content) || /not merge[\s\S]{0,80}until the PR is merged/i.test(content)) {
        return true;
    }
    return !/(?:squash-)?merge onto/i.test(content);
}

function omitsOrForbidsArchiveWhilePrOpen(content: string): boolean {
    if (
        /not archived on an open PR/i.test(content) ||
        /do not[\s\S]{0,80}archive/i.test(content) ||
        /do not[\s\S]{0,80}docs\/internal\/archive/i.test(content)
    ) {
        return true;
    }
    return !content.includes('docs/internal/archive/');
}

function stripYamlFrontmatter(content: string): string {
    const lines = content.split('\n');
    if (lines[0] !== '---') {
        return content;
    }
    const end = lines.indexOf('---', 1);
    if (end === -1) {
        return content;
    }
    return lines.slice(end + 1).join('\n');
}

function firstAtInclude(content: string): string | undefined {
    return content.match(/@[A-Za-z][\w./-]*/)?.[0];
}

describe('CONTEXT.md is a glossary of canonical terms', () => {
    it('CONTEXT.md exists at the repository root', () => {
        expect(hasTrackedRootFile('CONTEXT.md'), 'repository root must contain a tracked file named CONTEXT.md').toBe(
            true,
        );
    });

    it('every required term has a heading, a definition, and an Avoid list', () => {
        const content = readExisting('CONTEXT.md');
        for (const term of glossaryTerms) {
            const section = sectionForTerm(content, term);
            expect(section !== '', `${term} must appear as a markdown heading`).toBe(true);
            expect(definitionFromSection(section) !== '', `${term} heading must have a definition`).toBe(true);
            expect(section.includes('_Avoid_:'), `${term} section must contain _Avoid_:`).toBe(true);
        }
    });

    it('CONTEXT.md is a glossary only', () => {
        const content = readExisting('CONTEXT.md');
        expect(
            hasForbiddenGlossaryFence(content),
            'CONTEXT.md must not contain typescript, ts, bash, or sh fences',
        ).toBe(false);
        expectDoesNotContain(content, ['npm run', 'SHALL', 'TODO'], 'CONTEXT.md');
    });
});

describe('CONTEXT.md disambiguates Rule, Harness, and blinkers', () => {
    it('Rule and Blinker Avoid lists split the three meanings', () => {
        const content = readExisting('CONTEXT.md');
        const ruleAvoid = avoidListFromSection(sectionForTerm(content, 'Rule'));
        const blinkerAvoid = avoidListFromSection(sectionForTerm(content, 'Blinker'));
        expect(/blinker/i.test(ruleAvoid), "Rule's _Avoid_: list must name blinkers").toBe(true);
        expect(ruleAvoid.includes('Design Rules'), "Rule's _Avoid_: list must name Design Rules").toBe(true);
        expect(blinkerAvoid.includes('.cursor/rules/'), "Blinker's _Avoid_: list must mention .cursor/rules/").toBe(
            true,
        );
        expect(/rules/i.test(blinkerAvoid), "Blinker's _Avoid_: list must forbid calling those files rules").toBe(true);
    });

    it('Harness and Rig point at the ADR', () => {
        const content = readExisting('CONTEXT.md');
        const harness = sectionForTerm(content, 'Harness');
        const rig = sectionForTerm(content, 'Rig');
        expect(/agent pipeline/i.test(harness), 'Harness must be defined as the agent pipeline').toBe(true);
        expect(/lifecycle owner/i.test(rig), 'Rig must be defined as the lifecycle owner').toBe(true);
        expect(
            `${harness}\n${rig}`.includes(renameAdrPath),
            `Harness or Rig section must contain ${renameAdrPath}`,
        ).toBe(true);
        expect(avoidListFromSection(rig).includes('Harness'), "Rig's _Avoid_: list must include Harness").toBe(true);
        expect(
            /agent sense/i.test(`${harness}\n${rig}`),
            'Harness or Rig must say the industry word was kept for the agent sense',
        ).toBe(true);
    });

    it('Settlement Avoid list keeps the Design Rules verb', () => {
        const content = readExisting('CONTEXT.md');
        const settlementAvoid = avoidListFromSection(sectionForTerm(content, 'Settlement'));
        expectContains(settlementAvoid, ['return', 'reply', 'respond'], "Settlement's _Avoid_: list");
    });

    it('digest is not banned and createHarness is not current', () => {
        const content = readExisting('CONTEXT.md');
        for (const body of avoidListBodies(content)) {
            expect(/\bdigest\b/i.test(body), '_Avoid_: text must not list digest').toBe(false);
        }
        expect(content.includes('createHarness'), 'CONTEXT.md must not contain createHarness').toBe(false);
    });
});

describe('AGENTS.md is the tool-agnostic agent entrypoint', () => {
    it('AGENTS.md exists at the repository root', () => {
        expect(hasTrackedRootFile('AGENTS.md'), 'repository root must contain a tracked file named AGENTS.md').toBe(
            true,
        );
    });

    it('AGENTS.md has the required sections', () => {
        const content = readExisting('AGENTS.md');
        const headings = markdownHeadings(content);
        expect(headingNamesTheme(headings, /repo/i), 'AGENTS.md must have a heading that names the repo').toBe(true);
        expect(headingNamesTheme(headings, /layout/i), 'AGENTS.md must have a heading that names layout').toBe(true);
        expect(headingNamesTheme(headings, /commands/i), 'AGENTS.md must have a heading that names commands').toBe(
            true,
        );
        expect(headingNamesTheme(headings, /blinker/i), 'AGENTS.md must have a heading that names blinkers').toBe(true);
        expect(headingNamesTheme(headings, /testing/i), 'AGENTS.md must have a heading that names testing').toBe(true);
        expect(headingNamesTheme(headings, /workflow/i), 'AGENTS.md must have a heading that names workflow').toBe(
            true,
        );
        expect(
            headings.some((heading) => /model/i.test(heading.title) && /target/i.test(heading.title)),
            'AGENTS.md must have a heading that names model targeting',
        ).toBe(true);
        expect(content.includes('@vnatures/test-kit'), 'AGENTS.md must name the @vnatures/test-kit workspace').toBe(
            true,
        );
    });

    it('AGENTS.md names layout paths and check commands', () => {
        const content = readExisting('AGENTS.md');
        expectContains(content, layoutPaths, 'AGENTS.md');
        expectContains(content, checkCommands, 'AGENTS.md');
    });

    it('AGENTS.md carries the day-one testing gotchas', () => {
        const content = readExisting('AGENTS.md');
        expectContains(content, testingGotchas, 'AGENTS.md');
    });

    it('AGENTS.md states git conventions', () => {
        const content = readExisting('AGENTS.md');
        expect(namesGitRemoteVn(content), 'AGENTS.md must name the git remote vn as a token, not only vnatures').toBe(
            true,
        );
        expect(/\bmain\b/.test(content), 'AGENTS.md must contain main as a word').toBe(true);
        expectContains(content, ['origin', 'squash', 'RD-', 'Conventional Commits'], 'AGENTS.md');
    });

    it('AGENTS.md summarises spec-to-ship without merging an open PR', () => {
        const content = readExisting('AGENTS.md');
        expectContains(content, specToShipPhases, 'AGENTS.md');
        expect(
            omitsOrForbidsMergeOntoMainWhilePrOpen(content),
            'AGENTS.md must not instruct merging onto main while a PR is open',
        ).toBe(true);
        expect(
            omitsOrForbidsArchiveWhilePrOpen(content),
            'AGENTS.md must not instruct moving files into docs/internal/archive/ while a PR is open',
        ).toBe(true);
    });

    it('AGENTS.md defers model ids to the manifest', () => {
        const content = readExisting('AGENTS.md');
        expect(content.includes('.harness/models.json'), 'AGENTS.md must contain .harness/models.json').toBe(true);
        expectDoesNotContain(content, distinctiveModelIds, 'AGENTS.md');
    });

    it('AGENTS.md points at the glossary and blinkers', () => {
        const content = readExisting('AGENTS.md');
        expect(content.includes('CONTEXT.md'), 'AGENTS.md must contain CONTEXT.md').toBe(true);
        expect(/blinker/i.test(content), 'AGENTS.md must contain blinker').toBe(true);
        expect(content.includes('.cursor/rules/'), 'AGENTS.md must call .cursor/rules/ files blinkers').toBe(true);
    });

    it('AGENTS.md is not the stale remote-branch draft', () => {
        const content = readExisting('AGENTS.md');
        expectDoesNotContain(content, staleDraftMarkers, 'AGENTS.md');
    });
});

describe('CLAUDE.md is a thin Claude Code overlay', () => {
    it('CLAUDE.md exists at the repository root', () => {
        expect(hasTrackedRootFile('CLAUDE.md'), 'repository root must contain a tracked file named CLAUDE.md').toBe(
            true,
        );
    });

    it('CLAUDE.md starts from AGENTS.md', () => {
        const content = readExisting('CLAUDE.md');
        const body = stripYamlFrontmatter(content).trimStart();
        expect(body.startsWith('@AGENTS.md'), 'CLAUDE.md must open with @AGENTS.md').toBe(true);
        expect(firstAtInclude(body), 'CLAUDE.md must contain @AGENTS.md before any other @ include').toBe('@AGENTS.md');
    });

    it('CLAUDE.md inventories Claude assets and the canonical table', () => {
        const content = readExisting('CLAUDE.md');
        expectContains(content, claudeInventoryPaths, 'CLAUDE.md');
        expect(/canonical/i.test(content), 'CLAUDE.md must include a canonical-source table').toBe(true);
    });

    it('CLAUDE.md does not teach the library domain or pin models', () => {
        const content = readExisting('CLAUDE.md');
        expectDoesNotContain(content, claudeDomainPins, 'CLAUDE.md');
    });
});
