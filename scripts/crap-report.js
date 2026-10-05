#!/usr/bin/env node
// CRAP (Change Risk Anti-Patterns) score report, per function.
//
//   CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
//
// where comp = cyclomatic complexity and cov = statement coverage in [0, 1].
// The cubed coverage term means a complex function is "rescued" only by being
// thoroughly tested; a complex AND poorly-covered function scores explosively.
// The conventional "crappy" cutoff is 30.
//
// Complexity is read from the TypeScript AST (one decision point per
// if / ternary / for / while / do / case / catch / && / || / ??, plus a base of
// 1). Nested functions are scored as their own entries, not folded into the
// parent. Coverage comes from Istanbul's `coverage-final.json` (`statementMap`,
// collected via vitest.mutation.config.ts so keys are packages/*/src).
//
// Inputs (env):
//   COVERAGE_JSON     path to coverage-final.json (default coverage/coverage-final.json)
//   CRAP_THRESHOLD    "crappy" cutoff (default 30)
//   CRAP_MAX_ROWS     max table rows (default 40)
//   CRAP_FAIL         when "1", exit 1 if any flagged function exceeds a threshold
//                     (unset by default — not a CI/pre-push gate)
//   CRAP_FILES        comma/newline list of relative paths to score (optional)
//   CRAP_PATCH_BASE   git ref to diff against (e.g. merge-base with origin/main). When
//                     set, only functions whose line range overlaps the patch are
//                     flagged as new violations. Untracked files are treated as
//                     fully new.
//   HOTSPOT_MAX_LINES     new-function LOC flag (default 40; hotspot-expansion-review)
//   HOTSPOT_MAX_NESTING   new-function nesting flag (default 2)
//   CRAP_LOCAL_COMMAND    re-run hint (default `npm run crap`)
//
// Output: Markdown to stdout.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const COVERAGE_JSON = process.env.COVERAGE_JSON ?? 'coverage/coverage-final.json';
const LOCAL_COMMAND = process.env.CRAP_LOCAL_COMMAND ?? 'npm run crap:changed';
const FAIL_OVER = process.env.CRAP_FAIL === '1';
const MAX_COMMENT_BYTES = 60_000;
const ROOT = process.cwd();

function die(reason) {
    console.log(`### CRAP score report\n\n` + `:rotating_light: ${reason}\n\n` + `Re-run: \`${LOCAL_COMMAND}\`.`);
    process.exit(1);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        die(`Invalid ${name}=${JSON.stringify(raw)}; expected an integer in [${min}, ${max}].`);
    }
    return n;
}

const THRESHOLD = envInt('CRAP_THRESHOLD', 30, 0, Number.MAX_SAFE_INTEGER);
const MAX_ROWS = envInt('CRAP_MAX_ROWS', 40, 1, Number.MAX_SAFE_INTEGER);
const HOTSPOT_MAX_LINES = envInt('HOTSPOT_MAX_LINES', 40, 1, Number.MAX_SAFE_INTEGER);
const HOTSPOT_MAX_NESTING = envInt('HOTSPOT_MAX_NESTING', 2, 0, Number.MAX_SAFE_INTEGER);

function posixRel(absOrRel) {
    const abs = path.isAbsolute(absOrRel) ? absOrRel : path.resolve(ROOT, absOrRel);
    return path.relative(ROOT, abs).split(path.sep).join('/');
}

function parseFileList(raw) {
    if (!raw || !raw.trim()) return [];
    return raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => posixRel(s));
}

function isTestPath(relPosix) {
    return relPosix.startsWith('test/') || relPosix.includes('/test/') || /\.(test|spec)\.tsx?$/.test(relPosix);
}

function isProductionSrc(relPosix) {
    return (
        /^packages\/[^/]+\/src\//.test(relPosix) &&
        (relPosix.endsWith('.ts') || relPosix.endsWith('.tsx')) &&
        !relPosix.endsWith('.d.ts') &&
        !isTestPath(relPosix)
    );
}

function parseUnifiedDiffRanges(diffText) {
    const ranges = new Map();
    let currentFile = null;
    for (const line of diffText.split('\n')) {
        const plusPlus = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
        if (plusPlus) {
            currentFile = plusPlus[1] === '/dev/null' ? null : posixRel(plusPlus[1]);
            continue;
        }
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!hunk || !currentFile) continue;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        // `+N,0` is a deletion-only hunk. Keep a point range so functions that
        // only shrank still overlap the patch.
        const end = count === 0 ? start : start + count - 1;
        const list = ranges.get(currentFile) ?? [];
        list.push({ start, end });
        ranges.set(currentFile, list);
    }
    return ranges;
}

function git(args) {
    const result = spawnSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        const reason = result.error ? result.error.message : (result.stderr ?? '');
        return { ok: false, stdout: result.stdout ?? '', stderr: reason };
    }
    return { ok: true, stdout: result.stdout ?? '' };
}

function loadPatchRanges(patchBase) {
    // Diff the whole `packages/` tree, then keep production src. A git pathspec
    // of `packages/*/src/**/*.ts` without `:(glob)` does not match files
    // directly under `packages/<name>/src/`.
    const diff = git(['diff', '-U0', '--no-color', patchBase, '--', 'packages']);
    if (!diff.ok) {
        die(`git diff against ${patchBase} failed: ${diff.stderr.trim() || 'unknown error'}`);
    }
    const ranges = parseUnifiedDiffRanges(diff.stdout);
    for (const file of [...ranges.keys()]) {
        if (!isProductionSrc(file)) {
            ranges.delete(file);
        }
    }

    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'packages']);
    if (!untracked.ok) {
        die(`git ls-files failed: ${untracked.stderr.trim() || 'unknown error'}`);
    }
    for (const file of untracked.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const rel = posixRel(file);
        if (!isProductionSrc(rel)) continue;
        // Untracked file: every line is new.
        ranges.set(rel, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
    }
    return ranges;
}

function overlapsPatch(fn, patchRanges) {
    if (!patchRanges) return true;
    const fileRanges = patchRanges.get(fn.file);
    if (!fileRanges) return false;
    return fileRanges.some((r) => fn.startLine <= r.end && fn.endLine >= r.start);
}

const CRAP_FILES = parseFileList(process.env.CRAP_FILES ?? '');
const PATCH_BASE = process.env.CRAP_PATCH_BASE?.trim() || '';
const patchRanges = PATCH_BASE ? loadPatchRanges(PATCH_BASE) : null;

let coverage = {};
if (fs.existsSync(COVERAGE_JSON)) {
    try {
        coverage = JSON.parse(fs.readFileSync(COVERAGE_JSON, 'utf8'));
    } catch (err) {
        die(`Failed to parse \`${COVERAGE_JSON}\`: ${err.message}`);
    }
    if (!isPlainObject(coverage)) {
        die(`Coverage report at \`${COVERAGE_JSON}\` is not a JSON object.`);
    }
} else {
    die(
        `No coverage report at \`${COVERAGE_JSON}\`. Run \`npm run crap\` ` +
            `(or \`vitest run --config vitest.mutation.config.ts --coverage --coverage.provider istanbul\`) first.`,
    );
}

const coverageByRel = new Map();
for (const [covPath, fileCov] of Object.entries(coverage)) {
    if (typeof covPath !== 'string' || !isPlainObject(fileCov)) continue;
    coverageByRel.set(posixRel(covPath), fileCov);
}

const fileSet = new Set();
if (CRAP_FILES.length > 0) {
    for (const f of CRAP_FILES) fileSet.add(f);
} else if (patchRanges) {
    for (const f of patchRanges.keys()) fileSet.add(f);
} else {
    for (const f of coverageByRel.keys()) fileSet.add(f);
}

const DECISION_KINDS = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ConditionalExpression,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.CatchClause,
]);

const LOGICAL_OPS = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
]);

const NESTING_KINDS = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.CatchClause,
]);

function isFunctionLike(node) {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node)
    );
}

function functionName(node) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    const p = node.parent;
    if (p && ts.isVariableDeclaration(p) && p.name && ts.isIdentifier(p.name)) {
        return p.name.text;
    }
    if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name && ts.isIdentifier(p.name)) {
        return p.name.text;
    }
    return '<anonymous>';
}

function complexityOf(fnNode) {
    let count = 1;
    const visit = (node) => {
        if (node !== fnNode && isFunctionLike(node)) return;
        if (DECISION_KINDS.has(node.kind)) count += 1;
        if (ts.isBinaryExpression(node) && LOGICAL_OPS.has(node.operatorToken.kind)) {
            count += 1;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fnNode, visit);
    return count;
}

function maxNestingOf(fnNode) {
    let max = 0;
    const visit = (node, depth) => {
        if (node !== fnNode && isFunctionLike(node)) return;
        let next = depth;
        if (node !== fnNode && NESTING_KINDS.has(node.kind)) {
            next = depth + 1;
            if (next > max) max = next;
        }
        ts.forEachChild(node, (child) => visit(child, next));
    };
    ts.forEachChild(fnNode, (child) => visit(child, 0));
    return max;
}

function childFunctionLineRanges(sf, fnNode) {
    const ranges = [];
    const visit = (node) => {
        if (node !== fnNode && isFunctionLike(node)) {
            ranges.push({
                start: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                end: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            });
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fnNode, visit);
    return ranges;
}

function lineIsExcluded(line, excludedRanges) {
    return excludedRanges.some((r) => line >= r.start && line <= r.end);
}

function exclusiveLineCount(startLine, endLine, excludedRanges) {
    let count = 0;
    for (let line = startLine; line <= endLine; line++) {
        if (!lineIsExcluded(line, excludedRanges)) count += 1;
    }
    return count;
}

function statementCoverageForRange(fileCov, startLine, endLine, excludedRanges = []) {
    if (!fileCov) return 0;
    const statementMap = fileCov.statementMap ?? {};
    const hits = fileCov.s ?? {};
    let total = 0;
    let covered = 0;
    for (const id of Object.keys(statementMap)) {
        const line = statementMap[id]?.start?.line;
        if (typeof line !== 'number' || line < startLine || line > endLine) continue;
        if (lineIsExcluded(line, excludedRanges)) continue;
        total += 1;
        if ((hits[id] ?? 0) > 0) covered += 1;
    }
    // No instrumented statements → treat as fully covered so a 0/0 cannot alarm.
    return total === 0 ? 1 : covered / total;
}

const functions = [];
for (const rel of fileSet) {
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;
    if (rel.endsWith('.d.ts') || isTestPath(rel)) continue;
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;

    const source = fs.readFileSync(abs, 'utf8');
    const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);
    const fileCov = coverageByRel.get(rel);

    const walk = (node) => {
        if (isFunctionLike(node)) {
            const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
            const complexity = complexityOf(node);
            const nesting = maxNestingOf(node);
            const nestedRanges = childFunctionLineRanges(sf, node);
            const lines = exclusiveLineCount(startLine, endLine, nestedRanges);
            const cov = statementCoverageForRange(fileCov, startLine, endLine, nestedRanges);
            const crap = complexity * complexity * Math.pow(1 - cov, 3) + complexity;
            functions.push({
                file: rel,
                name: functionName(node),
                startLine,
                endLine,
                lines,
                complexity,
                nesting,
                cov,
                crap,
            });
        }
        ts.forEachChild(node, walk);
    };
    walk(sf);
}

if (functions.length === 0) {
    console.log(
        '### CRAP score report\n\n' +
            'No functions to score (changed files had no function-like nodes — ' +
            'types, constants, or enums only).\n\n' +
            `Re-run: \`${LOCAL_COMMAND}\`.`,
    );
    process.exit(0);
}

const scored = patchRanges ? functions.filter((f) => overlapsPatch(f, patchRanges)) : functions;
const pool = scored.length > 0 || !patchRanges ? scored : [];

const overCrap = [...pool].filter((f) => f.crap > THRESHOLD).sort((a, b) => b.crap - a.crap);
const overHotspot = [...pool]
    .filter((f) => f.lines > HOTSPOT_MAX_LINES || f.nesting > HOTSPOT_MAX_NESTING)
    .sort((a, b) => b.lines - a.lines || b.nesting - a.nesting);

function sanitizeCell(value) {
    return String(value ?? '')
        .replace(/`/g, "'")
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
}

function fmtRow(f) {
    const name = sanitizeCell(f.name).slice(0, 40);
    const location = sanitizeCell(`${f.file}:${f.startLine}`);
    return (
        `| ${f.crap.toFixed(1)} | ${f.complexity} | ${f.nesting} | ${(f.cov * 100).toFixed(0)}% | ${f.lines} | ` +
        `\`${name}\` | \`${location}\` |`
    );
}

const header = '| CRAP | Cx | Nest | Cov | LOC | Function | Location |';
const divider = '|---:|---:|---:|---:|---:|---|---|';

const lines = [];
lines.push('### CRAP score report');
lines.push('');
const scopeNote = PATCH_BASE
    ? `Patch-overlapping functions vs \`${PATCH_BASE}\` only (${pool.length} of ${functions.length} scored).`
    : CRAP_FILES.length > 0
      ? `Scoped to ${CRAP_FILES.length} file(s) via \`CRAP_FILES\`.`
      : 'Full coverage report (no patch filter).';
lines.push(scopeNote);
lines.push('');
lines.push(
    `**${overCrap.length} over CRAP ${THRESHOLD}** · **${overHotspot.length} over hotspot ` +
        `(LOC > ${HOTSPOT_MAX_LINES} or nesting > ${HOTSPOT_MAX_NESTING})** ` +
        `(of ${pool.length} functions in scope). CRAP = complexity² · (1 − coverage)³ + complexity.`,
);
lines.push('');
lines.push(
    '> Flag **new** violations only: functions whose line range overlaps the patch. ' +
        '**CRAP** catches complex code the tests do not cover. **Hotspot** (LOC / nesting) ' +
        'follows `hotspot-expansion-review` — extract regardless of coverage.',
);
lines.push('');

lines.push(`#### Over CRAP ${THRESHOLD} — complex and under-tested`);
lines.push('');
if (overCrap.length === 0) {
    lines.push('none.');
} else {
    lines.push(header);
    lines.push(divider);
    for (const f of overCrap.slice(0, MAX_ROWS)) lines.push(fmtRow(f));
    if (overCrap.length > MAX_ROWS) lines.push(`\n… and ${overCrap.length - MAX_ROWS} more.`);
}
lines.push('');

lines.push(`#### Over hotspot (LOC > ${HOTSPOT_MAX_LINES} or nesting > ${HOTSPOT_MAX_NESTING}) — extract`);
lines.push('');
if (overHotspot.length === 0) {
    lines.push('none.');
} else {
    lines.push(header);
    lines.push(divider);
    for (const f of overHotspot.slice(0, MAX_ROWS)) lines.push(fmtRow(f));
    if (overHotspot.length > MAX_ROWS) {
        lines.push(`\n… and ${overHotspot.length - MAX_ROWS} more.`);
    }
}
lines.push('');
lines.push(
    `<sub>Lower CRAP by adding tests or extracting; lower hotspot by extracting. ` +
        `Not a CI/pre-push gate. Guidance: \`hotspot-expansion-review\`, \`verify-changes\`. ` +
        `Re-run: \`${LOCAL_COMMAND}\` or \`npm run crap:changed\`.</sub>`,
);

let output = lines.join('\n');
if (output.length > MAX_COMMENT_BYTES) {
    output = output.slice(0, MAX_COMMENT_BYTES - 200) + '\n\n… (truncated).';
}
console.log(output);

if (FAIL_OVER && (overCrap.length > 0 || overHotspot.length > 0)) {
    process.exit(1);
}
