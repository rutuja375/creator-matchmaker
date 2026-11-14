"""Local-only UI adapter. Leaves src and the saved demo snapshot unchanged."""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sys
import threading
from urllib.parse import urlparse
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.campaign import Campaign  # noqa: E402
from src.pipeline import run, revise, save, verify_snapshot  # noqa: E402
from src.reports import write_reports  # noqa: E402
from src.providers import LiveProvider  # noqa: E402
from src.evaluation import valid_trends  # noqa: E402
from src.checkpoint import atomic_write  # noqa: E402
import requests  # noqa: E402

DEFAULT_DEMO = (
    ROOT / "data/runs/8fc100bb-941f-4423-9f73-ed38fa8c190e/audit.json"
)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def display(snapshot):
    """Expose display fields only, not the private channel/comment cache."""
    result = {
        k: deepcopy(snapshot[k])
        for k in (
            "run_id",
            "campaign",
            "weights",
            "capability_priorities",
            "data_snapshot_at",
            "ranking",
            "roster",
            "warnings",
            "validation",
            "mode",
        )
    }
    for field in ("ranking", "roster"):
        for creator in result[field]:
            for key in (
                "content_embedding",
                "comment_embedding",
                "similarity",
                "similarity_components",
            ):
                creator.pop(key, None)
    result["manual_roster"] = bool(
        snapshot.get("audit", [{}])[-1].get("manual_swap")
    )
    return result


def failure_message(exc):
    if isinstance(exc, requests.HTTPError):
        status = exc.response.status_code if exc.response is not None else None
        if status == 429:
            try:
                message = (
                    exc.response.json()
                    .get("error", {})
                    .get("message", "")
                    .lower()
                )
            except (ValueError, AttributeError):
                message = ""
            return (
                "Daily API quota reached. Wait for reset, then resume."
                if "per day" in message
                or "perday" in message
                or "daily" in message
                else "API rate or quota limit reached. "
                "Check your provider dashboard before resuming."
            )
        return {
            503: "The model is temporarily overloaded. Try resuming later.",
            401: "API authentication failed. Check local API keys.",
            403: "API access was denied. Check project permissions and quota.",
            404: "Model or resource not found. Check model configuration.",
        }.get(status, f"External API request failed (HTTP {status}).")
    if isinstance(exc, requests.Timeout):
        return "The API timed out. Saved checkpoint work can be resumed."
    if isinstance(exc, requests.RequestException):
        return "Network request failed. Check connectivity, then resume."
    if isinstance(exc, ValueError):
        return (
            "Input, evidence or snapshot validation failed. "
            "Check private diagnostics; no invalid result was published."
        )
    return (
        "The local run could not finish. "
        "Check the terminal or private diagnostics before resuming."
    )


class Application:
    def __init__(
        self, demo=DEFAULT_DEMO, storage=None, provider_factory=LiveProvider
    ):
        self.baseline = read(demo)
        verify_snapshot(self.baseline)
        self.demo_path = Path(demo)
        self.storage = Path(storage or ROOT / "data/runs/local-ui")
        self.storage.mkdir(parents=True, exist_ok=True)
        self.provider_factory = provider_factory
        self.lock = threading.RLock()
        self.snapshots = {self.baseline["run_id"]: self.baseline}
        self.jobs = {}
        for p in self.storage.glob("job-*.json"):
            job = read(p)
            if job["status"] == "running":
                job.update(
                    status="failed",
                    reason="Server stopped. Resume to continue saved work.",
                )
            self.jobs[job["id"]] = job
            if job.get("result_path"):
                s = read(job["result_path"])
                verify_snapshot(s)
                self.snapshots[s["run_id"]] = s

    def persist_job(self, job):
        atomic_write(self.storage / ("job-" + job["id"] + ".json"), job)

    def public_job(self, job):
        return {
            k: job.get(k)
            for k in (
                "id",
                "status",
                "stage",
                "reason",
                "run_id",
                "checkpoint_saved",
            )
        }

    def state(self):
        with self.lock:
            return {
                "demo": display(self.baseline),
                "jobs": [self.public_job(j) for j in self.jobs.values()],
            }

    def rescore(self, body):
        with self.lock:
            original = self.snapshots[body["run_id"]]
            updated = revise(
                original,
                weights=body.get("weights"),
                priorities=body.get("priorities"),
                reset=body.get("reset", False),
                swap=body.get("swap"),
            )
            save(updated, self.storage / "derived")
            self.snapshots[updated["run_id"]] = updated
            return display(updated)

    def start(self, body):
        with self.lock:
            if body.get("confirm") is not True:
                raise ValueError(
                    "Confirm that this action uses external API quota."
                )
            if any(j["status"] == "running" for j in self.jobs.values()):
                raise ValueError(
                    "A live run is already running. Wait for it to finish."
                )
            if body.get("resume"):
                job = self.jobs[body["resume"]]
                if job["status"] != "failed":
                    raise ValueError(
                        "Only interrupted or failed runs can resume."
                    )
            else:
                campaign = Campaign(**body["campaign"])
                # Validate before spending any API quota.
                campaign.canonical()
                trends = (
                    read(ROOT / "data/trends_live.json")
                    if body.get("use_trends")
                    else None
                )
                if trends is not None:
                    valid_trends(trends, datetime.now(timezone.utc))
                    if (
                        trends["campaign_fingerprint"]
                        != campaign.fingerprint()
                    ):
                        raise ValueError(
                            "Saved trends do not match this campaign. "
                            "Uncheck saved trends or import matching data."
                        )
                job_id = str(uuid4())
                job = {
                    "id": job_id,
                    "campaign": campaign.canonical(),
                    "trends": trends,
                    "checkpoint": str(self.storage / ("checkpoint-" + job_id)),
                    "status": "pending",
                    "checkpoint_saved": False,
                }
                self.jobs[job_id] = job
            resume = bool(body.get("resume"))
            job.update(
                status="running",
                stage="Starting / checking checkpoint",
                reason=None,
            )
            self.persist_job(job)
            threading.Thread(
                target=self.worker, args=(job, resume), daemon=True
            ).start()
            return self.public_job(job)

    def worker(self, job, resume):
        app = self

        class ProgressProvider:
            def __init__(self):
                self.inner = app.provider_factory()
                self.mode, self.model = self.inner.mode, self.inner.model

            def __getattr__(self, key):
                return getattr(self.inner, key)

            def stage(self, label):
                with app.lock:
                    job["stage"] = label

            def discover(self, campaign):
                self.stage("Discovering channels (YouTube + Gemini)")
                return self.inner.discover(campaign)

            def channel(self, candidate):
                self.stage("Collecting channel evidence")
                return self.inner.channel(candidate)

            def comments(self, channel):
                self.stage("Collecting comments for " + channel["handle"])
                return self.inner.comments(channel)

            def embed(self, text):
                self.stage(
                    "Embedding evidence (paced requests; this can take time)"
                )
                return self.inner.embed(text)

            def judge(self, *args):
                self.stage("Evaluating creator evidence with Gemini")
                return self.inner.judge(*args)

        try:
            result = run(
                Campaign(**job["campaign"]),
                ProgressProvider(),
                trend_snapshot=job["trends"],
                checkpoint_path=job["checkpoint"],
                resume=resume,
            )
            directory = save(result, self.storage / "live")
            with self.lock:
                self.snapshots[result["run_id"]] = result
                job.update(
                    status="complete",
                    stage="Complete",
                    run_id=result["run_id"],
                    result_path=str(directory / "audit.json"),
                )
        except Exception as exc:
            with self.lock:
                job.update(
                    status="failed",
                    reason=failure_message(exc),
                    stage="Stopped",
                )
            print(
                "Live job",
                job["id"],
                "failed:",
                type(exc).__name__,
                flush=True,
            )
        finally:
            with self.lock:
                job["checkpoint_saved"] = (
                    Path(job["checkpoint"]) / "checkpoint.json"
                ).exists()
                self.persist_job(job)

    def pdf(self, run_id):
        with self.lock:
            if run_id == self.baseline["run_id"]:
                return self.demo_path.with_name("report.pdf").read_bytes()
            snapshot = self.snapshots[run_id]
            folder = self.storage / "reports" / run_id
            folder.mkdir(parents=True, exist_ok=True)
            write_reports(snapshot, folder)
            return (folder / "report.pdf").read_bytes()


def handler(app, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, content, mime="application/json"):
            if not isinstance(content, bytes):
                content = json.dumps(content, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; connect-src 'self'; "
                "frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(content)

        def allowed(self):
            host = self.headers.get("Host", "")
            expected = f"127.0.0.1:{self.server.server_port}"
            return (
                host == expected
                and self.headers.get("Origin", "http://" + expected)
                == "http://" + expected
            )

        def do_GET(self):
            if not self.allowed():
                return self.send(
                    403,
                    {"error": "Use the local URL printed in the terminal."},
                )
            path = urlparse(self.path).path
            try:
                if path == "/api/state":
                    return self.send(200, dict(app.state(), token=token))
                if path == "/api/jobs":
                    with app.lock:
                        return self.send(
                            200,
                            {
                                "jobs": [
                                    app.public_job(j)
                                    for j in app.jobs.values()
                                ]
                            },
                        )
                if path.startswith("/api/run/"):
                    return self.send(
                        200, display(app.snapshots[path.split("/")[-1]])
                    )
                if path.startswith("/api/pdf/"):
                    return self.send(
                        200, app.pdf(path.split("/")[-1]), "application/pdf"
                    )
                files = {
                    "/": ("local.html", "text/html; charset=utf-8"),
                    "/local.js": ("local.js", "text/javascript"),
                    "/local.css": ("local.css", "text/css"),
                }
                name, mime = files[path]
                return self.send(
                    200, (ROOT / "docs" / name).read_bytes(), mime
                )
            except KeyError:
                return self.send(404, {"error": "Not found."})
            except Exception:
                return self.send(
                    500,
                    {
                        "error": "Could not load result or PDF. "
                        "Check local dependencies and snapshot compatibility."
                    },
                )

        def do_POST(self):
            if (
                not self.allowed()
                or self.headers.get("X-Local-Token") != token
            ):
                return self.send(
                    403, {"error": "Local session required. Reload this page."}
                )
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 100000:
                    raise ValueError("Invalid request size.")
                body = json.loads(self.rfile.read(length))
                if self.path == "/api/rescore":
                    result = app.rescore(body)
                elif self.path == "/api/live":
                    result = app.start(body)
                else:
                    return self.send(404, {"error": "Not found."})
                return self.send(200, result)
            except (KeyError, TypeError, ValueError) as exc:
                return self.send(400, {"error": str(exc)[:400]})
            except Exception:
                return self.send(
                    500,
                    {
                        "error": "Local operation failed. "
                        "The saved demo remains unchanged."
                    },
                )

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    app = Application()
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port), handler(app, secrets.token_urlsafe(32))
    )
    print(
        f"Creator Matchmaker: http://127.0.0.1:{args.port} (Ctrl+C to stop)",
        flush=True,
    )
    server.serve_forever()
