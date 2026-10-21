// End-to-end test of the whole pipeline (browser tools, spec writing, Playwright runs, report)
// against the demo app, with a scripted fake in place of the Claude API. No API key needed.
// Run with: npm test   (after npm run build)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeApi } from "./fake-api.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_PORT = 4317;
const API_PORT = 4318;

const demo = spawn(process.execPath, [path.join(root, "examples/demo-app/serve.mjs"), String(DEMO_PORT)], { stdio: "ignore" });
const fake = await startFakeApi(API_PORT);
await new Promise((r) => setTimeout(r, 500));

try {
  const { runQaAgent } = await import(path.join(root, "dist/agent.js"));
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${API_PORT}`;
  const workspace = path.join(root, "runs", `offline-test-${Date.now()}`);

  const summary = await runQaAgent({ url: `http://localhost:${DEMO_PORT}/`, goal: "Sign-in validation and tasks", workspace, maxTestRuns: 2 });

  const req = fake.requests[0];
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.stream, true);
  assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(req.body.tools.length, 12);

  const results = fake.toolResults.join("\n---\n");
  assert.match(results, /textbox "Email"/, "snapshot should include the accessibility tree");
  assert.match(results, /Email and password are required/, "click should return the updated page");
  assert.match(results, /Refused: example\.org is outside/, "navigation must stay on the app's host");
  assert.match(results, /Refused: filename must be a plain name/, "spec writes must stay in tests/");
  assert.match(results, /1 passed, 0 failed, 1 known-bug/, "run_tests should report results to the model");

  assert.equal(summary.final.passed, 1);
  assert.equal(summary.final.failed, 0);
  assert.equal(summary.final.knownBugs, 1);
  assert.equal(summary.bugs.length, 1);
  assert.deepEqual(summary.testFiles, ["login.spec.ts"]);
  for (const f of ["report.html", "summary.json", "test-plan.md", "events.ndjson", "playwright-report/index.html"]) {
    await fs.access(path.join(workspace, f));
  }
  const html = await fs.readFile(path.join(workspace, "report.html"), "utf8");
  assert.match(html, /Delete removes the wrong task/);

  console.log(`offline e2e passed (report: ${path.join(workspace, "report.html")})`);
} finally {
  demo.kill();
  fake.server.close();
}
