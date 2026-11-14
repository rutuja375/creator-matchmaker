# Local UI

From the repository root, with the existing virtual environment active:

```powershell
python -m pip install -r requirements.txt
python scripts/local_app.py
```

Open **http://127.0.0.1:8766** (use that exact local address).
Stop the server with Ctrl+C. No API calls occur on startup.

## Saved Milanote demo

The protected baseline is `data/runs/8fc100bb-941f-4423-9f73-ed38fa8c190e/audit.json`.
It and its original `report.pdf` must exist on this machine. They are intentionally
not committed. A fresh clone without these private artifacts cannot show this demo.
The existing version/integrity checks still run; no compatibility bypass was added.

The demo opens with the exact saved Milanote brief, not the results. The brief is
read-only because changing the campaign would require different research.
Click **Set my priorities**, adjust the six individual-fit weights and four team
priorities, then click **Find my creator team**. Python performs the calculation;
no JavaScript scoring implementation is used by this local UI.
A brief preparation screen explicitly says it uses saved evidence. It does not
simulate YouTube discovery or claim new AI calls. Reduced-motion settings skip the
minimum visual delay. Local failures return to the preference screen without
displaying a fabricated result. At least one ranking weight must be positive.

Recommendations lead with creator names, original AI explanation excerpts and
team contributions. Full original explanations, scores and evidence are expandable.
**Adjust priorities** reopens the controls. **Use suggested priorities** restores
objective defaults; click **Find my creator team** to apply them. Swap controls
under alternatives explicitly replace a selected creator. **Restore original demo
result** under research details returns to the original run. Original AI explanations
and report wording are retained. New derived snapshots are saved separately under
`data/runs/local-ui/derived`. Demo's in-browser working selection resets on reload.

## Live

Switching to Live only opens the campaign form. **Research my campaign** requires
explicit quota consent and runs discovery again, followed by collection and
evaluation. No saved discovery is silently substituted. Only one live job runs
at a time in this server. Do not run another pipeline process alongside it.

Saved Google Trends data can be used only for its matching campaign. For another
campaign, import matching measured data before starting, or uncheck saved trends
and accept unmeasured Trend Fit. This UI does not automate Trends collection.

Progress reports the current stage, not a guaranteed percent or ETA. A failed job
shows a sanitized reason and whether a checkpoint exists. Resume reuses that
checkpoint, campaign and trend inputs. Keep code/model configuration unchanged.
Jobs and completed live results survive server restart. Do not edit the private
job/checkpoint files. Stopping the server interrupts unfinished work.

Live jobs, checkpoints, reports and results are stored under `data/runs/local-ui`,
separate from the protected demo. Download PDF returns the original report for the
demo baseline; other results generate reports from their saved snapshot without
external API calls. A report-generation error does not erase a completed result.

## Scope and safety

Local-only server bound to 127.0.0.1; host/origin checks and a per-session request
token protect mutation endpoints. Static files are allowlisted. API keys and raw
provider errors are never sent to the page. This is not an authenticated public
hosting service: do not expose it through a tunnel or bind it to a public address.
The older static prototype remains unchanged at `docs/index.html`.

Tests use synthetic providers for live success/failure/resume paths. They do not
claim a fresh live API run has been performed through the UI.

The browser regression test is `tests/local_ui_flow.cjs`. With Playwright available
to Node and the local server running, execute `node tests/local_ui_flow.cjs`.
It intercepts live-start requests so no real API job can be launched, while demo
recalculations exercise the actual local server. It checks guided navigation,
independent preferences, reset, swaps, loader/error recovery, mobile width and
unchanged baseline data. `UI_URL`, `UI_BROWSER`, and `UI_SCREENSHOTS` can override
the local URL, browser executable, and screenshot directory. On a machine using
bundled dependencies, set `NODE_PATH` to its Node module directory first.
