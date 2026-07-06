#!/usr/bin/env python3
"""AMBIENT adapter for CogniCore (github.com/cognicore-dev/cognicore-my-openenv).

Wraps CogniCore's default TFIDFMemoryBackend behind the AMBIENT MemoryAdapter wire
protocol (docs/ADAPTER_CONTRACT.md). The one mandatory capability is provenance:
query() returns the served context AND where each item came from, marked
origin="external" (the CogniCore store, not the model). CogniCore is a pull system
with no unprompted push, so surface() reports not-supported, which AMBIENT grades
ABSENT on the push rungs, never FAIL (RULES.md Rule 6).

DISCLOSED PATCHES to stand CogniCore up (cognicore-env 0.9.3/0.9.4 shipped broken).
"Did you modify the system" is an AMBIENT honesty question, so these are recorded:
  1. memory/__init__.py imports EmbeddingMemoryBackend, but the class is named
     BasicEmbeddingBackend (name mismatch) -> aliased in __init__.
  2. multihop_backend.py imports numpy, but the package declares zero dependencies
     -> numpy installed into the venv.
  3. The README's cognicore.Memory(max_size) API does not exist in the package;
     the real default backend (TFIDFMemoryBackend, wired by base_env) is used.
None change CogniCore's memory behavior; they only make an unimportable package import.

Run:
  ~/cog-venv/bin/python adapters/cognicore_adapter.py --selftest
  ~/cog-venv/bin/python adapters/cognicore_adapter.py --port 8091   # wire-protocol server
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from cognicore.memory.base import MemoryEntry
from cognicore.memory.tfidf_backend import TFIDFMemoryBackend

NAME = "cognicore"


class CogniCoreAdapter:
    """AMBIENT MemoryAdapter over CogniCore's default TF-IDF retrieval backend."""

    def __init__(self, max_size=10000):
        self._max = max_size
        self.backend = TFIDFMemoryBackend(max_size=max_size)
        self.sources = {}  # entry_id -> source, so query() can attach provenance
        self.auto = True

    def reset(self):
        # fresh store per (system, tier) run so no state leaks (RULES.md Rule 5)
        self.backend = TFIDFMemoryBackend(max_size=self._max)
        self.sources = {}
        return {"ok": True}

    def write(self, fact, source="ingest"):
        eid = self.backend.store(MemoryEntry(text=fact, category="fact"))
        self.sources[eid] = source
        return {"id": eid}

    def query(self, question, top_k=5):
        results = self.backend.search(question, top_k=top_k)
        support, provenance = [], []
        for r in results:
            e = r.entry
            support.append(e.text)
            provenance.append({
                "id": e.entry_id,
                "origin": "external",  # served from the CogniCore store, not the model
                "source": self.sources.get(e.entry_id, "cognicore-store"),
                "writtenAt": getattr(e, "timestamp", None),
                "score": round(getattr(r, "score", 0) or 0, 4),
            })
        return {"support": support, "provenance": provenance}

    def surface(self, new_fact):
        # pull-only: no unprompted-contradiction surface -> ABSENT on push rungs
        return {"supported": False}

    def set_auto_capture(self, enabled):
        self.auto = bool(enabled)
        return {"supported": True, "auto": self.auto}


def make_handler(adapter):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, obj, code=200):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path == "/name":
                self._send({"name": NAME})
            else:
                self._send({"error": "not found"}, 404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            try:
                if self.path == "/write":
                    self._send(adapter.write(body["fact"], body.get("source", "ingest")))
                elif self.path == "/query":
                    self._send(adapter.query(body["question"], body.get("top_k", 5)))
                elif self.path == "/surface":
                    self._send(adapter.surface(body.get("newFact", "")))
                elif self.path == "/setAutoCapture":
                    self._send(adapter.set_auto_capture(body.get("enabled", True)))
                elif self.path == "/reset":
                    self._send(adapter.reset())
                else:
                    self._send({"error": "not found"}, 404)
            except Exception as ex:  # surface adapter errors as 500, never crash
                self._send({"error": str(ex)}, 500)

    return Handler


def selftest():
    a = CogniCoreAdapter()
    # one private/novel fact the fixed model cannot know, plus distractors
    a.write("internal ticket SRV-4417 was closed by staging deploy 88b2", source="tickets.log")
    a.write("penguins are flightless birds", source="wiki")
    a.write("the Eiffel Tower is in Paris", source="wiki")
    q = "Who or what closed internal ticket SRV-4417?"
    out = a.query(q, top_k=3)
    print(json.dumps({"adapter": NAME, "query": q, **out}, indent=2))
    external = [p for p in out["provenance"] if p["origin"] == "external"]
    top = out["support"][0] if out["support"] else ""
    ok = bool(external) and "88b2" in top
    print("SELFTEST", "PASS" if ok else "FAIL",
          "| served-with-external-provenance:", bool(external),
          "| top-1 carries the private fact:", "88b2" in top)
    print("surface() push axis:", a.surface("x"), "(supported:false -> graded ABSENT, not FAIL)")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        port = 8091
        for i, arg in enumerate(sys.argv):
            if arg == "--port" and i + 1 < len(sys.argv):
                port = int(sys.argv[i + 1])
        HTTPServer(("127.0.0.1", port), make_handler(CogniCoreAdapter())).serve_forever()
