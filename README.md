# QA Agent

An AI SDET for web apps. You give it a URL and describe what to test in plain English. It then:

1. **Explores** the app in a real Chromium browser, reading the accessibility tree after every click.
2. **Plans** the work as a Markdown test plan covering positive, negative, edge and accessibility cases.
3. **Automates** the plan as Playwright Test specs in TypeScript, using role and label locators.
4. **Runs and heals** the suite. When a test fails, it decides whether the test or the app is wrong. Broken tests get fixed and re-run. Real defects get filed as bugs, and their tests are marked `test.fail()` so the suite stays green while still documenting the defect.
5. **Reports** in an HTML page with the verdict, bugs, per-test results, the test plan and screenshots, plus the full Playwright report with traces.

Claude (`claude-opus-5-5` by default) does the reasoning through the Anthropic API. Playwright handles the browser and runs the tests.

You can use it three ways: a **web UI** you deploy, a **CLI**, or a **GitHub Action**.

---

## Quick start (local)

Requirements: Node 20 or newer, and an Anthropic API key from https://console.anthropic.com.

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
export ANTHROPIC_API_KEY=sk-ant-...

# Try it on the bundled demo app, which has a planted bug
npm run demo &            # serves http://localhost:4173
node dist/cli.js run --url http://localhost:4173/ \
  --goal "Sign in with demo@acme.test / secret123, then add, complete and delete tasks. Check sign-in validation."
```

The CLI prints the agent's progress and finishes with the path to `runs/<id>/report.html`.

### Web UI

```bash
cp .env.example .env      # fill in ANTHROPIC_API_KEY and QA_AGENT_TOKEN
set -a; . ./.env; set +a
npm start                 # http://localhost:3000
```

The page has a form for the URL and goal, a live log of what the agent is doing, run history, and links to every report.

---

## Deploy

The repo ships a `Dockerfile` based on Playwright's official image, which already includes Chromium and its system libraries.

### Docker / any VM

```bash
cp .env.example .env      # set ANTHROPIC_API_KEY and QA_AGENT_TOKEN
docker compose up -d --build
```

Run history is kept in the `qa-runs` volume.

### Render, Railway, Fly.io, Cloud Run, Azure Container Apps

Point the platform at this repo and let it build the `Dockerfile`. Then:

- Set the env vars `ANTHROPIC_API_KEY` and `QA_AGENT_TOKEN`.
- Expose port `3000`. `GET /healthz` works as a health check.
- Give it at least **2 GB of RAM**, since it runs Chromium.
- Attach a persistent disk at `/app/runs` if you want run history to survive redeploys.

> **Set `QA_AGENT_TOKEN` on any deployment other people can reach.** Without it, anyone who finds the URL can start runs on your API key and make the server's browser open any address it can reach, including internal ones. With it set, the UI asks for the token once.

---

## CLI

```text
qa-agent run --url <url> --goal "<what to test>" [options]
qa-agent rerun --dir <run folder>     # re-run a generated suite, no AI and no cost

--goal-file <path>      read the goal from a file (good for long acceptance criteria)
--max-runs <n>          test runs the agent may use while healing (default 5)
--max-iterations <n>    cap on model round-trips (default 80)
--allowed-host <host>   extra host the browser may visit, e.g. an SSO domain (repeatable)
--model <id>            default claude-opus-5-5
--effort <level>        low | medium | high | xhigh | max (default high)
--out <dir>             copy the run folder somewhere else
--headed                watch the browser while it explores
--fail-on-bugs          exit 1 if the agent reports any application bug
```

The exit code is 1 when any test fails in the final run, so it works as a CI gate.

### What a run produces

```text
runs/<id>/
  report.html            the summary report
  test-plan.md           the agent's test plan
  tests/*.spec.ts        the generated Playwright specs
  playwright-report/     Playwright's HTML report with traces for failures
  screenshots/           screenshots taken while exploring
  summary.json           machine-readable results
  events.ndjson          the full agent log
```

The specs are ordinary Playwright tests. Copy them into your own test repo and they keep running without the agent.

---

## GitHub Action

Add `ANTHROPIC_API_KEY` as a repository secret. Then go to **Actions → QA agent → Run workflow**, or call the action from your own workflow:

```yaml
- uses: rpdonepudi/qa-agent@main
  with:
    url: https://staging.example.com
    goal: |
      As a shopper I can search for a product, add it to the cart,
      change the quantity, and see the total update.
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    max-runs: 5
    fail-on-bugs: true
```

The job summary lists pass/fail counts and bugs. The full report is uploaded as the `qa-report` artifact. `.github/workflows/qa.yml` also has a commented-out nightly schedule.

---

## Writing good goals

Write the goal the way you'd brief a human tester:

- **Name the flows**: "sign up, sign in, reset password".
- **Give test data and credentials** for a test account. Never use real customer accounts.
- **List the rules to check**: "password needs 8+ chars and a digit", "coupon SAVE10 takes 10% off".
- **Say what's out of scope**: "don't place real orders", "skip the admin area".

The agent stays on the start URL's host unless you allow more with `--allowed-host`. It's told not to make payments, send emails or delete data it didn't create, but you should still **point it at staging, not production**.

## Cost and speed

Cost depends on how large the pages are, how many flows the goal covers, and how much healing the suite needs. Prompt caching is on, so repeated context is billed at the cache rate. To cut cost, use `--effort medium` or fewer `--max-runs`. Every report shows its token usage at the bottom.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `QA_AGENT_TOKEN` | none | Access token for the web UI and API |
| `QA_AGENT_MODEL` | `claude-opus-5-5` | Model id |
| `QA_AGENT_EFFORT` | `high` | Reasoning effort |
| `QA_MAX_CONCURRENT` | `1` | Runs the server executes at once |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server bind address |
| `CHROMIUM_PATH` | none | Use a preinstalled Chromium instead of Playwright's |

## Development

```bash
npm run build
npm test        # offline end-to-end test: demo app + scripted fake API, no key needed
```

`src/agent.ts` holds the agent: the system prompt, the tools, and the tool-use loop. `src/browser.ts` wraps Playwright for exploration. `src/runner.ts` runs the suite and parses the results. `src/report.ts` builds the HTML report. `src/server.ts` and `src/ui.html` are the web UI, and `src/cli.ts` is the CLI.

### HTTP API

| Method | Path | |
|---|---|---|
| `POST` | `/api/runs` | `{ "url", "goal", "maxRuns"?, "allowedHosts"? }` → starts a run |
| `GET` | `/api/runs` | list runs |
| `GET` | `/api/runs/:id` | status and full summary |
| `GET` | `/api/runs/:id/events` | live log (Server-Sent Events) |
| `POST` | `/api/runs/:id/cancel` | cancel |
| `GET` | `/runs/:id/report.html` | report and other run files |

Send `Authorization: Bearer <QA_AGENT_TOKEN>` when a token is set.
