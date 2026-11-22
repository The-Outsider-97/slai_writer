export function tocCoverAnchor(blocks, sections) {
    const roles = new Map(sections.map((section) => [section.id, section.role]));
    const first = blocks[0];
    if (!first || roles.get(first.section ?? sections[0]?.id ?? "") !== "cover")
        return null;
    let after = null;
    for (const block of blocks) {
        if (roles.get(block.section ?? sections[0]?.id ?? "") !== "cover")
            break;
        after = block.id;
    }
    return after;
}
