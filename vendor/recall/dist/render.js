// MAL render: a cell's one-line mini-index and its full edge listing.
// Values use MAL notation field(value); a trailing ! marks an immutable field.
import { renderValue, quoteString } from "./address.js";
export function renderMiniIndexLine(cell, opts) {
    const lead = opts?.expand ? "^" : "";
    const { conf, effective, currency, salience } = cell.scores;
    return (`${lead}${cell.handle} ${quoteString(cell.title)} ` +
        `${renderValue("conf", conf, true)} ` +
        `${renderValue("eff", effective, false)} ` +
        `${renderValue("curr", currency, false)} ` +
        `${renderValue("sal", salience, false)} ` +
        `annexed(${bit(cell.flags.annexed)}) ` +
        `locked(${bit(cell.flags.locked)}) ` +
        `pinned(${bit(cell.flags.pinned)}) ` +
        `review(${bit(cell.flags.requiresReview)}) ` +
        `bg(${bit(cell.flags.allowBackgroundUse)}) ` +
        `[out:${cell.edgesOut.length} programs:${cell.programs?.length ?? 0}]`);
}
export function renderCell(cell) {
    const lines = [renderMiniIndexLine(cell)];
    for (const edge of cell.edgesOut) {
        lines.push(`${edge.relation}> ${edge.target}(${edge.weight})`);
    }
    return lines.join("\n");
}
function bit(value) {
    return value ? 1 : 0;
}
