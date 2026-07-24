#!/usr/bin/env node
// AMBIENT - model-mediated graph QA (local 3B, two phase).
//
// A local 3B instruct model drives a two phase pipeline over a small
// deterministic fixture of multi turn conversations. Each item states a fact
// that is later UPDATED (a value flip); a few distractor items never update, so
// the gold answer stays the original value.
//
//   PHASE 1 (build, model A): for each turn, the model extracts a strict JSON
//   fact {attr, value, updates_prior}. Each fact is admitted into a per item
//   Recall SqliteStore. When updates_prior is true, a real `supersedes` edge is
//   added to the prior cell for that attr (same edge shaping ambient-bench.mjs
//   uses), which flips the prior cell to status "superseded". This is agent 1
//   building the memory graph.
//
//   PHASE 2 (answer, model B): a FRESH model call with no build phase memory.
//   The relevant cells for the question's attr are retrieved from the store
//   (active, i.e. latest non superseded), formatted as context, and the model
//   answers from ONLY that context, returning {answer}.
//
// Grading is NOT done here. The harness writes {id, question, gold,
// model_answer, retrieved_values, built_cells, built_edges} per item to a JSON
// file for the orchestrator to grade.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit } from "./_recall.mjs";

// ------------------------------------------------------------------ config
const PORT = Number(process.env.MLX_PORT || 8081);
const MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit";
const ENDPOINT = `http://localhost:${PORT}/v1/chat/completions`;
const MAX_TOKENS = 64;
const TEMP = 0.0;
const OUT_PATH =
  process.env.GRAPH_QA_OUT ||
  "/Users/hendrixx./.claude/jobs/5dd65020/tmp/graph-qa-answers.json";

// ------------------------------------------------------------------ fixture
// 12 items authored inline, no RNG. `updateTurn` is the index of the turn that
// actually flips the value (null for distractors). `attr` is the canonical
// retrieval label for the question; it is NOT shown to the extractor and never
// fed as the answer. `type` is "update" (gold = new value) or "distractor"
// (gold = original value).
const FIXTURE = [
  {
    id: "database",
    attr: "database",
    type: "update",
    turns: [
      "For the main app the primary database is Postgres.",
      "We spent the week cleaning up old unused tables.",
      "Actually we migrated the main database to MySQL last week.",
    ],
    updateTurn: 2,
    question: "What database does the main app use now?",
    gold: "MySQL",
  },
  {
    id: "editor",
    attr: "editor",
    type: "update",
    turns: [
      "My default code editor is Vim.",
      "I switched my default code editor to VS Code yesterday.",
    ],
    updateTurn: 1,
    question: "What is my default code editor now?",
    gold: "VS Code",
  },
  {
    id: "deploy",
    attr: "deployment",
    type: "update",
    turns: [
      "We deploy the service to Heroku.",
      "We moved our deployment to AWS this month.",
    ],
    updateTurn: 1,
    question: "Where do we deploy the service now?",
    gold: "AWS",
  },
  {
    id: "phone",
    attr: "phone number",
    type: "update",
    turns: [
      "My contact phone number is 555-0101.",
      "My new phone number is 555-0199.",
    ],
    updateTurn: 1,
    question: "What is my current phone number?",
    gold: "555-0199",
  },
  {
    id: "lead",
    attr: "project lead",
    type: "update",
    turns: [
      "Alice is the project lead.",
      "Bob has taken over as the project lead.",
    ],
    updateTurn: 1,
    question: "Who is the project lead now?",
    gold: "Bob",
  },
  {
    id: "office",
    attr: "office location",
    type: "update",
    turns: [
      "Our main office is in Boston.",
      "We relocated our main office to Austin.",
    ],
    updateTurn: 1,
    question: "Where is our main office now?",
    gold: "Austin",
  },
  {
    id: "standup",
    attr: "standup day",
    type: "update",
    turns: [
      "Our daily standup is on Monday.",
      "We moved the daily standup to Wednesday.",
    ],
    updateTurn: 1,
    question: "What day is our daily standup on now?",
    gold: "Wednesday",
  },
  {
    id: "language",
    attr: "backend language",
    type: "update",
    turns: [
      "The backend service is written in Python.",
      "We rewrote the backend service in Go.",
    ],
    updateTurn: 1,
    question: "What language is the backend service written in now?",
    gold: "Go",
  },
  {
    id: "coffee",
    attr: "coffee",
    type: "distractor",
    turns: [
      "I always drink my coffee black.",
      "Yes, still black, thanks.",
    ],
    updateTurn: null,
    question: "How do I take my coffee?",
    gold: "black",
  },
  {
    id: "timezone",
    attr: "timezone",
    type: "distractor",
    turns: [
      "I work in the Pacific timezone.",
      "Meetings are easiest for me in the morning.",
    ],
    updateTurn: null,
    question: "What timezone do I work in?",
    gold: "Pacific",
  },
  {
    id: "frontend",
    attr: "frontend framework",
    type: "distractor",
    turns: [
      "Our frontend is built with React.",
      "The frontend team is hiring two more engineers.",
    ],
    updateTurn: null,
    question: "What framework is our frontend built with?",
    gold: "React",
  },
  {
    id: "pet",
    attr: "dog name",
    type: "distractor",
    turns: [
      "I have a dog named Rex.",
      "Rex loves going to the park every weekend.",
    ],
    updateTurn: null,
    question: "What is the name of my dog?",
    gold: "Rex",
  },
];

// ------------------------------------------------------------------ model IO
// Aggregate generation stats so the report can quote tokens/sec.
const stats = { calls: 0, completionTokens: 0, promptTokens: 0, seconds: 0 };

async function callModel(system, user) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMP,
    }),
  });
  if (!res.ok) {
    throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const elapsed = (Date.now() - started) / 1000;
  const usage = json.usage || {};
  stats.calls += 1;
  stats.seconds += elapsed;
  stats.completionTokens += usage.completion_tokens || 0;
  stats.promptTokens += usage.prompt_tokens || 0;
  const content = json?.choices?.[0]?.message?.content ?? "";
  return content;
}

// Pull the first balanced {...} object out of a possibly noisy reply (the 3B
// sometimes wraps JSON in prose or a code fence). Returns the parsed object or
// throws with the raw text so the caller can record the failure.
function parseFirstJson(text) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error(`no JSON object in reply: ${JSON.stringify(text)}`);
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// ------------------------------------------------------------------ prompts
const EXTRACT_SYSTEM =
  "You extract one structured fact from a single chat turn. Reply with ONLY a " +
  "JSON object and nothing else. Schema: " +
  '{"attr": string, "value": string, "updates_prior": boolean}. ' +
  'attr is a short lowercase noun for what the fact is about (for example "database", "editor", "phone number"). ' +
  'value is the concise current value (for example "MySQL", "VS Code", "555-0199"). ' +
  "updates_prior is true only when this turn corrects or replaces a value stated earlier in the same conversation (words like actually, switched, moved, migrated, new, rewrote, took over, relocated). " +
  'If the turn states no concrete fact, use value "none" and updates_prior false.';

function extractUser(priorAttr, priorValue, turn) {
  const priorLine =
    priorValue === null
      ? "Prior fact in this conversation: none yet."
      : `Prior fact in this conversation: ${priorAttr} = ${priorValue}.`;
  return (
    `${priorLine}\n` +
    `Turn: ${turn}\n` +
    "Return the JSON object for this turn."
  );
}

const ANSWER_SYSTEM =
  "You answer a question using ONLY the provided context lines. Do not use any " +
  "outside knowledge. If several context lines conflict, trust the most recent " +
  "one. Reply with ONLY a JSON object: {\"answer\": string}. Keep the answer " +
  "short (a few words at most).";

function answerUser(contextLines, question) {
  const ctx =
    contextLines.length > 0
      ? contextLines.map((l) => `- ${l}`).join("\n")
      : "- (no facts on record)";
  return `Context:\n${ctx}\n\nQuestion: ${question}\nReturn the JSON answer.`;
}

// ------------------------------------------------------------------ admit
// Flat proposal in the current admit() schema, mirroring ambient-bench.mjs.
// `edges` shapes a real supersedes link to the prior cell for the attr; admit()
// validates the target resolves and flips it to status "superseded".
function factProposal(attr, value, supersedesKey) {
  return {
    kind: "obs",
    title: `fact:${attr}=${value}`,
    body: `${attr}=${value}`,
    confidence: 0.8,
    project: "sentinel",
    tenant: "local",
    topics: ["fact", attr],
    entities: [attr],
    ...(supersedesKey
      ? { edges: [{ relation: "supersedes", target: supersedesKey }] }
      : {}),
  };
}

function admitFact(store, attr, value, supersedesKey) {
  const result = admit(factProposal(attr, value, supersedesKey), { store });
  if (!result || result.accepted !== true || !result.cell) {
    throw new Error(
      `not admitted: ${attr}=${value} -> ${JSON.stringify(
        result?.issues ?? result,
      )}`,
    );
  }
  return result.cell;
}

// Does an extracted attr line up with the item's canonical retrieval attr?
// The 3B drifts ("database" vs "main database"), so accept a containment match
// either way, plus a token overlap fallback.
function attrMatches(extracted, canonical) {
  const a = norm(extracted);
  const b = norm(canonical);
  if (!a || a === "none") return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = new Set(a.split(/\s+/));
  return b.split(/\s+/).some((t) => at.has(t));
}

// ------------------------------------------------------------------ run item
async function runItem(item) {
  const tmp = mkdtempSync(join(os.tmpdir(), "graphqa-"));
  const store = new SqliteStore(join(tmp, "d.sqlite3"));
  const record = {
    id: item.id,
    type: item.type,
    question: item.question,
    gold: item.gold,
    model_answer: "",
    retrieved_values: [],
    built_cells: 0,
    built_edges: 0,
  };
  const diagnostics = {
    supersedeTurns: [],
    supersededCorrectly: false,
    extractions: [],
    errors: [],
  };
  const builtFacts = []; // {key, attr, value, turnIndex}
  try {
    // ---- PHASE 1: build the graph, one model call per turn.
    let lastAttr = null;
    let lastValue = null;
    let lastKey = null;
    for (let t = 0; t < item.turns.length; t++) {
      const turn = item.turns[t];
      let raw = "";
      let fact = null;
      try {
        raw = await callModel(
          EXTRACT_SYSTEM,
          extractUser(lastAttr, lastValue, turn),
        );
        fact = parseFirstJson(raw);
      } catch (err) {
        diagnostics.errors.push(`extract turn ${t}: ${err.message}`);
        diagnostics.extractions.push({ turn: t, raw, parsed: null });
        continue;
      }
      diagnostics.extractions.push({ turn: t, raw, parsed: fact });
      const attr = norm(fact.attr);
      const value = String(fact.value ?? "").trim();
      const updates = fact.updates_prior === true;
      // Skip turns with no concrete fact.
      if (!attr || attr === "none" || !value || norm(value) === "none") {
        continue;
      }
      // The prior cell for this attr: prefer a prior fact whose attr matches,
      // else fall back to the most recent prior fact in this item.
      let supersedesKey = null;
      if (updates && builtFacts.length > 0) {
        const sameAttr = [...builtFacts]
          .reverse()
          .find((f) => attrMatches(f.attr, attr) || attrMatches(attr, f.attr));
        supersedesKey = (sameAttr || builtFacts[builtFacts.length - 1]).key;
      }
      let cell;
      try {
        cell = admitFact(store, attr, value, supersedesKey);
      } catch (err) {
        diagnostics.errors.push(`admit turn ${t}: ${err.message}`);
        continue;
      }
      record.built_cells += 1;
      builtFacts.push({ key: cell.key, attr, value, turnIndex: t });
      if (supersedesKey) {
        record.built_edges += 1;
        diagnostics.supersedeTurns.push(t);
      }
      lastAttr = attr;
      lastValue = value;
      lastKey = cell.key;
    }

    // Did the graph supersede on the correct (real) update turn?
    if (item.type === "update" && item.updateTurn !== null) {
      diagnostics.supersededCorrectly = diagnostics.supersedeTurns.includes(
        item.updateTurn,
      );
    }

    // ---- PHASE 2: retrieve, then answer with a fresh model call.
    // Active cells only: a superseded prior is excluded by construction. Keep
    // the fact cells whose attr matches the question's canonical attr, newest
    // turn first.
    const activeKeys = new Set(store.active().map((c) => c.key));
    const relevant = builtFacts
      .filter((f) => activeKeys.has(f.key) && attrMatches(f.attr, item.attr))
      .sort((a, b) => b.turnIndex - a.turnIndex);
    // Fallback: if canonical filtering drops everything, use all active facts.
    const chosen =
      relevant.length > 0
        ? relevant
        : builtFacts
            .filter((f) => activeKeys.has(f.key))
            .sort((a, b) => b.turnIndex - a.turnIndex);
    record.retrieved_values = chosen.map((f) => f.value);
    const contextLines = chosen.map((f) => `${f.attr} = ${f.value}`);

    try {
      const raw = await callModel(
        ANSWER_SYSTEM,
        answerUser(contextLines, item.question),
      );
      let answer = "";
      try {
        answer = String(parseFirstJson(raw).answer ?? "").trim();
      } catch (err) {
        // Fall back to the raw text if the model forgot the JSON wrapper.
        diagnostics.errors.push(`answer parse: ${err.message}`);
        answer = raw.trim();
      }
      record.model_answer = answer;
    } catch (err) {
      diagnostics.errors.push(`answer call: ${err.message}`);
    }
  } finally {
    store.close?.();
    rmSync(tmp, { recursive: true, force: true });
  }
  return { record, diagnostics };
}

// ------------------------------------------------------------------ main
async function main() {
  const records = [];
  const diags = [];
  for (const item of FIXTURE) {
    const { record, diagnostics } = await runItem(item);
    records.push(record);
    diags.push({ id: item.id, ...diagnostics });
  }

  writeFileSync(OUT_PATH, JSON.stringify(records, null, 2));

  // ---- console report (the orchestrator grades model_answer vs gold).
  const genTps = stats.seconds > 0 ? stats.completionTokens / stats.seconds : 0;
  console.log("==================== AMBIENT graph QA (local 3B, two phase) ====================\n");
  console.log(`model      : ${MODEL}`);
  console.log(`endpoint   : ${ENDPOINT}`);
  console.log(`items      : ${FIXTURE.length}`);
  console.log(
    `model calls: ${stats.calls}  (prompt_tokens=${stats.promptTokens}, completion_tokens=${stats.completionTokens})`,
  );
  console.log(
    `throughput : ${genTps.toFixed(1)} completion tokens/sec over ${stats.seconds.toFixed(1)}s wall\n`,
  );

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("id", 11) +
      pad("type", 11) +
      pad("gold", 12) +
      pad("model_answer", 20) +
      pad("cells", 6) +
      pad("edges", 6) +
      "superseded_ok",
  );
  let supersededOk = 0;
  let updateCount = 0;
  let falseSupersedes = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const d = diags[i];
    if (r.type === "update") {
      updateCount += 1;
      if (d.supersededCorrectly) supersededOk += 1;
    } else if (d.supersedeTurns.length > 0) {
      falseSupersedes += 1;
    }
    console.log(
      pad(r.id, 11) +
        pad(r.type, 11) +
        pad(r.gold, 12) +
        pad(r.model_answer.slice(0, 18), 20) +
        pad(r.built_cells, 6) +
        pad(r.built_edges, 6) +
        (r.type === "update" ? (d.supersededCorrectly ? "yes" : "no") : "-"),
    );
  }
  console.log(
    `\nsuperseded correctly (edge on the real update turn): ${supersededOk}/${updateCount} update items`,
  );
  console.log(
    `false supersedes on distractor items               : ${falseSupersedes}`,
  );

  const withErrors = diags.filter((d) => d.errors.length > 0);
  if (withErrors.length > 0) {
    console.log("\nerrors:");
    for (const d of withErrors) {
      for (const e of d.errors) console.log(`  [${d.id}] ${e}`);
    }
  } else {
    console.log("\nerrors: none");
  }
  console.log(`\nanswers JSON written to: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
