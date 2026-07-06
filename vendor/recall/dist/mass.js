export function neighborMass(store, key) {
    let supportMass = 0;
    let challengeMass = 0;
    for (const link of store.neighbors(key)) {
        if (link.direction !== "in")
            continue; // evidence points at this cell
        const w = link.edge.weight; // signed: supports +, contradicts/concerns -
        const eff = link.cell.scores.effective;
        if (w > 0)
            supportMass += w * eff;
        else if (w < 0)
            challengeMass += -w * eff;
    }
    return { supportMass, challengeMass };
}
