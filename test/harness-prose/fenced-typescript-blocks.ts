/**
 * Test-only extractor for fenced `typescript` / `ts` blocks.
 * Opening fences match CommonMark indent of 0–3 leading spaces plus a
 * typescript/ts info string. Closing fences are the same indent, backticks,
 * and optional trailing whitespace only (no info string).
 */
export function fencedTypescriptBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    const pattern = /^[ ]{0,3}```(?:typescript|ts)[^\n]*\n([\s\S]*?)^[ ]{0,3}```[ \t]*$/gm;
    let match: RegExpExecArray | null = pattern.exec(markdown);
    while (match !== null) {
        const body = match[1];
        if (body !== undefined) {
            blocks.push(body);
        }
        match = pattern.exec(markdown);
    }
    return blocks;
}

export function typescriptFenceDeclaresRig(block: string): boolean {
    return (
        /\b(?:const|let)\s+rig\b/.test(block) ||
        /\b(?:const|let)\s*\{[^}]*\brig\s*[,}=]/.test(block) ||
        /\b(?:const|let)\s*\[[^\]]*\brig\b/.test(block)
    );
}

export function typescriptFenceUsesRigIdentifier(block: string): boolean {
    return /\brig\b/.test(block);
}

export function typescriptFencesUsingUndeclaredRig(markdown: string): string[] {
    return fencedTypescriptBlocks(markdown)
        .filter(typescriptFenceUsesRigIdentifier)
        .filter((block) => !typescriptFenceDeclaresRig(block));
}
