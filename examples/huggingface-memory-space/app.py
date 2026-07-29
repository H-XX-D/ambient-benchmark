from __future__ import annotations

import os
import re
import threading
import uuid
from collections import defaultdict

import gradio as gr
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


class ResetRequest(BaseModel):
    store: str | None = None


class WriteRequest(BaseModel):
    fact: str
    source: str = "ingest"
    store: str = "custom"
    edges: list[dict] = Field(default_factory=list)


class QueryRequest(BaseModel):
    question: str
    top_k: int = 8
    store: str = "custom"


class ToggleRequest(BaseModel):
    enabled: bool = False


class OptionalRequest(BaseModel):
    model_config = {"extra": "allow"}


app = FastAPI(title="AMBIENT memory adapter")
lock = threading.Lock()
stores: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))


def run_id(value: str | None) -> str:
    if not value or not re.fullmatch(r"[0-9a-f-]{36}", value):
        raise HTTPException(status_code=400, detail="X-AMBIENT-Run-ID is required")
    return value


def write_memory(run: str, request: WriteRequest) -> dict:
    """Replace this body with your memory system's write operation."""
    row = {
        "id": str(uuid.uuid4()),
        "text": request.fact,
        "source": request.source,
    }
    with lock:
        stores[run][request.store].append(row)
    return {"id": row["id"], "accepted": True}


def query_memory(run: str, request: QueryRequest) -> dict:
    """Replace this body with your memory system's retrieval operation."""
    terms = {term for term in re.findall(r"[a-z0-9]+", request.question.lower()) if len(term) > 2}
    with lock:
        rows = list(stores[run][request.store])
    ranked = sorted(
        rows,
        key=lambda row: len(terms & set(re.findall(r"[a-z0-9]+", row["text"].lower()))),
        reverse=True,
    )[: max(1, min(request.top_k, 20))]
    return {
        "support": [row["text"] for row in ranked],
        "provenance": [
            {"id": row["id"], "origin": "external", "source": row["source"]}
            for row in ranked
        ],
    }


@app.get("/name")
def name() -> dict:
    return {"name": "my-huggingface-memory"}


@app.post("/reset")
def reset(request: ResetRequest, x_ambient_run_id: str | None = Header(default=None)) -> dict:
    run = run_id(x_ambient_run_id)
    with lock:
        if request.store and request.store != "all":
            stores[run].pop(request.store, None)
        else:
            stores.pop(run, None)
    return {"ok": True}


@app.post("/write")
def write(request: WriteRequest, x_ambient_run_id: str | None = Header(default=None)) -> dict:
    return write_memory(run_id(x_ambient_run_id), request)


@app.post("/query")
def query(request: QueryRequest, x_ambient_run_id: str | None = Header(default=None)) -> dict:
    return query_memory(run_id(x_ambient_run_id), request)


@app.post("/setAutoCapture")
def set_auto_capture(request: ToggleRequest) -> dict:
    return {"supported": False, "auto": request.enabled}


@app.post("/surface")
@app.post("/dag")
@app.post("/collection")
def optional_capability(_: OptionalRequest) -> dict:
    return {"supported": False}


with gr.Blocks() as demo:
    gr.Markdown("# AMBIENT memory adapter\nThis Space is ready for the AMBIENT harness.")

app = gr.mount_gradio_app(app, demo, path="/ui")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "7860")))
