// Fills the leaderboard from two sources: certified hosted runs and certified
// tripwire outcomes read live from Supabase, and static architecture/native
// submissions baked into /data/leaderboard.json by the site build.
//
// Every table fails visibly rather than silently: a table that cannot be read
// says so, and an empty table says it is empty. A blank board must never be
// mistaken for "no systems have been tested".
const SUPABASE_URL = "https://nasxywilptctmfdbfpdw.supabase.co";
// Publishable browser key. Supabase RLS limits it to gate-passed rows.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4yW4erGxjwGNYzzJ-0c3Yg_QsYsBYFH";

const TRIPWIRE_ABILITIES = {
  "abstention": "Abstention",
  "contradiction-resolution": "Contradiction resolution",
  "knowledge-update": "Knowledge update",
  "belief-revision-audit": "Belief-revision audit",
  "trust-discrimination": "Trust discrimination",
  "poisoned-memory-quarantine": "Poisoned-memory quarantine",
};

/**
 * Collapse per-ability tripwire rows into one row per system, ranked by
 * gullible rate ascending so the least-foolable system leads.
 *
 * Rows arrive one per (system, ability). The rate is recomputed here from raw
 * counts rather than read from a stored column, because a stored rate can be
 * written by whoever inserted the row while the counts are what the certifier
 * derived. Rows naming an ability that is not a tripwire are ignored outright.
 *
 * Exported for tests; the browser loads this file as a module.
 */
export function aggregateTripwires(rows, abilities = TRIPWIRE_ABILITIES) {
  const bySystem = new Map();
  for (const row of rows) {
    if (!abilities[row.ability]) continue;
    const key = `${row.memory_name}::${row.control_key ?? ""}`;
    const entry = bySystem.get(key) ?? {
      memory: row.memory_name, control: row.control_key, rows: 0, gullible: 0, worst: null, worstRate: -1,
    };
    const abilityRows = Number(row.rows) || 0;
    const abilityGullible = Number(row.gullible) || 0;
    entry.rows += abilityRows;
    entry.gullible += abilityGullible;
    const rate = abilityRows > 0 ? abilityGullible / abilityRows : 0;
    // Only a wire that actually tripped can be the worst one. Without the
    // rate > 0 guard a perfectly clean system would still name a wire, because
    // a rate of zero beats the initial sentinel.
    // Ties keep the first ability seen, so equal-rate ordering stays stable.
    if (abilityRows > 0 && rate > 0 && rate > entry.worstRate) {
      entry.worstRate = rate;
      entry.worst = abilities[row.ability];
    }
    bySystem.set(key, entry);
  }
  return [...bySystem.values()]
    .filter((entry) => entry.rows > 0)
    .sort((a, b) => (a.gullible / a.rows) - (b.gullible / b.rows));
}

const text = (value, fallback = "—") => {
  const output = value === 0 ? "0" : value;
  return output === null || output === undefined || output === "" ? fallback : String(output);
};

function points(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${(number * 100).toFixed(1)} pp` : "—";
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
}

function interval(lower, upper) {
  const a = Number(lower);
  const b = Number(upper);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  return `${(a * 100).toFixed(1)} to ${(b * 100).toFixed(1)}`;
}

function cell(value, className) {
  const td = document.createElement("td");
  td.textContent = value;
  if (className) td.className = className;
  return td;
}

function codeCell(value) {
  const td = document.createElement("td");
  const code = document.createElement("code");
  code.textContent = text(value);
  td.append(code);
  return td;
}

function linkCell(href, label) {
  const td = document.createElement("td");
  if (!href) {
    td.textContent = "—";
    return td;
  }
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  anchor.rel = "noreferrer";
  td.append(anchor);
  return td;
}

function body(board) {
  const table = document.querySelector(`[data-board="${board}"] table tbody`);
  return table ?? null;
}

function message(board, copy, columns) {
  const tbody = body(board);
  if (!tbody) return;
  tbody.replaceChildren();
  const row = document.createElement("tr");
  row.className = "empty-row";
  const td = document.createElement("td");
  td.colSpan = columns;
  td.textContent = copy;
  row.append(td);
  tbody.append(row);
}

function fill(board, rows, build, emptyCopy, columns) {
  const tbody = body(board);
  if (!tbody) return;
  if (!rows.length) {
    message(board, emptyCopy, columns);
    return;
  }
  tbody.replaceChildren();
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    for (const node of build(row, index + 1)) tr.append(node);
    tbody.append(tr);
  });
}

async function readTable(table, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { Accept: "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!response.ok) throw new Error(`${table} returned HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(`${table} returned an invalid payload`);
  return rows;
}

async function loadHostedRuns() {
  const query = new URLSearchParams({
    publication_status: "eq.hosted",
    select: "id,memory_name,reader_model,item_count,score,baseline,treatment,control_key,completed_at",
    order: "score.desc,completed_at.asc",
    limit: "100",
  });
  const rows = await readTable("ambient_hosted_runs", query);
  fill("hosted", rows, (row, rank) => [
    cell(`#${String(rank).padStart(2, "0")}`),
    cell(text(row.memory_name)),
    cell(points(row.score), "score"),
    cell(percent(row.baseline)),
    cell(percent(row.treatment)),
    codeCell(row.reader_model),
    codeCell(row.control_key),
    cell(text(String(row.completed_at ?? "").slice(0, 10))),
  ], "No certified hosted run yet. The first run to clear the certifier appears here.", 8);
  return rows.length;
}

// Tripwire outcomes are stored per system per ability, so the rate is computed
// here rather than trusted from a precomputed column.
async function loadTripwires() {
  const query = new URLSearchParams({
    publication_status: "eq.hosted",
    select: "memory_name,ability,rows,gullible,control_key",
    limit: "500",
  });
  let rows;
  try {
    rows = await readTable("ambient_tripwire_outcomes", query);
  } catch (error) {
    message("tripwire", "Certified tripwire outcomes are not available yet.", 6);
    return 0;
  }

  const ranked = aggregateTripwires(rows);

  fill("tripwire", ranked, (entry) => [
    cell(text(entry.memory)),
    cell(String(entry.rows)),
    cell(String(entry.gullible)),
    cell(percent(entry.gullible / entry.rows), entry.gullible === 0 ? "score" : ""),
    cell(entry.gullible === 0 ? "none tripped" : text(entry.worst)),
    codeCell(entry.control),
  ], "No certified tripwire outcomes yet.", 6);
  return ranked.length;
}

async function loadSubmissions() {
  let payload;
  try {
    const response = await fetch("/data/leaderboard.json");
    if (!response.ok) throw new Error(`leaderboard.json returned HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    message("architecture", "Validated submissions could not be read.", 9);
    message("native", "Validated submissions could not be read.", 8);
    return 0;
  }

  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const architecture = entries.filter((entry) => entry.track === "architecture");
  const native = entries.filter((entry) => entry.track === "native-system");

  fill("architecture", architecture, (entry, rank) => [
    cell(`#${String(rank).padStart(2, "0")}`),
    cell(text(entry.system?.name)),
    cell(text(entry.system?.version)),
    cell(text(entry.corpus)),
    cell(text(entry.result?.items)),
    cell(points(entry.result?.score), "score"),
    cell(interval(entry.result?.lower95, entry.result?.upper95)),
    codeCell(entry.controlKey),
    linkCell(entry.evidenceUrl, "Bundle"),
  ], "No architecture submission has passed the evidence gate yet.", 9);

  fill("native", native, (entry, rank) => [
    cell(`#${String(rank).padStart(2, "0")}`),
    cell(text(entry.system?.name)),
    cell(text(entry.system?.version)),
    cell(text(entry.corpus)),
    cell(text(entry.result?.items)),
    cell(percent(entry.result?.score), "score"),
    cell(interval(entry.result?.lower95, entry.result?.upper95)),
    linkCell(entry.evidenceUrl, "Bundle"),
  ], "No native-system submission has passed the evidence gate yet.", 8);

  return entries.length;
}

async function start() {
  const status = document.querySelector("[data-board-status]");
  const footer = document.querySelector("[data-board-footer]");

  const [hosted, tripwire, submissions] = await Promise.all([
    loadHostedRuns().catch(() => {
      message("hosted", "Certified hosted runs could not be read.", 8);
      return null;
    }),
    loadTripwires().catch(() => {
      message("tripwire", "Certified tripwire outcomes could not be read.", 6);
      return null;
    }),
    loadSubmissions().catch(() => null),
  ]);

  if (status) {
    if (hosted === null && submissions === null) {
      status.textContent = "Live results unavailable";
    } else {
      const total = (hosted ?? 0) + (submissions ?? 0);
      status.textContent = total === 0
        ? "Live database reachable · no certified rows yet"
        : `Live database reachable · ${total} certified row${total === 1 ? "" : "s"}`;
    }
  }
  if (footer && tripwire !== null) {
    footer.textContent = tripwire > 0
      ? "Integrity before ranking."
      : "Integrity before ranking. Tripwire outcomes publish with the first certified run.";
  }
}

// Only drive the DOM in a browser; tests import the pure aggregation above.
if (typeof document !== "undefined") start();
