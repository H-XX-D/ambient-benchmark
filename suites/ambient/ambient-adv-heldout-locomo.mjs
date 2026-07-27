#!/usr/bin/env node
// AMBIENT adversarial axis: KEY=heldout-locomo.
//
// Attack Recall retrieval with REAL held-out data the harness author did not
// write: a sample of LOCOMO (multi session conversations with QA pairs), loaded
// from benchmark/data/locomo/locomo10. LOCOMO queries carry gold_ids (the
// session documents that support the answer), which is the ground truth for a
// STORE-SIDE evidence retrieval test that is independent of any model answer.
//
// Pipeline (two model phases over the local 3B):
//   PHASE 1 (build, model A): for every session of one conversation, admit a
//   verbatim transcript cell, then the 3B extracts up to 6 atomic facts which
//   are admitted as cells with derived_from edges back to the transcript. This
//   is the 3B building a Recall graph from the sessions. The transcript cell
//   guarantees the gold session content is physically present in the store, so
//   a retrieval miss is a STORE miss (bm25/index), not a build/extraction miss.
//   PHASE 2 (answer, model B): a FRESH model call answers each question from
//   ONLY the cells store.search() surfaces. Grading is NOT done here.
//
// FAIRNESS:
//   1. Both-direction headroom: store.search is OR-of-terms bm25 over ~19
//      same-vocabulary sessions. Questions whose content words appear verbatim
//      retrieve the gold session (pass); paraphrased / temporal / multi hop
//      questions and the strict K=1 rank miss (fail). Reported as a K curve, so
//      the score can land anywhere from 0 to 100.
//   2. Input not authored to the mechanism: cases are real LOCOMO QA pairs
//      taken in file order after a validity filter; cells are 3B extracted and
//      verbatim transcripts. Retrieval is the generic store.search primitive.
//   3. Same capability class: only store.search retrieval recall is scored on
//      the store. Date derivation (temporal) and answer correctness are the
//      model's job and are graded by the orchestrator, not counted as store
//      misses. Multi hop = surfaced ANY gold session (partial evidence).
//   4. Where it breaks: recall@K curve (K=1,3,5,10), lexical vs hash-semantic,
//      transcript+fact vs fact-only, plus empty-retrieval and body round-trip
//      integrity as regression signals.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  SqliteStore,
  admit,
  semanticSearch,
  reindexSemantic,
} from "./_recall.mjs";

// ------------------------------------------------------------------ config
const DATA_DIR =
  "/Users/hendrixx./Recall-GitHub-Clean/benchmark/data/locomo/locomo10";
const CONV = "conv-26"; // deterministic pick: first conversation in the set
const N_QUESTIONS = 24; // first N valid queries in file order
const MAX_FACTS = 6; // per session extraction cap
const ANSWER_K = 6; // cells fed to the answer model
const CTX_CHARS = 700; // per cell truncation for the answer context only
const FIXED_NOW = "2023-07-17T00:00:00.000Z"; // deterministic admit timestamp

const PORT = Number(process.env.MLX_PORT || 8081);
const MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit";
const ENDPOINT = `http://localhost:${PORT}/v1/chat/completions`;
const OUT_PATH =
  process.env.LOCOMO_OUT ||
  "/Users/hendrixx./.claude/jobs/5dd65020/tmp/heldout-locomo-answers.json";

// ------------------------------------------------------------------ data load
function loadGz(name) {
  return JSON.parse(gunzipSync(readFileSync(join(DATA_DIR, name))).toString("utf8"));
}

// A LOCOMO document content is a JSON string of dialogue turns. Render it to a
// readable transcript. Preserve every character verbatim (unicode included);
// the round-trip check below depends on nothing being stripped here.
function renderTranscript(contentStr) {
  let turns;
  try {
    turns = JSON.parse(contentStr);
  } catch {
    return String(contentStr);
  }
  if (!Array.isArray(turns)) return String(contentStr);
  return turns
    .map((t) => {
      const who = t.speaker ?? "?";
      const said = t.text ?? "";
      const cap = t.blip_caption ? ` [image: ${t.blip_caption}]` : "";
      return `${who}: ${said}${cap}`;
    })
    .join("\n");
}

// ------------------------------------------------------------------ model IO
const stats = { calls: 0, completionTokens: 0, promptTokens: 0, seconds: 0, httpErrors: 0 };

async function callModel(system, user, maxTokens) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.0,
      }),
    });
  } catch (err) {
    stats.httpErrors += 1;
    throw new Error(`fetch failed: ${err.message}`);
  }
  if (!res.ok) {
    stats.httpErrors += 1;
    throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const usage = json.usage || {};
  stats.calls += 1;
  stats.seconds += (Date.now() - started) / 1000;
  stats.completionTokens += usage.completion_tokens || 0;
  stats.promptTokens += usage.prompt_tokens || 0;
  return json?.choices?.[0]?.message?.content ?? "";
}

// Pull the first balanced JSON value (object or array) out of a noisy reply.
function parseFirstJson(text) {
  const stripped = text.replace(/```json/gi, "").replace(/```/g, "");
  const opens = { "{": "}", "[": "]" };
  for (let i = 0; i < stripped.length; i++) {
    const open = stripped[i];
    if (open !== "{" && open !== "[") continue;
    const close = opens[open];
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < stripped.length; j++) {
      const ch = stripped[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(i, j + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`no JSON in reply: ${JSON.stringify(text.slice(0, 160))}`);
}

const norm = (s) => String(s ?? "").trim();

// Tolerant fact extractor. The 3B usually returns a strict JSON array, but it
// often falls back to newline-separated bracketed lines ("[fact]\n[fact]") or a
// single "[a, b, c]" blob, none of which JSON.parse accepts. Recover facts from
// all three shapes so the graph is actually populated by the model, without
// hand-authoring the facts themselves.
function extractFacts(raw) {
  const clean = String(raw ?? "").replace(/```json/gi, "").replace(/```/g, "").trim();
  // 1) strict JSON array of strings.
  try {
    const parsed = parseFirstJson(clean);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .map((f) => (typeof f === "string" ? f : JSON.stringify(f)))
        .map((f) => f.trim())
        .filter(Boolean);
    }
  } catch {
    // fall through to the line-based recovery.
  }
  // 2) line-based: one fact per line, stripping wrapping brackets/quotes/commas.
  const byLine = clean
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-\*\d.]*\[?["']?/, "").replace(/["']?\]?,?\s*$/, "").trim())
    .filter((l) => l.split(/\s+/).length >= 3);
  if (byLine.length) return byLine;
  // 3) single bracketed blob: strip the outer brackets, keep it as one fact.
  const blob = clean.replace(/^\[/, "").replace(/\]$/, "").trim();
  return blob.split(/\s+/).length >= 3 ? [blob] : [];
}

// ------------------------------------------------------------------ prompts
const EXTRACT_SYSTEM =
  "You read a chat session between two people and extract atomic facts. " +
  "Reply with ONLY a JSON array of short strings and nothing else. " +
  "Each string is one concrete fact stated in the session (who did or said " +
  "what, when, where, a preference, a plan, a name). Keep each under 20 words. " +
  `Return at most ${MAX_FACTS} facts. If nothing concrete is stated, return [].`;

const ANSWER_SYSTEM =
  "You answer a question using ONLY the provided context lines. Do not use " +
  "outside knowledge. If the context does not contain the answer, reply with " +
  'your best guess from the context. Reply with ONLY a JSON object: ' +
  '{"answer": string}. Keep the answer short (a few words).';

function answerUser(contextLines, question) {
  const ctx = contextLines.length ? contextLines.join("\n\n") : "(no context retrieved)";
  return `Context:\n${ctx}\n\nQuestion: ${question}\nReturn the JSON answer.`;
}

// ------------------------------------------------------------------ admit
function obsProposal(title, body, topics, edges) {
  return {
    kind: "obs",
    title,
    body,
    confidence: 0.8,
    project: "locomo",
    tenant: "local",
    topics,
    entities: [CONV],
    ...(edges && edges.length ? { edges } : {}),
  };
}

function admitCell(store, prop) {
  const r = admit(prop, { store, now: FIXED_NOW });
  if (!r || r.accepted !== true || !r.cell) {
    throw new Error(`not admitted: ${prop.title} -> ${JSON.stringify(r?.issues ?? r)}`);
  }
  return r.cell;
}

// ------------------------------------------------------------------ main
async function main() {
  // --- health check
  try {
    const ping = await fetch(`http://localhost:${PORT}/v1/models`);
    if (!ping.ok) throw new Error(`models HTTP ${ping.status}`);
  } catch (err) {
    console.error(`FATAL: model server not reachable: ${err.message}`);
    process.exit(2);
  }

  const documents = loadGz("documents.json.gz");
  const queries = loadGz("queries.json.gz");

  // Sessions of the chosen conversation, ordered by session number.
  const sessions = documents
    .filter((d) => String(d.id).startsWith(`${CONV}_session`))
    .sort((a, b) => {
      const na = Number(String(a.id).split("_session_")[1] || 0);
      const nb = Number(String(b.id).split("_session_")[1] || 0);
      return na - nb;
    });
  const sessionIds = new Set(sessions.map((s) => s.id));

  const tmp = mkdtempSync(join(os.tmpdir(), "locomo-adv-"));
  const store = new SqliteStore(join(tmp, "d.sqlite3"));

  // key -> { source, kind } where kind is "transcript" or "fact"
  const cellSource = new Map();
  const buildErrors = [];
  let transcriptRoundTripFails = 0;
  const nonAsciiSessions = [];

  try {
    // ---- PHASE 1: build the graph, per session.
    for (const doc of sessions) {
      const transcript = renderTranscript(doc.content);
      if (/[^\x00-\x7F]/.test(transcript)) nonAsciiSessions.push(doc.id);

      let transCell;
      try {
        transCell = admitCell(
          store,
          obsProposal(`transcript:${doc.id}`, transcript, ["locomo", CONV, "transcript"]),
        );
      } catch (err) {
        buildErrors.push(`transcript ${doc.id}: ${err.message}`);
        continue;
      }
      cellSource.set(transCell.key, { source: doc.id, kind: "transcript" });

      // Body round-trip: the store must return exactly what was admitted. A
      // silent unicode drop here is a storage regression, not a retrieval one.
      const got = store.get(transCell.key);
      if (!got || got.body !== transcript) transcriptRoundTripFails += 1;

      // 3B fact extraction (one call per session).
      let facts = [];
      try {
        const raw = await callModel(
          EXTRACT_SYSTEM,
          `Session ${doc.id}:\n${transcript}\n\nReturn the JSON array of facts.`,
          256,
        );
        facts = extractFacts(raw).slice(0, MAX_FACTS);
        if (facts.length === 0) buildErrors.push(`extract ${doc.id}: no facts recovered from reply`);
      } catch (err) {
        buildErrors.push(`extract ${doc.id}: ${err.message}`);
      }

      facts.forEach((fact, i) => {
        try {
          const cell = admitCell(
            store,
            obsProposal(
              `fact:${doc.id}#${i}`,
              fact,
              ["locomo", CONV, "fact"],
              [{ relation: "derived_from", target: transCell.key }],
            ),
          );
          cellSource.set(cell.key, { source: doc.id, kind: "fact" });
        } catch (err) {
          buildErrors.push(`fact ${doc.id}#${i}: ${err.message}`);
        }
      });
    }

    // Build a semantic (hash:v1) index over everything for the secondary probe.
    let semanticIndexed = 0;
    try {
      semanticIndexed = reindexSemantic(store);
    } catch (err) {
      buildErrors.push(`reindexSemantic: ${err.message}`);
    }

    const st = store.stats();

    // ---- Question selection: file order, valid gold, gold_ids all loaded.
    const chosen = queries
      .filter((q) => String(q.user_id) === CONV || String(q.id).startsWith(CONV))
      .filter(
        (q) =>
          Array.isArray(q.gold_answers) &&
          q.gold_answers.length > 0 &&
          Array.isArray(q.gold_ids) &&
          q.gold_ids.length > 0 &&
          q.gold_ids.every((g) => sessionIds.has(g)),
      )
      .slice(0, N_QUESTIONS);

    // helper: does a ranked search list surface a gold session, and how?
    function storeHit(searchHits, goldIds, topK) {
      const seen = [];
      for (const h of searchHits.slice(0, topK)) {
        const src = cellSource.get(h.cell.key);
        if (src) seen.push(src.source);
      }
      return goldIds.some((g) => seen.includes(g));
    }
    function factOnlyHits(searchHits) {
      return searchHits.filter((h) => cellSource.get(h.cell.key)?.kind === "fact");
    }

    const K_CURVE = [1, 3, 5, 10];
    const lexRecall = Object.fromEntries(K_CURVE.map((k) => [k, 0]));
    const factRecall = Object.fromEntries(K_CURVE.map((k) => [k, 0]));
    let semRecall5 = 0;
    let unionRecall5 = 0;
    let emptyRetrieval = 0;

    const records = [];

    // ---- PHASE 2 + store-side eval, per question.
    for (const q of chosen) {
      const question = q.query;
      const goldIds = q.gold_ids;

      // lexical retrieval (the store's primary retrieval primitive).
      const lexHits = store.search(question, { limit: 10 });
      if (lexHits.length === 0) emptyRetrieval += 1;

      // semantic (hash:v1) retrieval.
      let semHits = [];
      try {
        semHits = semanticSearch(question, store, { limit: 10 });
      } catch (err) {
        buildErrors.push(`semantic q ${q.id}: ${err.message}`);
      }

      for (const k of K_CURVE) {
        if (storeHit(lexHits, goldIds, k)) lexRecall[k] += 1;
        if (storeHit(factOnlyHits(lexHits), goldIds, k)) factRecall[k] += 1;
      }
      const semHit5 = storeHit(semHits, goldIds, 5);
      const lexHit5 = storeHit(lexHits, goldIds, 5);
      if (semHit5) semRecall5 += 1;
      if (semHit5 || lexHit5) unionRecall5 += 1;

      // ---- answer from retrieved cells (fresh model call).
      const chosenCells = lexHits.slice(0, ANSWER_K);
      const contextLines = chosenCells.map((h) => {
        const src = cellSource.get(h.cell.key);
        const body = h.cell.body.length > CTX_CHARS ? h.cell.body.slice(0, CTX_CHARS) + "..." : h.cell.body;
        return `[${src?.source ?? "?"}] ${body}`;
      });

      let modelAnswer = "";
      try {
        const raw = await callModel(ANSWER_SYSTEM, answerUser(contextLines, question), 64);
        try {
          modelAnswer = norm(parseFirstJson(raw).answer);
        } catch {
          modelAnswer = raw.trim();
        }
      } catch (err) {
        buildErrors.push(`answer q ${q.id}: ${err.message}`);
      }

      records.push({
        id: q.id,
        question,
        gold: q.gold_answers,
        gold_ids: goldIds,
        category: q.meta?.category ?? null,
        model_answer: modelAnswer,
        retrieved: chosenCells.map((h) => ({
          key: h.cell.key,
          source: cellSource.get(h.cell.key)?.source ?? null,
          kind: cellSource.get(h.cell.key)?.kind ?? null,
          title: h.cell.title,
          score: Number(h.score?.toFixed?.(4) ?? h.score),
          snippet: h.cell.body.slice(0, 160),
        })),
        store_hit_lex_at5: lexHit5,
        store_hit_sem_at5: semHit5,
      });
    }

    writeFileSync(OUT_PATH, JSON.stringify(records, null, 2));

    // ------------------------------------------------------------- report
    const n = chosen.length;
    const pct = (x) => `${((x / (n || 1)) * 100).toFixed(0)}%`;
    console.log("==================== AMBIENT adversarial: heldout-locomo ====================\n");
    console.log(`conversation      : ${CONV}  (${sessions.length} sessions loaded as the corpus)`);
    console.log(`questions sampled : ${n} (first ${N_QUESTIONS} valid LOCOMO queries in file order)`);
    console.log(`store cells       : ${st.cells} (active ${st.activeCells}) | edges ${st.edges} | fts indexed ${st.indexedCells} | backend ${st.lexicalBackend}`);
    console.log(`semantic indexed  : ${semanticIndexed} (backend hash:v1)`);
    const cats = {};
    for (const q of chosen) cats[q.meta?.category ?? "?"] = (cats[q.meta?.category ?? "?"] || 0) + 1;
    console.log(`categories        : ${Object.entries(cats).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);

    console.log("---- STORE-SIDE evidence retrieval recall (did search surface a gold session?) ----");
    console.log("this is independent of the model answer; it is the Recall-regression signal.\n");
    console.log("  lexical bm25 (transcript+fact cells):");
    for (const k of K_CURVE) console.log(`    recall@${k.toString().padEnd(2)} : ${pct(lexRecall[k])}  (${lexRecall[k]}/${n})`);
    console.log("  lexical bm25 (3B fact cells only, build+retrieval combined):");
    for (const k of K_CURVE) console.log(`    recall@${k.toString().padEnd(2)} : ${pct(factRecall[k])}  (${factRecall[k]}/${n})`);
    console.log(`  semantic hash:v1 recall@5 : ${pct(semRecall5)}  (${semRecall5}/${n})`);
    console.log(`  union (lexOR sem) recall@5: ${pct(unionRecall5)}  (${unionRecall5}/${n})\n`);

    console.log("---- store health / regression signals ----");
    console.log(`  empty retrieval (search returned []): ${emptyRetrieval}/${n}`);
    console.log(`  transcript body round-trip failures : ${transcriptRoundTripFails}/${sessions.length}`);
    console.log(`  sessions containing non-ASCII text  : ${nonAsciiSessions.length}/${sessions.length}${nonAsciiSessions.length ? " (round-trip preserved: " + (transcriptRoundTripFails === 0 ? "yes" : "NO") + ")" : ""}`);
    console.log(`  build errors                        : ${buildErrors.length}`);
    if (buildErrors.length) for (const e of buildErrors.slice(0, 12)) console.log(`    - ${e}`);

    const genTps = stats.seconds > 0 ? stats.completionTokens / stats.seconds : 0;
    console.log(`\nmodel calls: ${stats.calls} (prompt ${stats.promptTokens}, completion ${stats.completionTokens}); ${genTps.toFixed(1)} tok/s over ${stats.seconds.toFixed(1)}s; http errors ${stats.httpErrors}`);
    console.log(`answers JSON written to: ${OUT_PATH}`);

    // machine-readable summary line for the orchestrator.
    console.log(
      "\nSUMMARY " +
        JSON.stringify({
          conv: CONV,
          sessions: sessions.length,
          questions: n,
          store_recall_lex: Object.fromEntries(K_CURVE.map((k) => [k, lexRecall[k] / (n || 1)])),
          store_recall_fact: Object.fromEntries(K_CURVE.map((k) => [k, factRecall[k] / (n || 1)])),
          store_recall_sem_at5: semRecall5 / (n || 1),
          union_recall_at5: unionRecall5 / (n || 1),
          empty_retrieval: emptyRetrieval,
          roundtrip_fails: transcriptRoundTripFails,
          nonascii_sessions: nonAsciiSessions.length,
          build_errors: buildErrors.length,
        }),
    );
  } finally {
    store.close?.();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
