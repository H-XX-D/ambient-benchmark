const SUPABASE_URL = "https://nasxywilptctmfdbfpdw.supabase.co";
// This publishable browser key has only the read access allowed by Supabase RLS.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4yW4erGxjwGNYzzJ-0c3Yg_QsYsBYFH";
const SUPABASE_TABLE = "ambient_leaderboard_entries";
const SUPABASE_HOSTED_TABLE = "ambient_hosted_runs";
const tracks = ["architecture", "native-system"];

function formatDelta(value) {
  const number = Number(value) * 100;
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${number.toFixed(1)} pp`;
}

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatPoints(value) {
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(1)} pp`;
}

function publicEntry(row) {
  return {
    id: row.id,
    track: row.track,
    system: { name: row.system_name, version: row.system_version },
    corpus: row.corpus,
    submittedAt: row.submitted_at,
    result: {
      items: row.item_count,
      score: row.score,
      lower95: row.lower95,
      upper95: row.upper95,
      baseline: row.baseline,
      treatment: row.treatment,
    },
    controlKey: row.control_key,
    evidenceUrl: row.evidence_url,
  };
}

function rankedEntries(track, entries) {
  const sorted = entries
    .filter((entry) => entry.track === track)
    .sort((a, b) => {
      if (track === "architecture") {
        const cohort = String(a.controlKey).localeCompare(String(b.controlKey));
        if (cohort !== 0) return cohort;
      }
      return Number(b.result.score) - Number(a.result.score)
        || a.submittedAt.localeCompare(b.submittedAt);
    });

  let previousCohort = null;
  let cohortRank = 0;
  return sorted.map((entry, index) => {
    if (track === "architecture") {
      if (entry.controlKey !== previousCohort) cohortRank = 0;
      previousCohort = entry.controlKey;
      cohortRank += 1;
      return { ...entry, rank: cohortRank };
    }
    return { ...entry, rank: index + 1 };
  });
}

function renderTrack(track, entries) {
  const body = document.querySelector(`[data-board="${track}"]`);
  if (!body) return;
  body.replaceChildren();

  if (entries.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = track === "architecture" ? 11 : 9;
    cell.textContent = "No validated community submissions have been published for this track.";
    row.append(cell);
    body.append(row);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("tr");
    const values = track === "architecture"
      ? [
          `#${entry.rank}`,
          entry.system.name,
          entry.system.version,
          entry.corpus,
          String(entry.result.items),
          formatPercent(entry.result.baseline),
          formatPercent(entry.result.treatment),
          formatDelta(entry.result.score),
          `${formatDelta(entry.result.lower95)}–${formatDelta(entry.result.upper95)}`,
          entry.controlKey,
        ]
      : [
          `#${entry.rank}`,
          entry.system.name,
          entry.system.version,
          entry.corpus,
          String(entry.result.items),
          formatPercent(entry.result.score),
          `${formatPercent(entry.result.lower95)}–${formatPercent(entry.result.upper95)}`,
          entry.submittedAt.slice(0, 10),
        ];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 0 || (track === "architecture" && index === 7) || (track === "native-system" && index === 5)) cell.className = "score";
      row.append(cell);
    }
    const evidenceCell = document.createElement("td");
    const evidenceLink = document.createElement("a");
    evidenceLink.href = entry.evidenceUrl;
    evidenceLink.textContent = "Bundle";
    evidenceLink.rel = "noopener noreferrer";
    evidenceCell.append(evidenceLink);
    row.append(evidenceCell);
    body.append(row);
  }
}

function setBoardStatus(message) {
  for (const node of document.querySelectorAll("[data-board-status]")) node.textContent = message;
}

function setHostedStatus(message) {
  for (const node of document.querySelectorAll("[data-hosted-status]")) node.textContent = message;
}

function renderHostedRuns(rows) {
  const body = document.querySelector('[data-board="hosted"]');
  if (!body) return;
  body.replaceChildren();
  if (rows.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 11;
    cell.textContent = "No complete hosted runs have been recorded yet.";
    row.append(cell);
    body.append(row);
    return;
  }

  const ranked = [...rows].sort((a, b) =>
    String(a.control_key).localeCompare(String(b.control_key))
      || Number(b.score) - Number(a.score)
      || String(a.completed_at).localeCompare(String(b.completed_at)),
  );
  let cohort = null;
  let rank = 0;
  for (const entry of ranked) {
    if (entry.control_key !== cohort) rank = 0;
    cohort = entry.control_key;
    rank += 1;
    const row = document.createElement("tr");
    const values = [
      `#${rank}`,
      entry.memory_name,
      `${entry.reader_provider} / ${entry.reader_model}`,
      `${entry.judge_provider} / ${entry.judge_model}`,
      String(entry.item_count),
      `${Number(entry.baseline).toFixed(1)}%`,
      `${Number(entry.treatment).toFixed(1)}%`,
      formatPoints(entry.score),
      `${formatPoints(entry.lower95)}–${formatPoints(entry.upper95)}`,
      entry.control_key,
      String(entry.completed_at).slice(0, 10),
    ];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 0 || index === 7) cell.className = "score";
      row.append(cell);
    }
    body.append(row);
  }
}

async function loadLiveEntries() {
  const endpoint = new URL(`/rest/v1/${SUPABASE_TABLE}`, SUPABASE_URL);
  endpoint.searchParams.set("publication_status", "eq.verified");
  endpoint.searchParams.set("select", "id,track,system_name,system_version,corpus,item_count,score,lower95,upper95,baseline,treatment,control_key,submitted_at,evidence_url");
  endpoint.searchParams.set("limit", "500");
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
  });
  if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid leaderboard payload");
  return rows.map(publicEntry);
}

async function loadHostedRuns() {
  const endpoint = new URL(`/rest/v1/${SUPABASE_HOSTED_TABLE}`, SUPABASE_URL);
  endpoint.searchParams.set("publication_status", "eq.hosted");
  endpoint.searchParams.set("select", "id,memory_name,reader_provider,reader_model,judge_provider,judge_model,item_count,score,lower95,upper95,baseline,treatment,control_key,completed_at");
  endpoint.searchParams.set("limit", "500");
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: { Accept: "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid hosted-results payload");
  return rows;
}

async function loadRepositorySnapshot() {
  const response = await fetch("/data/leaderboard.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Repository snapshot returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.entries)) throw new Error("Repository snapshot is invalid");
  return payload.entries;
}

async function hydrateLeaderboard() {
  let entries;
  try {
    entries = await loadLiveEntries();
    setBoardStatus(`Live database · ${entries.length} verified submission${entries.length === 1 ? "" : "s"}.`);
    document.documentElement.dataset.leaderboardSource = "supabase";
  } catch (liveError) {
    try {
      entries = await loadRepositorySnapshot();
      setBoardStatus(`Live database unavailable · repository snapshot · ${entries.length} verified submission${entries.length === 1 ? "" : "s"}.`);
      document.documentElement.dataset.leaderboardSource = "repository";
    } catch {
      entries = [];
      setBoardStatus("Verified leaderboard data is temporarily unavailable.");
      document.documentElement.dataset.leaderboardSource = "unavailable";
    }
  }

  for (const track of tracks) renderTrack(track, rankedEntries(track, entries));

  try {
    const hostedRuns = await loadHostedRuns();
    renderHostedRuns(hostedRuns);
    setHostedStatus(`Live database · ${hostedRuns.length} complete hosted run${hostedRuns.length === 1 ? "" : "s"}.`);
  } catch {
    renderHostedRuns([]);
    setHostedStatus("Hosted results are temporarily unavailable.");
  }
}

hydrateLeaderboard();
