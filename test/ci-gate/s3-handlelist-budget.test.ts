import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const backingRelativePath = 'packages/s3/src/s3-client/in-memory-backing.ts';
const dispatchJustification = 'existing function over the published budget; extract on next touch';

type DisableToken = 'eslint-disable' | 'eslint-disable-next-line' | 'eslint-disable-line';

type DisableDirective = {
    token: DisableToken;
    namedRules: string[];
    justification: string;
    nextFunction: string | undefined;
};

function readBackingSource(): string {
    return readFileSync(path.join(repoRoot, backingRelativePath), 'utf8');
}

function isDisableToken(token: string): token is DisableToken {
    return token === 'eslint-disable' || token === 'eslint-disable-next-line' || token === 'eslint-disable-line';
}

function parseDisablePayload(payload: string): { namedRules: string[]; justification: string } {
    const cleaned = payload.replace(/\*\/.*$/, '');
    const dash = cleaned.indexOf('--');
    const rulesPart = dash === -1 ? cleaned : cleaned.slice(0, dash);
    const justification = dash === -1 ? '' : cleaned.slice(dash + 2).trim();
    const namedRules = rulesPart
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
    return { namedRules, justification };
}

function parseDisableLine(
    line: string,
): { token: DisableToken; namedRules: string[]; justification: string } | undefined {
    const match = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?)\b(.*)$/.exec(line);
    const token = match?.[1];
    if (token === undefined || !isDisableToken(token)) {
        return undefined;
    }
    return { token, ...parseDisablePayload(match[2] ?? '') };
}

function isSkippableSourceLine(trimmed: string): boolean {
    return trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function functionNameOn(trimmed: string): string | undefined {
    const match = /(?:(?:private|public|protected|static|async|override)\s+)*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(
        trimmed,
    );
    return match?.[1];
}

function nextFunctionName(lines: readonly string[], afterIndex: number): string | undefined {
    for (let i = afterIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) {
            continue;
        }
        const trimmed = line.trim();
        if (isSkippableSourceLine(trimmed)) {
            continue;
        }
        return functionNameOn(trimmed);
    }
    return undefined;
}

function nextFunctionFor(
    token: DisableToken,
    line: string,
    lines: readonly string[],
    index: number,
): string | undefined {
    if (token === 'eslint-disable-line') {
        return functionNameOn(line);
    }
    return nextFunctionName(lines, index);
}

function disableDirectivesIn(source: string): DisableDirective[] {
    const lines = source.split('\n');
    const found: DisableDirective[] = [];
    for (const [index, line] of lines.entries()) {
        const parsed = parseDisableLine(line);
        if (parsed === undefined) {
            continue;
        }
        found.push({ ...parsed, nextFunction: nextFunctionFor(parsed.token, line, lines, index) });
    }
    return found;
}

function namesBudgetRule(namedRules: readonly string[]): boolean {
    return namedRules.includes('complexity') || namedRules.includes('max-lines-per-function');
}

function budgetDisablesOnHandleList(source: string): DisableDirective[] {
    return disableDirectivesIn(source).filter(
        (directive) => namesBudgetRule(directive.namedRules) && directive.nextFunction === 'handleList',
    );
}

function nextLineComplexityDisables(source: string): DisableDirective[] {
    return disableDirectivesIn(source).filter(
        (directive) => directive.token === 'eslint-disable-next-line' && directive.namedRules.includes('complexity'),
    );
}

describe('handleList meets the complexity budget without a disable', () => {
    it('the P10 handleList complexity disable is gone', () => {
        const source = readBackingSource();
        expect(source, `${backingRelativePath} must not contain P10 / RD-24151`).not.toContain('P10 / RD-24151');
        expect(
            budgetDisablesOnHandleList(source),
            'no complexity or max-lines-per-function disable may target handleList',
        ).toEqual([]);
    });

    it('the only remaining complexity disable in the backing is dispatch', () => {
        const remaining = nextLineComplexityDisables(readBackingSource());
        expect(
            remaining.map((directive) => directive.nextFunction),
            'exactly one next-line complexity disable remains, on dispatch',
        ).toEqual(['dispatch']);
        expect(remaining[0]?.justification).toContain(dispatchJustification);
    });
});
