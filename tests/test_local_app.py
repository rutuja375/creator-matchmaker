"""Offline local adapter checks: no real external providers."""

from copy import deepcopy
from datetime import datetime, timezone
import json
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import pytest
import requests

from scripts.local_app import Application, display, failure_message, handler
from src.campaign import Campaign
from src.pipeline import run, save
from src.providers import DemoProvider


@pytest.fixture
def app(tmp_path):
    at = datetime.now(timezone.utc)
    c = Campaign(
        "Visual planning tool",
        "consideration",
        "Explain planning",
        "Designers",
    )
    snapshot = run(c, DemoProvider(at), at)
    folder = save(snapshot, tmp_path / "baseline")
    (folder / "report.pdf").write_bytes(b"%PDF-original")
    return Application(
        folder / "audit.json", tmp_path / "ui", lambda: DemoProvider(at)
    )


def wait_job(app, job_id):
    for _ in range(200):
        if app.jobs[job_id]["status"] != "running":
            return app.jobs[job_id]
        time.sleep(0.05)
    pytest.fail("Job did not complete")


def test_controls_preserve_demo_and_use_backend(app):
    original = app.demo_path.read_bytes()
    d = app.baseline
    w = dict(d["weights"], brand_fit=0.7)
    changed = app.rescore({"run_id": d["run_id"], "weights": w})
    assert changed["capability_priorities"] == d["capability_priorities"]
    assert changed["run_id"] != d["run_id"]
    priorities = dict(d["capability_priorities"], reach=0.9)
    changed = app.rescore(
        {"run_id": changed["run_id"], "priorities": priorities}
    )
    assert changed["weights"] == w
    reset = app.rescore({"run_id": changed["run_id"], "reset": True})
    assert reset["weights"] == d["default_weights"]
    assert reset["capability_priorities"] == d["default_priorities"]
    incoming = next(
        c["handle"]
        for c in d["ranking"]
        if c["handle"] not in {c["handle"] for c in d["roster"]}
        and c["brand_safety"] != "FAIL"
    )
    swapped = app.rescore(
        {"run_id": d["run_id"], "swap": [d["roster"][0]["handle"], incoming]}
    )
    assert incoming in {c["handle"] for c in swapped["roster"]}
    assert original == app.demo_path.read_bytes()
    assert app.pdf(d["run_id"]) == b"%PDF-original"
    assert "channels" not in display(d)
    assert "content_embedding" not in display(d)["ranking"][0]


def test_requires_consent_and_rejects_bad_campaign_before_provider(app):
    with pytest.raises(ValueError, match="Confirm"):
        app.start({})
    with pytest.raises(ValueError):
        app.start(
            {
                "confirm": True,
                "campaign": dict(app.baseline["campaign"], objective="bad"),
            }
        )
    assert not app.jobs


def test_live_completion_is_separate_and_restores_after_restart(app):
    original = deepcopy(app.baseline)
    job = app.start(
        {
            "confirm": True,
            "campaign": original["campaign"],
            "use_trends": False,
        }
    )
    finished = wait_job(app, job["id"])
    assert finished["status"] == "complete"
    assert finished["run_id"] != original["run_id"]
    assert finished["checkpoint_saved"]
    assert app.baseline == original
    reopened = Application(app.demo_path, app.storage)
    assert finished["run_id"] in reopened.snapshots


def test_rate_failure_and_resume_reuses_checkpoint(app):
    at = datetime.now(timezone.utc)

    class Overloaded(DemoProvider):
        def discover(self, campaign):
            response = requests.Response()
            response.status_code = 429
            response._content = (
                b'{"error":{"message":'
                b'"Embed requests per day exceeded secret-value"}}'
            )
            raise requests.HTTPError(response=response)

    app.provider_factory = lambda: Overloaded(at)
    job = app.start(
        {
            "confirm": True,
            "campaign": app.baseline["campaign"],
            "use_trends": False,
        }
    )
    failed = wait_job(app, job["id"])
    assert failed["status"] == "failed"
    assert failed["checkpoint_saved"]
    assert "Daily" in failed["reason"]
    assert "secret-value" not in failed["reason"]
    checkpoint = failed["checkpoint"]
    app.provider_factory = lambda: DemoProvider(at)
    app.start({"confirm": True, "resume": job["id"]})
    assert wait_job(app, job["id"])["status"] == "complete"
    assert failed["checkpoint"] == checkpoint


def test_http_same_origin_and_no_arbitrary_files(app):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(app, "test-token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        assert (
            json.load(urlopen(base + "/api/state"))["demo"]["run_id"]
            == app.baseline["run_id"]
        )
        for path in [
            "/.env",
            "/data/discovered_candidates.json",
            "/../../.env",
        ]:
            with pytest.raises(HTTPError) as error:
                urlopen(base + path)
            assert error.value.code == 404
        for headers in [
            {},
            {"X-Local-Token": "test-token", "Origin": "https://evil.example"},
        ]:
            with pytest.raises(HTTPError) as error:
                urlopen(
                    Request(base + "/api/rescore", data=b"{}", headers=headers)
                )
            assert error.value.code == 403
    finally:
        server.shutdown()
        server.server_close()


def test_error_messages_do_not_expose_raw_exception():
    assert "private comment and key" not in failure_message(
        ValueError("private comment and key")
    )
    response = requests.Response()
    response.status_code = 503
    assert "overloaded" in failure_message(
        requests.HTTPError(response=response)
    )
