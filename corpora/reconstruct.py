#!/usr/bin/env python3
"""AMBIENT corpus reconstruction adapter.

Fetches BEAM and LongMemEval from their OFFICIAL releases (never redistributed here)
and normalizes them into AMBIENT segments. Reconstruct-from-source keeps licenses
clean: BEAM is CC BY-SA 4.0 (ShareAlike) and LoCoMo would be CC BY-NC, so AMBIENT
ships this script, not the data. See corpora/LICENSES.md and corpora/sources.json.

Segment schema (one JSON object per line in out/<source>/<tier>/segments.jsonl):
  { id, source, tier, ability, question, gold, tag, supportIds, conversationId }
Ingest events per conversation go to out/<source>/<tier>/corpus/<conversationId>.jsonl:
  { seq, role, text, ts, sessionId }
supportIds is the "traced outside the model" evidence (LongMemEval answer_session_ids);
BEAM has no provenance, so its supportIds is null (correctness-only scoring).

Usage:
  python reconstruct.py --source longmemeval --tier small
  python reconstruct.py --source beam --tier small
  python reconstruct.py --all-small
Deps: huggingface_hub, pyarrow.
"""
import argparse
import ast
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CACHE = HERE / "data"  # HF download cache (gitignored)

# tier -> (repo_id, repo_type, filename)
BEAM = {
    "small":  ("Mohammadta/BEAM",     "dataset", "data/100K-00000-of-00001.parquet"),
    "medium": ("Mohammadta/BEAM",     "dataset", "data/500K-00000-of-00001.parquet"),
    "large":  ("Mohammadta/BEAM",     "dataset", "data/1M-00000-of-00001.parquet"),
    "xlarge": ("Mohammadta/BEAM-10M", "dataset", "data/10M-00000-of-00002.parquet"),
}
LME = {
    "small":  ("xiaowu0162/longmemeval-cleaned", "dataset", "longmemeval_oracle.json"),
    "medium": ("xiaowu0162/longmemeval-cleaned", "dataset", "longmemeval_s_cleaned.json"),
    "large":  ("xiaowu0162/longmemeval-cleaned", "dataset", "longmemeval_m_cleaned.json"),
}


def fetch(repo_id, repo_type, filename):
    from huggingface_hub import hf_hub_download
    return hf_hub_download(repo_id=repo_id, repo_type=repo_type,
                           filename=filename, cache_dir=str(CACHE))


def _slug(s):
    return "".join(c if c.isalnum() else "-" for c in str(s).strip().lower()).strip("-") or "unknown"


def _role(t):
    if not isinstance(t, dict):
        return "user"
    return t.get("role") or t.get("speaker") or t.get("from") or "user"


def _text(t):
    if isinstance(t, str):
        return t
    if not isinstance(t, dict):
        return str(t)
    return t.get("content") or t.get("text") or t.get("value") or ""


def _maybe_parse(v):
    if isinstance(v, str):
        try:
            return ast.literal_eval(v)
        except Exception:
            return v
    return v


def write_segments(source, tier, segments, corpora):
    d = OUT / source / tier
    (d / "corpus").mkdir(parents=True, exist_ok=True)
    with open(d / "segments.jsonl", "w") as f:
        for s in segments:
            f.write(json.dumps(s) + "\n")
    for cid, events in corpora.items():
        safe = cid.replace("/", "_").replace(":", "_")
        with open(d / "corpus" / (safe + ".jsonl"), "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
    abilities = sorted({s["ability"] for s in segments})
    print("wrote %d segments across %d conversations -> %s" % (len(segments), len(corpora), d))
    print("  abilities:", abilities)


def load_beam(tier):
    import pyarrow.parquet as pq
    path = fetch(*BEAM[tier])
    rows = pq.read_table(path).to_pylist()
    print("BEAM %s: %d conversations; row keys: %s" % (tier, len(rows), list(rows[0].keys())))
    segments, corpora = [], {}
    for ci, row in enumerate(rows):
        cid = "beam:%s:%d" % (tier, ci)
        # BEAM chat is nested: chat -> sessions -> turns (turn dicts have role/content/time_anchor).
        chat = _maybe_parse(row.get("chat")) or []
        events = []
        seq = 0
        for si, session in enumerate(chat):
            session = _maybe_parse(session)
            turns = session if isinstance(session, list) else [session]
            for t in turns:
                events.append({
                    "seq": seq, "role": _role(t), "text": _text(t),
                    "ts": (t.get("time_anchor") if isinstance(t, dict) else None),
                    "sessionId": si,
                })
                seq += 1
        corpora[cid] = events
        items = _maybe_parse(row.get("probing_questions")) or []
        # probing_questions may be a list of dicts, or a dict keyed by ability
        if isinstance(items, dict):
            flat = []
            for k, v in items.items():
                for it in (v if isinstance(v, list) else [v]):
                    if isinstance(it, dict):
                        it.setdefault("ability", k)
                        flat.append(it)
            items = flat
        for qi, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            ability = _slug(it.get("ability") or it.get("category") or it.get("type") or "unknown")
            # BEAM's gold key varies by ability: answer / ideal_answer / ideal_response /
            # ideal_summary (summarization) / expected_compliance (instruction, preference).
            gold = (it.get("answer") or it.get("ideal_answer") or it.get("ideal_response")
                    or it.get("ideal_summary") or it.get("expected_compliance")
                    or it.get("gold") or it.get("a") or "")
            seg = {
                "id": "%s:%d" % (cid, qi), "source": "beam", "tier": tier, "ability": ability,
                "question": it.get("question") or it.get("q") or "",
                "gold": gold,
                "tag": "abstention" if "abstention" in ability else "novel",
                # BEAM partial provenance: some abilities carry source_chat_ids
                "supportIds": it.get("source_chat_ids") or it.get("source_chat_id") or None,
                "conversationId": cid,
            }
            rubric = it.get("rubric") or it.get("compliance_indicators") or it.get("key_elements_tested")
            if rubric:
                seg["rubric"] = rubric
            if it.get("difficulty"):
                seg["difficulty"] = it["difficulty"]
            if it.get("abstention_type"):
                seg["abstentionType"] = it["abstention_type"]
            segments.append(seg)
    return segments, corpora


def load_longmemeval(tier):
    path = fetch(*LME[tier])
    data = json.load(open(path))
    print("LongMemEval %s: %d instances; keys: %s" % (tier, len(data), list(data[0].keys())))
    segments, corpora = [], {}
    for inst in data:
        qid = inst.get("question_id") or inst.get("id")
        cid = "longmemeval:%s" % qid
        sessions = inst.get("haystack_sessions") or []
        dates = inst.get("haystack_dates") or inst.get("haystack_session_dates") or []
        events, seq = [], 0
        for si, sess in enumerate(sessions):
            ts = dates[si] if si < len(dates) else None
            for t in (sess or []):
                events.append({"seq": seq, "role": _role(t), "text": _text(t),
                               "ts": ts, "sessionId": si, "hasAnswer": bool(t.get("has_answer")) if isinstance(t, dict) else False})
                seq += 1
        corpora[cid] = events
        segments.append({
            "id": cid, "source": "longmemeval", "tier": tier,
            "ability": _slug(inst.get("question_type") or "unknown"),
            "question": inst.get("question") or "",
            "gold": inst.get("answer") or "",
            "tag": "abstention" if str(qid).endswith("_abs") else "novel",
            "supportIds": inst.get("answer_session_ids"),  # traced-outside-model evidence
            "conversationId": cid,
        })
    return segments, corpora


def run(source, tier):
    if source == "beam":
        segs, corp = load_beam(tier)
    elif source == "longmemeval":
        segs, corp = load_longmemeval(tier)
    else:
        raise SystemExit("unknown source: " + source)
    write_segments(source, tier, segs, corp)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["beam", "longmemeval"])
    ap.add_argument("--tier", choices=["small", "medium", "large", "xlarge"], default="small")
    ap.add_argument("--all-small", action="store_true")
    a = ap.parse_args()
    if a.all_small:
        run("longmemeval", "small")
        run("beam", "small")
    elif a.source:
        run(a.source, a.tier)
    else:
        ap.error("give --source or --all-small")
