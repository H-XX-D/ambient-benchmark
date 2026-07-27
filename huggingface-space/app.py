"""AMBIENT hosted runner for Hugging Face Gradio Spaces."""

from __future__ import annotations

import hashlib
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
import urllib.request
import uuid
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
ACTIVE_JOB: str | None = None
ACTIVE_LOCK = threading.Lock()

SAMPLE_SCOPES = {
    10: {"label": "smoke", "per_ability": 1, "margin": 31.0},
    100: {"label": "pilot", "per_ability": 10, "margin": 9.8},
    200: {"label": "extended", "per_ability": 20, "margin": 6.9},
    400: {"label": "full BEAM-small corpus", "per_ability": 40, "margin": 4.9},
}

MEMORIES = {
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def full_run_publication_payload(
    job_id: str,
    memory: str,
    reader: dict,
    judge: dict,
    run_manifest: dict,
    grade: dict,
    bundle_sha256: str,
    completed_at: str,
) -> dict:
    sampling = run_manifest.get("design", {}).get("sampling", {})
    by_tier = grade.get("byTier", {})
    uncertainty = grade.get("uncertainty", {})
    interval = uncertainty.get("intervals95", {}).get("T4", [])
    required_sampling = {
        "requestedLimit": 400,
        "availableSegments": 400,
        "availableAbilities": 10,
        "selectedSegments": 400,
        "selectedAbilities": 10,
        "minPerAbility": 40,
        "maxPerAbility": 40,
    }
    for key, expected in required_sampling.items():
        if sampling.get(key) != expected:
            raise RuntimeError(f"Full-run publication gate failed: sampling.{key} is not {expected}.")
    if grade.get("status") != "passed" or grade.get("judgeErrors") != 0 or grade.get("rows") != 1600:
        raise RuntimeError("Full-run publication gate failed: the judged artifact is incomplete or contains judge errors.")
    if any(by_tier.get(tier, {}).get("n") != 400 for tier in ("T1", "T2", "T3", "T4")):
        raise RuntimeError("Full-run publication gate failed: every tier must contain 400 judged rows.")
    if uncertainty.get("clusters") != 400 or len(interval) != 2:
        raise RuntimeError("Full-run publication gate failed: the paired uncertainty artifact is incomplete.")
    sampling_sha256 = str(sampling.get("selectionSha256", ""))
    protocol_fingerprint = str(run_manifest.get("protocolFingerprint", ""))
    if not re.fullmatch(r"[0-9a-f]{64}", sampling_sha256) or not re.fullmatch(r"[0-9a-f]{64}", protocol_fingerprint):
        raise RuntimeError("Full-run publication gate failed: required evidence fingerprints are missing.")

    completion = grade.get("completion", {})
    score = float(grade.get("deltas", {}).get("T4"))
    baseline = float(completion.get("T1"))
    treatment = float(completion.get("T4"))
    control = {
        "protocolFingerprint": protocol_fingerprint,
        "samplingSha256": sampling_sha256,
        "corpusSha256": run_manifest.get("corpus", {}).get("sha256"),
        "readerFingerprint": run_manifest.get("models", {}).get("reader", {}).get("fingerprint"),
        "readerProvider": reader["id"],
        "readerModel": reader["model"],
        "judgeProvider": judge["id"],
        "judgeModel": judge["model"],
    }
    control_key = hashlib.sha256(json.dumps(control, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]
    return {
        "id": job_id,
        "memory_id": memory,
        "memory_name": MEMORIES[memory],
        "corpus_source": "beam",
        "corpus_size": "small",
        "item_count": 400,
        "score": score,
        "lower95": float(interval[0]),
        "upper95": float(interval[1]),
        "baseline": baseline,
        "treatment": treatment,
        "control_key": control_key,
        "reader_provider": reader["id"],
        "reader_model": reader["model"],
        "judge_provider": judge["id"],
        "judge_model": judge["model"],
        "protocol_fingerprint": protocol_fingerprint,
        "sampling_sha256": sampling_sha256,
        "evidence_sha256": bundle_sha256,
        "judge_errors": 0,
        "gullible_count": sum(int(tier.get("gullible", 0)) for tier in by_tier.values()),
        "untraced_count": sum(int(tier.get("untraced", 0)) for tier in by_tier.values()),
        "not_served_count": sum(int(tier.get("notServed", 0)) for tier in by_tier.values()),
        "publication_status": "hosted",
        "completed_at": completed_at,
    }


def publish_hosted_run(payload: dict) -> str:
    base_url = os.getenv("AMBIENT_SUPABASE_URL", "https://nasxywilptctmfdbfpdw.supabase.co").strip().rstrip("/")
    secret_key = os.getenv("AMBIENT_SUPABASE_SECRET_KEY", "").strip()
    if not base_url or not secret_key:
        return "not-configured"
    if not base_url.startswith("https://"):
        raise RuntimeError("Hosted-result publication is misconfigured: Supabase URL must use HTTPS.")
    request = urllib.request.Request(
        f"{base_url}/rest/v1/ambient_hosted_runs",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Prefer": "resolution=ignore-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status not in (200, 201, 204):
            raise RuntimeError(f"Hosted-result publication returned HTTP {response.status}.")
    return "published"


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
    reader_model: str,
    judge_model: str,
    sample_size: int,
    oauth_token: gr.OAuthToken,
    progress=gr.Progress(),
):
    global ACTIVE_JOB
    cleanup_jobs()
    if memory not in MEMORIES:
        raise gr.Error("Memory adapter is not supported.")
    limit = int(sample_size)
    if limit not in SAMPLE_SCOPES:
        raise gr.Error("Sample size is not supported.")
    scope = SAMPLE_SCOPES[limit]

    secrets: list[str] = []
    try:
        reader = oauth_provider_config(reader_model, oauth_token, "reader")
        judge = oauth_provider_config(judge_model, oauth_token, "judge")
        secrets = [reader["key"], os.getenv("AMBIENT_SUPABASE_SECRET_KEY", "").strip()]
        if reader["endpoint"] == judge["endpoint"] and reader["model"] == judge["model"]:
            raise ValueError("The judge must be a different model from the reader.")

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
            "AMBIENT_JUDGE_ENDPOINT": judge["endpoint"],
            "AMBIENT_JUDGE_MODEL": judge["model"],
            "AMBIENT_JUDGE_KEY": judge["key"],
        })
        command = [
            str(NODE),
            "scripts/verify-cross-adapter-grade-pipeline.mjs",
            "--use-external-model",
            "--use-external-judge",
            "--adapters", memory,
            "--source", "beam",
            "--size", "small",
            "--limit", str(limit),
            "--matrix", str(matrix_path),
            "--out", str(grades_path),
            "--judge-model", judge["model"],
            "--matrix-timeout-ms", "21600000",
            "--judge-timeout-ms", "21600000",
        ]
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

        if limit == 400:
            progress(0.90, desc="Checking the complete-run publication gate")
            gate = subprocess.run(
                [
                    str(NODE),
                    "scripts/check-cross-adapter-grades.mjs",
                    "--artifact", str(grades_path),
                    "--expect-adapters", memory,
                    "--expect-rows", "1600",
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
        hosted_run = {
            "schema": "ambient.hosted-run.v2",
            "generatedAt": completed_at,
            "track": "development",
            "publicationStatus": "hosted-unreviewed" if limit == 400 else "unreviewed",
            "memory": memory,
            "reader": {"provider": reader["id"], "endpoint": reader["endpoint"], "model": reader["model"]},
            "judge": {"provider": judge["id"], "endpoint": judge["endpoint"], "model": judge["model"]},
            "source": "beam",
            "size": "small",
            "limit": limit,
            "sampling": sampling,
            "estimatedReaderAnswerCalls": 4 * limit,
            "estimatedJudgeCalls": 4 * limit,
            "credentialHandling": "Hugging Face OAuth; short-lived user token; excluded from logs and artifacts",
        }
        (evidence_dir / "hosted-run.json").write_text(json.dumps(hosted_run, indent=2) + "\n", encoding="utf-8")
        (evidence_dir / "README.txt").write_text(
            "This hosted run is unreviewed. Complete 400-question runs may appear on the separate hosted-results board.\n"
            "Only repository-reviewed evidence can enter the verified architecture leaderboard.\n",
            encoding="utf-8",
        )
        bundle_path = job_dir / f"ambient-{job_id}.tar.gz"
        with tarfile.open(bundle_path, "w:gz") as archive:
            for path in sorted(evidence_dir.iterdir()):
                archive.add(path, arcname=path.name)

        publication_state = "not-eligible"
        if limit == 400:
            publication_payload = full_run_publication_payload(
                job_id,
                memory,
                reader,
                judge,
                run_manifest,
                grade,
                sha256_file(bundle_path),
                completed_at,
            )
            try:
                publication_state = publish_hosted_run(publication_payload)
            except (RuntimeError, OSError) as publication_error:
                publication_state = "failed"
                process_log = f"{process_log}\nHosted-result publication failed: {redact(str(publication_error), secrets)}".strip()

        completion = grade.get("completion", {})
        deltas = grade.get("deltas", {})
        by_tier = grade.get("byTier", {})
        uncertainty = grade.get("uncertainty", {})
        lift_interval = uncertainty.get("intervals95", {}).get("T4", ["—", "—"])
        gullible = sum(int(tier.get("gullible", 0)) for tier in by_tier.values())
        untraced = sum(int(tier.get("untraced", 0)) for tier in by_tier.values())
        not_served = sum(int(tier.get("notServed", 0)) for tier in by_tier.values())
        publication_copy = {
            "published": "Automatically recorded on the hosted-results board. It remains unreviewed.",
            "not-configured": "Complete-run recording is not configured on this Space; the evidence bundle is still available.",
            "failed": "The run completed, but automatic hosted-result recording failed; keep the evidence bundle.",
            "not-eligible": "Development scopes are never posted. Only the complete 400-question run is eligible.",
        }[publication_state]
        summary = (
            "## Hosted result · unreviewed\n\n"
            f"**Memory:** {MEMORIES[memory]}  \n"
            f"**Reader:** {reader['label']} / `{reader['model']}`  \n"
            f"**Judge:** {judge['label']} / `{judge['model']}`  \n\n"
            f"**Scope:** {limit} unique questions · {sampling.get('selectedAbilities', '—')}/"
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
            f"Judge errors: {grade.get('judgeErrors', '—')}\n\n"
            f"**Publication:** {publication_copy}\n\n"
            "The hosted board reports completed runs; GitHub evidence review is still required for the verified architecture leaderboard."
        )
        progress(1.0, desc="Evidence bundle ready")
        return summary, str(bundle_path), process_log[-6000:]
    except gr.Error:
        raise
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as error:
        raise gr.Error(redact(str(error), secrets)[:2600]) from None
    finally:
        secrets.clear()
        with ACTIVE_LOCK:
            ACTIVE_JOB = None


CSS = """
:root { --ink:#f4f2ec; --paper:#101217; --white:#15181e; --muted:#b0b3bb; --line:#41454e; --signal:#ff614b; --reverse:#101217; --reverse-muted:#555860; }
html, body { max-width:100%; overflow-x:hidden; }
body, .gradio-container { background:var(--paper) !important; color:var(--ink) !important; }
.gradio-container { max-width:none !important; padding:0 !important; font-family:Inter,ui-sans-serif,system-ui,sans-serif !important; }
#ambient-shell { width:100%; max-width:1240px; margin:0 auto; padding:24px; box-sizing:border-box; }
.ambient-hero { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr); gap:48px; align-items:end; padding:42px 46px; color:var(--reverse); background:var(--ink); border:1px solid var(--ink); }
.ambient-kicker, .ambient-label { font-size:.76rem; font-weight:750; line-height:1.2; letter-spacing:.105em; text-transform:uppercase; }
.ambient-kicker { color:var(--reverse-muted) !important; }
.ambient-method .ambient-label, #ambient-results .ambient-label { color:var(--muted) !important; }
.ambient-hero h1 { margin:14px 0 0; max-width:780px; color:var(--reverse) !important; font-size:clamp(2.7rem,6vw,5.6rem) !important; font-weight:650 !important; line-height:.94 !important; letter-spacing:-.06em !important; }
.ambient-hero h1 em { color:#ff614b !important; font-style:normal !important; }
.ambient-hero p { margin:0; color:var(--reverse-muted) !important; font-size:1rem !important; font-weight:520 !important; line-height:1.65 !important; }
#ambient-workspace { width:100%; gap:0 !important; margin:0 !important; align-items:stretch !important; }
#ambient-workspace > div { min-width:0 !important; }
.ambient-method, .ambient-form { min-width:0 !important; min-height:100%; color:var(--ink) !important; border:1px solid var(--ink) !important; border-top:0 !important; border-radius:0 !important; box-shadow:none !important; }
.ambient-method { padding:34px 36px !important; background:#1d2026 !important; border-right:0 !important; }
.ambient-form { padding:32px 34px 36px !important; background:var(--white) !important; }
.ambient-method h2, .ambient-method strong, .ambient-form h2, .ambient-form strong, .ambient-boundary { color:var(--ink) !important; }
.ambient-method h2, .ambient-form h2 { margin:8px 0 22px; font-size:1.65rem; line-height:1.05; letter-spacing:-.035em; }
.ambient-method p, .ambient-method li, .ambient-form-copy { color:var(--muted) !important; font-size:.96rem; line-height:1.6; }
.ambient-method ol { margin:28px 0; padding:0; list-style:none; counter-reset:method; border-top:1px solid var(--line); }
.ambient-method li { counter-increment:method; display:grid; grid-template-columns:36px 1fr; gap:10px; padding:14px 0; border-bottom:1px solid var(--line); }
.ambient-method li::before { content:"0" counter(method); color:var(--signal); font-size:.75rem; font-weight:800; letter-spacing:.06em; }
.ambient-boundary { margin-top:30px; padding-top:18px; border-top:2px solid var(--ink); }
.ambient-boundary strong { display:block; margin-bottom:7px; font-size:.82rem; letter-spacing:.04em; text-transform:uppercase; }
.ambient-section { margin:0 0 13px; padding-top:22px; border-top:1px solid var(--line); }
.ambient-section.first { padding-top:0; border-top:0; }
.ambient-section span { display:block; margin-bottom:5px; color:var(--signal) !important; font-size:.7rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
.ambient-section strong { display:block; font-size:1.06rem; }
.ambient-section p { margin:4px 0 0; color:var(--muted) !important; font-size:.86rem; line-height:1.5; }
.ambient-fieldset { margin:0 0 20px !important; padding:0 !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; background:transparent !important; }
.ambient-form label, .ambient-form .label-wrap { font-size:.88rem !important; font-weight:650 !important; }
.ambient-form input, .ambient-form textarea, .ambient-form [role="combobox"] { min-height:46px !important; font-size:1rem !important; }
.ambient-consent { margin:5px 0 17px !important; padding:14px !important; color:var(--ink) !important; background:#20242c !important; border:1px solid var(--line) !important; }
.ambient-consent label, .ambient-consent span { color:var(--ink) !important; }
button.ambient-run { min-height:54px !important; background:var(--ink) !important; color:var(--reverse) !important; border:1px solid var(--ink) !important; border-radius:0 !important; font-size:1rem !important; font-weight:750 !important; box-shadow:none !important; }
button.ambient-run:hover { background:var(--signal) !important; color:var(--reverse) !important; border-color:var(--signal) !important; }
#ambient-results { max-width:1240px; margin:0 auto; padding:0 24px 34px; }
.ambient-result-head { padding:28px 0 10px; border-top:1px solid var(--ink); }
.ambient-result-head h2 { margin:5px 0 0; color:var(--ink) !important; font-size:1.7rem; letter-spacing:-.035em; }
footer { display:none !important; }
@media (max-width:800px) {
  #ambient-shell { padding:12px; }
  .ambient-hero { min-width:0; grid-template-columns:minmax(0,1fr); gap:24px; padding:30px 24px; overflow:hidden; }
  .ambient-hero > * { min-width:0; }
  .ambient-hero h1 { font-size:clamp(2.35rem,13vw,4.2rem) !important; overflow-wrap:break-word; }
  #ambient-workspace { display:block !important; min-width:0 !important; }
  #ambient-workspace > div, .ambient-method, .ambient-form { width:100% !important; max-width:100% !important; min-width:0 !important; box-sizing:border-box !important; }
  .ambient-method, .ambient-form { padding:26px 22px !important; border:1px solid var(--ink) !important; border-top:0 !important; }
  .ambient-form .form, .ambient-form .wrap, .ambient-form .container { min-width:0 !important; }
  #ambient-results { padding:0 12px 24px; }
}
"""

with gr.Blocks(
    title="AMBIENT Runner",
    analytics_enabled=False,
    delete_cache=(1800, 300),
    fill_width=True,
) as demo:
    with gr.Column(elem_id="ambient-shell"):
        gr.HTML("""
          <header class="ambient-hero">
            <div>
              <span class="ambient-kicker">AMBIENT · hosted instrument</span>
              <h1>Hold the model fixed.<br><em>Change the memory.</em></h1>
            </div>
            <p>A baseline-isolated evaluation of agentic memory. Choose the memory under test, one fixed reader, and a different judge. The result measures memory contribution—not model rank.</p>
          </header>
        """)

        with gr.Row(elem_id="ambient-workspace"):
            with gr.Column(scale=4, min_width=300, elem_classes="ambient-method"):
                gr.HTML("""
                  <span class="ambient-label">Method</span>
                  <h2>One controlled run.<br>Four paired conditions.</h2>
                  <p>T1 serves no memory. T4 serves only the selected memory. Their attributed-completion difference is the architecture signal under this configuration.</p>
                  <ol>
                    <li>Build the same corpus under the declared memory condition.</li>
                    <li>Ask the same reader every question in T1–T4.</li>
                    <li>Grade with a separate model, then require traced external support.</li>
                  </ol>
                  <p>Scopes are seeded and balanced across all ten BEAM abilities. Repeats do not count as new questions.</p>
                  <div class="ambient-boundary">
                    <strong>Account boundary</strong>
                    Sign in with Hugging Face. Beyond standard sign-in identity, this Space requests only inference permission and uses the resulting short-lived token only with Hugging Face Inference Providers. No API key is entered or stored here.
                  </div>
                  <div class="ambient-boundary">
                    <strong>Publication boundary</strong>
                    A complete 400-question run is recorded on the hosted-results board after strict structural checks. It remains unreviewed; only repository-reviewed evidence enters the verified leaderboard.
                  </div>
                """)

            with gr.Column(scale=6, min_width=420, elem_classes="ambient-form"):
                gr.LoginButton("Sign in with Hugging Face", elem_classes="ambient-login")
                gr.HTML("""
                  <p class="ambient-form-copy">Both models run through Hugging Face Inference Providers under the signed-in participant's account. Inference usage and quota belong to that account.</p>
                """)
                gr.HTML("""
                  <div class="ambient-section first"><span>01</span><strong>Memory architecture</strong><p>The adapter whose contribution is being measured.</p></div>
                """)
                memory_input = gr.Dropdown(
                    choices=[(label, key) for key, label in MEMORIES.items()],
                    value="recall",
                    label="Memory under test",
                    elem_classes="ambient-fieldset",
                )

                gr.HTML("""
                  <div class="ambient-section"><span>02</span><strong>Fixed reader</strong><p>Choose one Hugging Face Inference model and keep it fixed across every tier.</p></div>
                """)
                reader_model_input = gr.Textbox(
                    value="Qwen/Qwen3-32B:preferred",
                    label="Reader model ID",
                    elem_classes="ambient-fieldset",
                )

                gr.HTML("""
                  <div class="ambient-section"><span>03</span><strong>Independent judge</strong><p>Use a different model. It cannot grant memory credit without a served-evidence trace.</p></div>
                """)
                judge_model_input = gr.Textbox(
                    value="openai/gpt-oss-120b:preferred",
                    label="Judge model ID",
                    elem_classes="ambient-fieldset",
                )

                gr.HTML("""
                  <div class="ambient-section"><span>04</span><strong>Run scope</strong><p>Four reader answers and four judge calls per unique question, plus ingest/checker calls.</p></div>
                """)
                sample_input = gr.Dropdown(
                    choices=[
                        ("10 · smoke · 1/ability · ~±31 points", 10),
                        ("100 · pilot · 10/ability · ~±9.8 points", 100),
                        ("200 · extended · 20/ability · ~±6.9 points", 200),
                        ("400 · full corpus · 40/ability · ~±4.9 points", 400),
                    ],
                    value=10,
                    label="Unique BEAM questions",
                    elem_classes="ambient-fieldset",
                )
                run_button = gr.Button("Run controlled evaluation", variant="primary", elem_classes="ambient-run")

    with gr.Column(elem_id="ambient-results"):
        gr.HTML('<div class="ambient-result-head"><span class="ambient-label">Output</span><h2>Evidence bundle</h2></div>')
        result_output = gr.Markdown()
        bundle_output = gr.File(label="Download unreviewed evidence bundle", height=84)
        with gr.Accordion("Technical run log", open=False):
            log_output = gr.Textbox(lines=12, interactive=False)

    gpu_probe_button = gr.Button("ZeroGPU registration", visible=False)
    gpu_probe_output = gr.Textbox(visible=False)
    gpu_probe_button.click(_zerogpu_registration, outputs=gpu_probe_output, api_name=False)

    run_button.click(
        run_benchmark,
        inputs=[
            memory_input,
            reader_model_input,
            judge_model_input,
            sample_input,
        ],
        outputs=[result_output, bundle_output, log_output],
        api_name="run_benchmark",
        concurrency_limit=1,
        concurrency_id="ambient-run",
    )

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1, max_size=2).launch(css=CSS)
