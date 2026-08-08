"""AMBIENT hosted runner for Hugging Face Gradio Spaces."""

from __future__ import annotations

import hashlib
import html
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
import zipfile
from pathlib import Path

import gradio as gr

try:
    import spaces
except ImportError:  # Local verification outside Hugging Face.
    class _SpacesFallback:
        @staticmethod
        def GPU(*_args, **_kwargs):
            def decorate(function):
                return function
            return decorate
    spaces = _SpacesFallback()


NODE_VERSION = "24.10.0"
NODE_RELEASES = {
    "x86_64": ("x64", "2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17"),
    "aarch64": ("arm64", "07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8"),
    "arm64": ("arm64", "07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8"),
}
ROOT = Path(__file__).resolve().parent
NODE_CACHE = Path("/tmp/ambient-node")
RUN_ROOT = Path("/tmp/ambient-space")
JOB_TTL_SECONDS = 30 * 60
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._:/-]{1,160}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

# Read-only public board. The publishable key is limited by Supabase RLS to the
# rows that already passed the publication gate.
SUPABASE_URL = os.getenv("AMBIENT_SUPABASE_URL", "https://nasxywilptctmfdbfpdw.supabase.co").strip().rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.getenv(
    "AMBIENT_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_4yW4erGxjwGNYzzJ-0c3Yg_QsYsBYFH",
).strip()

# Uploaded bundles are attacker-controlled input, so they are capped and
# extracted defensively before the certifier ever looks at them.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_UPLOAD_ENTRIES = 5000
ACTIVE_JOB: str | None = None
ACTIVE_LOCK = threading.Lock()
FIXED_READER_MODEL = "Qwen/Qwen3-32B"

SAMPLE_SCOPES = {
    13: {"label": "calibration smoke", "size": "small", "per_ability": 1, "margin": 27.2},
    52: {"label": "calibration set", "size": "small", "per_ability": 0, "margin": 13.6},
    260: {"label": "candidate-frozen hard protocol", "size": "medium-confirmatory-v2", "per_ability": 0, "margin": 6.1},
}

AMBIENT_ABILITIES = (
    "knowledge update",
    "contradiction resolution",
    "multi-session reasoning",
    "temporal reasoning",
    "event ordering",
    "information extraction",
    "preference following",
    "instruction following",
    "summarization",
    "abstention",
    "trust discrimination",
    "belief-revision audit",
    "poisoned-memory quarantine",
)

MEMORIES = {
    "external-space": "My Hugging Face memory Space",
    "recall": "Recall",
    "baseline-pull": "Lexical baseline control",
    "total-agent-memory-sqlite": "Total Agent Memory · SQLite bridge",
    "mcp-local-memory-sqlite": "MCP Local Memory · SQLite bridge",
    "sqlite-memory-mcp-sqlite": "SQLite Memory MCP · bridge",
    "agent-memory-sqlite": "Agent Memory · SQLite bridge",
    "mcp-memory-sqlite-personal": "MCP Memory SQLite Personal · bridge",
    "mcp-memory-keeper-sqlite": "Memory Keeper · SQLite bridge",
    "local-memory-mcp-sqlite": "Local Memory MCP · bridge",
    "mcp-memory-sqlite": "MCP Memory SQLite · bridge",
    "agent-memory-mcp-sqlite": "Agent Memory MCP · bridge",
}

HF_INFERENCE_ENDPOINT = "https://router.huggingface.co/v1"
@spaces.GPU(duration=1)
def _zerogpu_registration() -> str:
    """Register the Gradio Space with ZeroGPU; benchmark work remains CPU-side."""
    return "registered"


def installed_node() -> Path | None:
    candidate = shutil.which("node")
    if not candidate:
        return None
    try:
        version = subprocess.check_output([candidate, "--version"], text=True, timeout=5).strip()
        major = int(version.removeprefix("v").split(".", 1)[0])
        return Path(candidate) if major >= 24 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def safe_extract(archive: Path, destination: Path) -> None:
    destination_resolved = destination.resolve()
    with tarfile.open(archive, "r:xz") as bundle:
        for member in bundle.getmembers():
            target = (destination / member.name).resolve()
            if destination_resolved not in target.parents and target != destination_resolved:
                raise RuntimeError("Node archive contains an unsafe path")
        bundle.extractall(destination)


def download_node() -> Path:
    machine = platform.machine().lower()
    if machine not in NODE_RELEASES:
        raise RuntimeError(f"Unsupported Hugging Face runtime architecture: {machine}")
    release_arch, expected_sha256 = NODE_RELEASES[machine]
    directory = f"node-v{NODE_VERSION}-linux-{release_arch}"
    binary = NODE_CACHE / directory / "bin" / "node"
    if binary.exists():
        return binary
    filename = f"{directory}.tar.xz"
    url = f"https://nodejs.org/download/release/v{NODE_VERSION}/{filename}"
    NODE_CACHE.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=NODE_CACHE, suffix=".tar.xz", delete=False) as tmp:
        archive = Path(tmp.name)
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response:
            while chunk := response.read(1024 * 1024):
                tmp.write(chunk)
                digest.update(chunk)
    try:
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError("Downloaded Node archive failed SHA-256 verification")
        safe_extract(archive, NODE_CACHE)
    finally:
        archive.unlink(missing_ok=True)
    if not binary.exists():
        raise RuntimeError("Verified Node archive did not contain the expected binary")
    return binary


NODE = installed_node() or download_node()


def redact(value: str, secrets: list[str]) -> str:
    output = str(value or "")
    for secret in secrets:
        if secret:
            output = output.replace(secret, "[redacted]")
    return output


def model_name(value: str, label: str) -> str:
    text = str(value or "").strip()
    if not MODEL_PATTERN.fullmatch(text):
        raise ValueError(f"{label} model ID is invalid")
    return text


def oauth_provider_config(model: str, oauth_token: gr.OAuthToken | None, label: str) -> dict:
    if oauth_token is None or not str(oauth_token.token or "").strip():
        raise ValueError("Sign in with Hugging Face before starting a run.")
    clean_token = str(oauth_token.token).strip()
    return {
        "id": "huggingface",
        "label": "Hugging Face Inference",
        "endpoint": HF_INFERENCE_ENDPOINT,
        "model": model_name(model, label),
        "key": clean_token,
    }


def normalize_memory_space_url(value: str) -> str:
    text = str(value or "").strip()
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError as error:
        raise ValueError("Memory Space URL must be a valid URL.") from error
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hf\.space", hostname):
        raise ValueError("Memory Space URL must use a public https://…hf.space origin.")
    if parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment:
        raise ValueError("Memory Space URL cannot contain credentials, a port, query parameters, or a fragment.")
    if parsed.path not in ("", "/"):
        raise ValueError("Memory Space URL must be the Space origin with no path.")
    return f"https://{hostname}"


def copy_if_repo_file(candidate: str | None, destination: Path) -> None:
    if not candidate:
        return
    source = Path(candidate)
    if not source.is_absolute():
        source = ROOT / source
    source = source.resolve()
    try:
        source.relative_to(ROOT.resolve())
    except ValueError:
        return
    if source.is_file():
        shutil.copy2(source, destination / source.name)


def cleanup_jobs() -> None:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - JOB_TTL_SECONDS
    with ACTIVE_LOCK:
        active = ACTIVE_JOB
    for path in RUN_ROOT.iterdir():
        if path.is_dir() and path.name != active and path.stat().st_mtime < cutoff:
            shutil.rmtree(path, ignore_errors=True)


def cleanup_loop() -> None:
    while True:
        time.sleep(300)
        cleanup_jobs()


threading.Thread(target=cleanup_loop, daemon=True).start()


def run_benchmark(
    memory: str,
    memory_space_url: str,
    sample_size: int,
    oauth_token: gr.OAuthToken,
    progress=gr.Progress(),
):
    global ACTIVE_JOB
    cleanup_jobs()
    if memory not in MEMORIES:
        raise gr.Error("Memory adapter is not supported.")
    question_count = int(sample_size)
    if question_count not in SAMPLE_SCOPES:
        raise gr.Error("Sample size is not supported.")
    scope = SAMPLE_SCOPES[question_count]
    external_adapter_url = ""
    if memory == "external-space":
        try:
            external_adapter_url = normalize_memory_space_url(memory_space_url)
        except ValueError as error:
            raise gr.Error(str(error)) from None

    secrets: list[str] = []
    try:
        reader = oauth_provider_config(FIXED_READER_MODEL, oauth_token, "reader")
        secrets = [reader["key"]]

        job_id = str(uuid.uuid4())
        with ACTIVE_LOCK:
            ACTIVE_JOB = job_id
        job_dir = RUN_ROOT / job_id
        evidence_dir = job_dir / "evidence"
        matrix_path = job_dir / "matrix.json"
        grades_path = job_dir / "grades.json"
        job_dir.mkdir(parents=True, exist_ok=False)
        evidence_dir.mkdir()
        (ROOT / "results").mkdir(exist_ok=True)

        progress(0.05, desc="Preparing controlled run")
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")
            if key in os.environ
        }
        environment.update({
            "AMBIENT_MODEL_BACKEND": "online",
            "AMBIENT_MODEL_ENDPOINT": reader["endpoint"],
            "AMBIENT_MODEL": reader["model"],
            "AMBIENT_API_KEY": reader["key"],
            "AMBIENT_CHECKER_BACKEND": "online",
            "AMBIENT_CHECKER_ENDPOINT": reader["endpoint"],
            "AMBIENT_CHECKER_MODEL": reader["model"],
            "AMBIENT_CHECKER_KEY": reader["key"],
        })
        command = [
            str(NODE),
            "scripts/verify-cross-adapter-grade-pipeline.mjs",
            "--use-external-model",
            "--mechanical-hard",
            "--adapters", memory,
            "--source", "hard",
            "--size", scope["size"],
            "--limit", "0",
            "--matrix", str(matrix_path),
            "--out", str(grades_path),
            "--adapter-timeout-ms", "21600000",
            "--matrix-timeout-ms", "21600000",
        ]
        if scope["per_ability"]:
            command.extend(["--per-ability", str(scope["per_ability"])])
        if external_adapter_url:
            command.extend(["--external-adapter-url", external_adapter_url])
        progress(0.15, desc="Running T1–T4 with the fixed reader")
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=43200,
            check=False,
        )
        process_log = redact(f"{completed.stdout}\n{completed.stderr}", secrets).strip()
        if completed.returncode != 0:
            raise RuntimeError(f"Harness exited {completed.returncode}.\n{process_log[-2400:]}")

        progress(0.86, desc="Packaging traceable evidence")
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        grades = json.loads(grades_path.read_text(encoding="utf-8"))
        entry = next((item for item in matrix.get("adapters", []) if item.get("id") == memory), None)
        grade = next((item for item in grades.get("adapters", []) if item.get("id") == memory), None)
        if not entry or not grade:
            raise RuntimeError("Harness completed without the selected adapter artifact.")

        if question_count == 260:
            progress(0.90, desc="Checking complete-run integrity")
            gate = subprocess.run(
                [
                    str(NODE),
                    "scripts/check-cross-adapter-grades.mjs",
                    "--artifact", str(grades_path),
                    "--expect-adapters", memory,
                    "--expect-rows", "1040",
                    "--require-all-passed",
                ],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            gate_log = redact(f"{gate.stdout}\n{gate.stderr}", secrets).strip()
            if gate.returncode != 0:
                raise RuntimeError(f"Complete-run integrity check failed.\n{gate_log[-2400:]}")

        for candidate in (
            entry.get("transcript"),
            entry.get("manifest"),
            grade.get("verdicts"),
            grade.get("summary"),
            grade.get("judgeManifest"),
        ):
            copy_if_repo_file(candidate, evidence_dir)
        run_manifest_path = entry.get("manifest")
        if not run_manifest_path:
            raise RuntimeError("Harness completed without a run manifest path.")
        run_manifest_file = Path(run_manifest_path)
        if not run_manifest_file.is_absolute():
            run_manifest_file = ROOT / run_manifest_file
        run_manifest = json.loads(run_manifest_file.read_text(encoding="utf-8"))
        sampling = run_manifest.get("design", {}).get("sampling", {})
        shutil.copy2(matrix_path, evidence_dir / "matrix.json")
        shutil.copy2(grades_path, evidence_dir / "grades.json")
        completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        space_run = {
            "schema": "ambient.space-run.v1",
            "generatedAt": completed_at,
            "track": "development",
            "publicationStatus": "unreviewed",
            "memory": memory,
            "memorySpaceUrl": external_adapter_url or None,
            "reader": {"provider": reader["id"], "endpoint": reader["endpoint"], "model": reader["model"]},
            "scorer": {"type": "deterministic", "model": "ambient-mechanical-oracle-v2"},
            "source": "hard",
            "size": scope["size"],
            "questions": question_count,
            "perAbility": scope["per_ability"] or None,
            "abilities": list(AMBIENT_ABILITIES),
            "sampling": sampling,
            "estimatedReaderAnswerCalls": 4 * question_count,
            "estimatedJudgeCalls": 0,
            "credentialHandling": "Hugging Face OAuth; short-lived user token; excluded from logs and artifacts",
        }
        (evidence_dir / "space-run.json").write_text(json.dumps(space_run, indent=2) + "\n", encoding="utf-8")
        (evidence_dir / "README.txt").write_text(
            "This Space run is unreviewed and is not published automatically.\n"
            "Keep this bundle if you want to share the result through Hugging Face or request an integrity review.\n",
            encoding="utf-8",
        )
        bundle_path = job_dir / f"ambient-{job_id}.tar.gz"
        with tarfile.open(bundle_path, "w:gz") as archive:
            for path in sorted(evidence_dir.iterdir()):
                archive.add(path, arcname=path.name)

        completion = grade.get("completion", {})
        deltas = grade.get("deltas", {})
        by_tier = grade.get("byTier", {})
        uncertainty = grade.get("uncertainty", {})
        lift_interval = uncertainty.get("intervals95", {}).get("T4", ["—", "—"])
        gullible = sum(int(tier.get("gullible", 0)) for tier in by_tier.values())
        untraced = sum(int(tier.get("untraced", 0)) for tier in by_tier.values())
        not_served = sum(int(tier.get("notServed", 0)) for tier in by_tier.values())
        summary = (
            "## Space result · unreviewed\n\n"
            f"**Memory:** {MEMORIES[memory]}"
            f"{' · `' + external_adapter_url + '`' if external_adapter_url else ''}  \n"
            f"**Reader:** {reader['label']} / `{reader['model']}`  \n"
            "**Scorer:** deterministic AMBIENT mechanical oracle v2  \n\n"
            f"**Scope:** {question_count} unique questions · {sampling.get('selectedAbilities', '—')}/"
            f"{sampling.get('availableAbilities', '—')} abilities · {sampling.get('minPerAbility', '—')}–"
            f"{sampling.get('maxPerAbility', '—')} per ability  \n"
            f"**Approximate worst-case single-tier margin:** ±{scope['margin']} points  \n\n"
            f"**Attributed memory lift (T4−T1): {deltas.get('T4', '—')} points**  \n"
            f"Paired 95% interval: [{lift_interval[0]}, {lift_interval[1]}] points · "
            f"{uncertainty.get('clusters', '—')} unique segment clusters  \n"
            f"T1 no memory: {completion.get('T1', '—')}% · "
            f"T4 memory isolated: {completion.get('T4', '—')}% · "
            f"T3 full composition: {completion.get('T3', '—')}%  \n"
            f"Gullible: {gullible} · Untraced: {untraced} · Needed evidence not served: {not_served} · "
            f"Scorer errors: {grade.get('judgeErrors', '—')}\n\n"
            "**Publication:** Nothing is posted automatically. Download the evidence bundle to keep or share this run."
        )
        progress(1.0, desc="Evidence bundle ready")
        return summary, str(bundle_path)
    except gr.Error:
        raise
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as error:
        raise gr.Error(redact(str(error), secrets)[:2600]) from None
    finally:
        secrets.clear()
        with ACTIVE_LOCK:
            ACTIVE_JOB = None


CSS = """
:root { --ink:#101217; --paper:#f2f0e9; --panel:#ffffff; --white:#ffffff; --fg:#101217; --muted:#64666d; --line:#c8c5bc; --signal:#e84732; --rule:#ddd9cf; }
html, body { max-width:100%; overflow-x:hidden; }
/* Hugging Face embeds a Space in an iframe carrying scrolling="no" and
   overflow-hidden, so the embedded document is not permitted to scroll and
   Gradio's own container defaults to overflow-y:hidden. Together that leaves
   no scrollable element at all: anything below the fold becomes unreachable,
   which is exactly what happened once the submission panel made the page tall.
   The app therefore owns its scrolling instead of relying on the embedder. */
html, body { height:100%; }
.gradio-container { max-height:100vh; overflow-y:auto !important; }
body, .gradio-container { background:var(--paper) !important; color:var(--fg) !important; }
.gradio-container { max-width:none !important; padding:0 !important; font-family:Inter,ui-sans-serif,system-ui,sans-serif !important; }
#ambient-shell { width:100%; max-width:1320px; margin:0 auto; padding:22px; box-sizing:border-box; }
.ambient-header { display:grid; grid-template-columns:1fr minmax(280px,.55fr); gap:32px; align-items:end; padding:24px 0 22px; border-bottom:1px solid var(--line); }
.ambient-header span, .ambient-label { color:var(--signal) !important; font-size:.72rem; font-weight:750; letter-spacing:.09em; text-transform:uppercase; }
.ambient-header h1 { margin:7px 0 0; color:var(--fg) !important; font-size:clamp(2.1rem,4.7vw,4.6rem) !important; font-weight:620 !important; line-height:.95 !important; letter-spacing:-.055em !important; }
.ambient-header .ambient-subtitle { margin:12px 0 0; max-width:720px; color:var(--fg) !important; font-size:clamp(1rem,1.75vw,1.45rem) !important; font-weight:540 !important; line-height:1.18 !important; letter-spacing:-.025em !important; }
.ambient-header p { margin:0; color:var(--muted) !important; font-size:.92rem !important; line-height:1.6 !important; }
.ambient-intro { display:grid; grid-template-columns:180px 1fr; gap:28px; padding:24px 0 2px; }
.ambient-intro h2 { margin:0; color:var(--fg) !important; font-size:clamp(1.35rem,2.3vw,2.15rem) !important; font-weight:620 !important; letter-spacing:-.035em !important; line-height:1.08 !important; }
.ambient-intro-copy { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
.ambient-intro p { margin:0; color:var(--muted) !important; font-size:.9rem !important; line-height:1.62 !important; }
.ambient-intro strong { color:var(--fg); font-weight:650; }
#ambient-leaderboard { margin:0 !important; }
.ambient-board { margin:22px 0; color:var(--ink); background:var(--white); border:1px solid var(--rule); }
.ambient-board span { color:var(--signal) !important; font-size:.72rem; font-weight:750; letter-spacing:.09em; text-transform:uppercase; }
.ambient-board-head { display:grid; grid-template-columns:1fr minmax(320px,.6fr); gap:28px; align-items:end; padding:24px 26px; border-bottom:1px solid var(--rule); }
.ambient-board h2 { margin:5px 0 0; color:var(--ink) !important; font-size:clamp(1.8rem,3.3vw,3.3rem) !important; font-weight:620 !important; letter-spacing:-.045em !important; }
.ambient-board-head p, .ambient-board-empty > p { margin:0; color:#595a56 !important; font-size:.86rem !important; line-height:1.55 !important; }
.ambient-board-empty { padding:24px 26px; }
.ambient-board-empty header { margin-bottom:10px; }
.ambient-leader { display:grid; grid-template-columns:1fr auto; gap:18px 34px; padding:28px 26px; color:var(--white); background:var(--ink); }
.ambient-leader span { color:#ff8a72 !important; }
.ambient-leader h3 { margin:5px 0 4px; color:var(--white) !important; font-size:clamp(2rem,4vw,4rem) !important; font-weight:620 !important; letter-spacing:-.05em !important; line-height:.95 !important; }
.ambient-leader p { margin:0; color:#b4b5b0 !important; font-size:.84rem !important; }
.ambient-leader > strong { align-self:center; color:var(--signal); font-size:clamp(2.1rem,5vw,5rem); font-weight:620; letter-spacing:-.055em; white-space:nowrap; }
.ambient-leader dl { grid-column:1/-1; display:grid; grid-template-columns:repeat(4,1fr); margin:8px 0 0; border-top:1px solid #444; }
.ambient-leader dl div { padding:13px 0 0; }
.ambient-leader dt { color:#8f918d; font-size:.67rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
.ambient-leader dd { margin:4px 0 0; color:var(--white); font-size:.86rem; }
.ambient-board-table { overflow-x:auto; }
.ambient-board table { width:100%; border-collapse:collapse; font-size:.78rem; }
.ambient-board th, .ambient-board td { padding:12px 10px; text-align:left; border-bottom:1px solid var(--rule); white-space:nowrap; }
.ambient-board th { color:#666761; font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; }
.ambient-board td { color:#444540; }
.ambient-board td.score { color:var(--signal); font-weight:700; }
#ambient-submit { max-width:1320px; margin:0 auto; padding:26px 22px 44px; }
#ambient-submit > * { max-width:100%; }
.ambient-submit-rule { max-width:1320px; margin:14px auto 0; padding:0 22px; }
.ambient-submit-rule hr { margin:0; border:0; border-top:1px solid var(--line); }
.ambient-submit-copy { margin:0 0 12px; max-width:900px; color:var(--muted) !important; font-size:.9rem !important; line-height:1.62 !important; }
.ambient-submit-cmd { margin:0 0 18px; padding:14px 16px; overflow-x:auto; background:var(--ink); border:0; }
.ambient-submit-cmd code { color:#f2f0e9; font-size:.78rem; }
.ambient-certify { margin:18px 0 0; border:1px solid var(--rule); background:var(--white); }
.ambient-certify header { padding:20px 22px 0; }
.ambient-certify span { color:var(--signal) !important; font-size:.72rem; font-weight:750; letter-spacing:.09em; text-transform:uppercase; }
.ambient-certify h3 { margin:5px 0 0; color:var(--ink) !important; font-size:1.5rem !important; font-weight:620 !important; letter-spacing:-.035em !important; }
.ambient-certify p { margin:0; padding:14px 22px 20px; color:#595a56 !important; font-size:.86rem !important; }
.ambient-certify ul { margin:14px 0 0; padding:0 22px; list-style:none; }
.ambient-certify li { padding:11px 0; border-top:1px solid var(--rule); color:#444540; font-size:.82rem; }
.ambient-certify li code { display:block; margin-bottom:3px; color:var(--signal); font-size:.72rem; font-weight:700; }
.ambient-certify table { width:100%; margin:14px 0 0; border-collapse:collapse; font-size:.82rem; }
.ambient-certify td { padding:11px 22px; border-top:1px solid var(--rule); color:#444540; }
.ambient-certify-pass { border-left:3px solid #2f7d5a; }
.ambient-certify-fail { border-left:3px solid var(--signal); }
#ambient-workspace { width:100%; gap:0 !important; margin:22px 0 0 !important; align-items:stretch !important; }
#ambient-workspace > div { min-width:0 !important; }
.ambient-run-copy, .ambient-form { min-width:0 !important; min-height:100%; border:1px solid var(--line) !important; border-radius:0 !important; box-shadow:none !important; }
.ambient-run-copy { padding:30px !important; background:var(--paper) !important; border-right:0 !important; }
.ambient-form { padding:28px 30px 32px !important; background:var(--panel) !important; }
.ambient-run-copy h2 { margin:8px 0 18px; color:var(--fg) !important; font-size:clamp(1.8rem,3vw,3rem); font-weight:620; letter-spacing:-.045em; line-height:1; }
.ambient-run-copy p, .ambient-form-copy { color:var(--muted) !important; font-size:.9rem; line-height:1.62; }
.ambient-facts { margin:26px 0 0; padding:0; list-style:none; border-top:1px solid var(--line); }
.ambient-facts li { display:grid; grid-template-columns:78px 1fr; gap:12px; padding:13px 0; color:var(--muted); border-bottom:1px solid var(--line); font-size:.82rem; line-height:1.45; }
.ambient-facts b { color:var(--signal); font-size:.69rem; letter-spacing:.06em; text-transform:uppercase; }
.ambient-fieldset { margin:0 0 16px !important; padding:0 !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; background:transparent !important; }
.ambient-form label, .ambient-form .label-wrap { color:var(--fg) !important; font-size:.82rem !important; font-weight:650 !important; }
.ambient-form input, .ambient-form textarea, .ambient-form [role="combobox"] { min-height:46px !important; color:var(--fg) !important; background:#ffffff !important; border-color:var(--line) !important; font-size:.94rem !important; }
.ambient-login { margin-bottom:12px !important; }
button.ambient-run { min-height:54px !important; background:var(--signal) !important; color:var(--fg) !important; border:1px solid var(--signal) !important; border-radius:0 !important; font-size:.94rem !important; font-weight:750 !important; box-shadow:none !important; }
button.ambient-run:hover { background:var(--white) !important; color:var(--ink) !important; border-color:var(--white) !important; }
#ambient-results { max-width:1320px; margin:0 auto; padding:0 22px 34px; }
.ambient-result-head { padding:28px 0 12px; border-top:1px solid var(--line); }
.ambient-result-head h2 { margin:5px 0 0; color:var(--fg) !important; font-size:1.8rem; letter-spacing:-.035em; }
.ambient-export { min-height:52px !important; background:var(--white) !important; color:var(--ink) !important; border:1px solid var(--white) !important; border-radius:0 !important; font-weight:750 !important; }
footer { display:none !important; }
@media (max-width:800px) {
  #ambient-shell { padding:12px; }
  .ambient-header, .ambient-intro, .ambient-intro-copy { grid-template-columns:1fr; }
  #ambient-workspace { display:block !important; min-width:0 !important; }
  #ambient-workspace > div, .ambient-run-copy, .ambient-form { width:100% !important; max-width:100% !important; min-width:0 !important; box-sizing:border-box !important; }
  .ambient-run-copy, .ambient-form { padding:24px 20px !important; border:1px solid var(--line) !important; }
  .ambient-form { border-top:0 !important; }
  .ambient-form .form, .ambient-form .wrap, .ambient-form .container { min-width:0 !important; }
  #ambient-results { padding:0 12px 24px; }
}
"""

def fetch_hosted_runs(limit: int = 50) -> list[dict]:
    """Read public, gate-passed hosted results through Supabase RLS."""
    if not SUPABASE_URL.startswith("https://") or not SUPABASE_PUBLISHABLE_KEY:
        raise RuntimeError("Hosted leaderboard is not configured.")
    query = urllib.parse.urlencode({
        "publication_status": "eq.hosted",
        "select": (
            "id,memory_name,reader_model,judge_model,item_count,score,lower95,upper95,"
            "baseline,treatment,control_key,completed_at"
        ),
        "order": "score.desc,completed_at.asc",
        "limit": str(max(1, min(int(limit), 100))),
    })
    request = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/ambient_hosted_runs?{query}",
        headers={"Accept": "application/json", "apikey": SUPABASE_PUBLISHABLE_KEY},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"Hosted leaderboard returned HTTP {response.status}.")
        rows = json.loads(response.read().decode("utf-8"))
    if not isinstance(rows, list):
        raise RuntimeError("Hosted leaderboard returned an invalid payload.")
    return [row for row in rows if isinstance(row, dict)]


def points(value: object) -> str:
    try:
        return f"{float(value):+.1f} pp"
    except (TypeError, ValueError):
        return "—"


def percent(value: object) -> str:
    try:
        return f"{float(value):.1f}%"
    except (TypeError, ValueError):
        return "—"


def hosted_leaderboard_html() -> str:
    """Render the public hosted-run board, highest reported lift first."""
    try:
        rows = fetch_hosted_runs()
    except (RuntimeError, OSError, urllib.error.URLError, json.JSONDecodeError):
        return """
          <section class="ambient-board ambient-board-empty">
            <header><span>Hosted leaderboard</span><h2>Results unavailable</h2></header>
            <p>The runner remains available. The hosted-results table could not be read.</p>
          </section>
        """
    if not rows:
        return """
          <section class="ambient-board ambient-board-empty">
            <header><span>Hosted leaderboard</span><h2>No certified runs yet</h2></header>
            <p>The first run to clear the automated certifier appears here. Complete a hosted run, or upload a locally-run bundle with its corpus attestation.</p>
          </section>
        """

    leader = rows[0]
    leader_memory = html.escape(str(leader.get("memory_name", "Unknown memory")))
    leader_reader = html.escape(str(leader.get("reader_model", "Unknown reader")))
    leader_control = html.escape(str(leader.get("control_key", "—")))
    leader_date = html.escape(str(leader.get("completed_at", ""))[:10])

    table_rows: list[str] = []
    for rank, row in enumerate(rows, start=1):
        memory = html.escape(str(row.get("memory_name", "Unknown memory")))
        reader = html.escape(str(row.get("reader_model", "Unknown reader")))
        control = html.escape(str(row.get("control_key", "—")))
        completed = html.escape(str(row.get("completed_at", ""))[:10])
        table_rows.append(
            "<tr>"
            f"<td>#{rank:02d}</td><td><strong>{memory}</strong></td>"
            f"<td class=\"score\">{points(row.get('score'))}</td>"
            f"<td>{percent(row.get('baseline'))}</td><td>{percent(row.get('treatment'))}</td>"
            f"<td><code>{reader}</code></td><td><code>{control}</code></td><td>{completed}</td>"
            "</tr>"
        )

    return f"""
      <section class="ambient-board">
        <header class="ambient-board-head">
          <div><span>Hosted leaderboard</span><h2>Certified public runs</h2></div>
          <p>Every row cleared the automated certifier. Ordered by reported T4−T1 lift. Match control keys before comparing architectures.</p>
        </header>
        <article class="ambient-leader">
          <div><span>Current leader</span><h3>{leader_memory}</h3><p>{leader_reader}</p></div>
          <strong>{points(leader.get('score'))}</strong>
          <dl><div><dt>T1</dt><dd>{percent(leader.get('baseline'))}</dd></div><div><dt>T4</dt><dd>{percent(leader.get('treatment'))}</dd></div><div><dt>Control</dt><dd>{leader_control}</dd></div><div><dt>Completed</dt><dd>{leader_date}</dd></div></dl>
        </article>
        <div class="ambient-board-table"><table><thead><tr><th>Rank</th><th>Memory</th><th>Lift</th><th>T1</th><th>T4</th><th>Reader</th><th>Control</th><th>Date</th></tr></thead><tbody>{''.join(table_rows)}</tbody></table></div>
      </section>
    """


def protocol_corpus_sha256() -> str:
    """The frozen corpus digest a locally-run submission has to match."""
    lock = json.loads((ROOT / "protocols" / "ambient-hard-hosted-v3.json").read_text(encoding="utf-8"))
    return str(lock["hashes"]["corpus"]["sha256"])


def extract_bundle(archive_path: Path, destination: Path) -> Path:
    """Extract an uploaded bundle without letting it escape `destination`."""
    destination.mkdir(parents=True, exist_ok=True)
    if archive_path.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError("Bundle is larger than the 64 MB upload limit.")

    root = destination.resolve()

    def guard(name: str) -> Path:
        target = (destination / name).resolve()
        if target != root and not str(target).startswith(f"{root}{os.sep}"):
            raise ValueError(f"Bundle entry escapes the extraction directory: {name}")
        return target

    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as bundle:
            entries = bundle.infolist()
            if len(entries) > MAX_UPLOAD_ENTRIES:
                raise ValueError("Bundle contains too many entries.")
            if sum(entry.file_size for entry in entries) > MAX_UPLOAD_BYTES:
                raise ValueError("Bundle expands beyond the 64 MB limit.")
            for entry in entries:
                guard(entry.filename)
            bundle.extractall(destination)
    else:
        with tarfile.open(archive_path) as bundle:
            members = bundle.getmembers()
            if len(members) > MAX_UPLOAD_ENTRIES:
                raise ValueError("Bundle contains too many entries.")
            if sum(max(member.size, 0) for member in members) > MAX_UPLOAD_BYTES:
                raise ValueError("Bundle expands beyond the 64 MB limit.")
            for member in members:
                if member.issym() or member.islnk():
                    raise ValueError(f"Bundle contains a link entry: {member.name}")
                guard(member.name)
            bundle.extractall(destination)

    # submission.json may sit at the root or one directory down.
    direct = destination / "submission.json"
    if direct.is_file():
        return destination
    for candidate in sorted(destination.rglob("submission.json")):
        return candidate.parent
    raise ValueError("Bundle does not contain submission.json.")


def render_report(report: dict) -> str:
    failed = [check for check in report.get("checks", []) if not check.get("passed")]
    total = len(report.get("checks", []))
    if report.get("ok"):
        entry = report.get("entry") or {}
        rows = "".join(
            f"<tr><td>{html.escape(str(key))}</td><td><code>{html.escape(str(value))}</code></td></tr>"
            for key, value in (
                ("System", (entry.get("system") or {}).get("name", "—")),
                ("Track", entry.get("track", "—")),
                ("Score", entry.get("result", {}).get("score", "—")),
                ("Control key", entry.get("controlKey", "—")),
            )
        )
        return (
            '<section class="ambient-certify ambient-certify-pass">'
            f"<header><span>Certified</span><h3>All {total} checks passed</h3></header>"
            f"<table>{rows}</table>"
            "<p>This bundle is eligible for publication review.</p>"
            "</section>"
        )
    items = "".join(
        f"<li><code>{html.escape(str(check.get('name')))}</code>{html.escape(str(check.get('message')))}</li>"
        for check in failed
    )
    return (
        '<section class="ambient-certify ambient-certify-fail">'
        f"<header><span>Not certified</span><h3>{len(failed)} of {total} checks failed</h3></header>"
        f"<ul>{items}</ul>"
        "<p>Nothing is submitted until every check passes.</p>"
        "</section>"
    )


def certify_bundle(bundle_file: object, corpus_hash: str, progress=gr.Progress()) -> str:
    """Run the automated certifier over an uploaded evidence bundle."""
    if not bundle_file:
        return (
            '<section class="ambient-certify ambient-certify-idle">'
            "<p>Upload a bundle (.zip or .tar.gz) to certify it.</p></section>"
        )

    supplied = str(corpus_hash or "").strip().lower()
    if supplied and not SHA256_PATTERN.fullmatch(supplied):
        return (
            '<section class="ambient-certify ambient-certify-fail">'
            "<header><span>Not certified</span><h3>Corpus attestation is malformed</h3></header>"
            "<p>The corpus attestation must be a 64-character lowercase SHA-256 digest.</p></section>"
        )

    workspace = RUN_ROOT / f"certify-{uuid.uuid4().hex}"
    try:
        progress(0.2, desc="Extracting bundle")
        source = Path(getattr(bundle_file, "name", bundle_file))
        bundle_dir = extract_bundle(source, workspace)

        progress(0.6, desc="Certifying evidence")
        command = [str(NODE), "scripts/certify-submission.mjs", str(bundle_dir), "--json"]
        if supplied:
            command.extend(["--corpus-hash", supplied])
        completed = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, timeout=900, check=False,
        )
        if not completed.stdout.strip():
            raise RuntimeError(completed.stderr.strip()[-1200:] or "The certifier produced no output.")
        return render_report(json.loads(completed.stdout))
    except (ValueError, RuntimeError, OSError, tarfile.TarError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        return (
            '<section class="ambient-certify ambient-certify-fail">'
            "<header><span>Not certified</span><h3>The bundle could not be read</h3></header>"
            f"<p>{html.escape(str(error))}</p></section>"
        )
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


with gr.Blocks(
    title="AMBIENT Agentic memory baseline isolated evaluation w/ Neutral Tiers",
    analytics_enabled=False,
    delete_cache=(1800, 300),
    fill_width=True,
) as demo:
    with gr.Column(elem_id="ambient-shell"):
        gr.HTML("""
          <header class="ambient-header">
            <div><span>AMBIENT / hosted runner</span><h1>AMBIENT</h1><p class="ambient-subtitle">Agentic memory baseline isolated evaluation w/ Neutral Tiers</p></div>
            <p>The Space runs a standardized memory test, returns an evidence bundle, and certifies bundles for the board. It never publishes a result automatically: every row must clear the automated certifier first.</p>
          </header>
        """)

        gr.HTML("""
          <section class="ambient-intro" aria-labelledby="ambient-intro-title">
            <h2 id="ambient-intro-title">What is being measured</h2>
            <div class="ambient-intro-copy">
              <p>AMBIENT estimates what a <strong>memory system adds</strong> to one fixed reader. The same private worlds, questions, fixed reader, exact scorer, prompts, and budgets are used while only the memory condition changes across four neutral tiers.</p>
              <p>A correct answer earns memory credit only when the harness recorded non-empty evidence crossing the adapter boundary. Correct-but-untraced answers remain reader accuracy; misleading memory, empty retrieval, and gullible answers are reported separately. <strong>This is not a model ranking.</strong></p>
            </div>
          </section>
        """)

        board_output = gr.HTML(elem_id="ambient-leaderboard")

        with gr.Row(elem_id="ambient-workspace"):
            with gr.Column(scale=4, min_width=300, elem_classes="ambient-run-copy"):
                gr.HTML("""
                  <span class="ambient-label">Run</span>
                  <h2>Controlled evaluation</h2>
                  <p>Connect your own Hugging Face memory Space, choose a scope, and let the hard evaluator run. The reader is fixed, answers are checked by exact mechanical oracles, and T4−T1 is reported as attributed memory lift.</p>
                  <ul class="ambient-facts">
                    <li><b>Bring yours</b><span>Your Space implements the AMBIENT HTTP adapter contract. The runner sends it writes and queries but never executes uploaded code.</span></li>
                    <li><b>Worlds</b><span>The proper hard evaluator contains 52 calibration worlds or 260 candidate-frozen worlds across 13 reader-facing abilities. Every world has opaque private values, cover history, and an exact answer oracle.</span></li>
                    <li><b>Abilities</b><span>Knowledge update, contradiction resolution, multi-session reasoning, temporal reasoning, event ordering, information extraction, preference following, instruction following, summarization, abstention, trust discrimination, belief-revision audit, and poisoned-memory quarantine.</span></li>
                    <li><b>18 areas</b><span>Recall's full 18-area structural profile remains a separate AMBIENT axis. It is included in the downloadable benchmark and is never disguised here as prose questions or collapsed into the 13 hard abilities.</span></li>
                    <li><b>Isolation</b><span>Every question runs in T1 no-memory, T2 reference-capture, T3 capture-plus-selected-memory, and T4 selected-memory-only conditions.</span></li>
                    <li><b>Retrieval</b><span>The harness checks whether the memory was queried and whether it served non-empty external evidence to the reader.</span></li>
                    <li><b>Scoring</b><span>The generated oracle grades each answer correct, wrong, or gullible without an LLM judge; it cannot create memory credit without a served-evidence trace.</span></li>
                    <li><b>Attribution</b><span>Correct-and-traced becomes completed. Correct-but-untraced, not-served, wrong, and gullible remain separate outcomes.</span></li>
                    <li><b>Integrity</b><span>The complete 260-world bundle must contain all 1,040 mechanically scored tier rows, zero reader or scorer errors, uncertainty, and evidence fingerprints.</span></li>
                  </ul>
                """)

            with gr.Column(scale=6, min_width=420, elem_classes="ambient-form"):
                gr.LoginButton("Sign in with Hugging Face", elem_classes="ambient-login")
                gr.HTML(f'<p class="ambient-form-copy"><strong>Fixed control:</strong> reader <code>{FIXED_READER_MODEL}</code>. Scoring is local and deterministic; no judge-model calls are made. Reader inference usage is charged to the signed-in account.</p>')
                memory_input = gr.Dropdown(
                    choices=[(label, key) for key, label in MEMORIES.items()],
                    value="external-space",
                    label="Memory under test",
                    elem_classes="ambient-fieldset",
                )
                memory_space_url_input = gr.Textbox(
                    placeholder="https://your-memory-space.hf.space",
                    label="Your memory Space URL",
                    info="Required for ‘My Hugging Face memory Space’. Public HTTPS Space origins only.",
                    elem_classes="ambient-fieldset",
                )
                sample_input = gr.Dropdown(
                    choices=[
                        ("13 · calibration smoke · 1 per ability · ~±27.2 points", 13),
                        ("52 · complete calibration set · 4 per ability · ~±13.6 points", 52),
                        ("260 · candidate-frozen hard protocol · 20 per ability · ~±6.1 points", 260),
                    ],
                    value=13,
                    label="AMBIENT hard worlds",
                    elem_classes="ambient-fieldset",
                )
                run_button = gr.Button("Run evaluation", variant="primary", elem_classes="ambient-run")

    with gr.Column(elem_id="ambient-results"):
        gr.HTML('<div class="ambient-result-head"><span class="ambient-label">Result</span><h2>Run summary</h2></div>')
        result_output = gr.Markdown()
        bundle_output = gr.DownloadButton("Export evidence bundle", value=None, elem_classes="ambient-export")

    gr.HTML('<div class="ambient-submit-rule"><hr /></div>')

    with gr.Column(elem_id="ambient-submit"):
        gr.HTML(f"""
          <div class="ambient-result-head"><span class="ambient-label">Submit</span><h2>Certify a run</h2></div>
          <p class="ambient-submit-copy">Upload an evidence bundle to run the automated certifier. It re-derives every published number from your raw artifacts instead of trusting the summary, and nothing reaches the leaderboard until all checks pass.</p>
          <p class="ambient-submit-copy"><strong>Ran locally?</strong> You must attest which corpus you ran. Compute the frozen corpus digest and paste it below; it has to equal the digest pinned in the protocol lock. Runs completed here in the Space are attested automatically.</p>
          <pre class="ambient-submit-cmd"><code>npm run certify -- ./my-bundle --corpus-hash {protocol_corpus_sha256()}</code></pre>
        """)
        bundle_upload = gr.File(
            label="Evidence bundle (.zip or .tar.gz)",
            file_types=[".zip", ".gz", ".tgz", ".tar"],
            elem_classes="ambient-fieldset",
        )
        corpus_hash_input = gr.Textbox(
            label="Frozen corpus SHA-256",
            placeholder="64-character lowercase digest, required for locally-run submissions",
            info="Leave blank only if this bundle was produced by this Space.",
            elem_classes="ambient-fieldset",
        )
        certify_button = gr.Button("Certify bundle", elem_classes="ambient-run")
        certify_output = gr.HTML()

    gpu_probe_button = gr.Button("ZeroGPU registration", visible=False)
    gpu_probe_output = gr.Textbox(visible=False)
    gpu_probe_button.click(_zerogpu_registration, outputs=gpu_probe_output, api_name=False)

    run_button.click(
        run_benchmark,
        inputs=[
            memory_input,
            memory_space_url_input,
            sample_input,
        ],
        outputs=[result_output, bundle_output],
        api_name="run_benchmark",
        concurrency_limit=1,
        concurrency_id="ambient-run",
    )

    certify_button.click(
        certify_bundle,
        inputs=[bundle_upload, corpus_hash_input],
        outputs=certify_output,
        api_name="certify_bundle",
        concurrency_limit=1,
        concurrency_id="ambient-certify",
    )

    demo.load(hosted_leaderboard_html, outputs=board_output, api_name=False)

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1, max_size=2).launch(css=CSS)
