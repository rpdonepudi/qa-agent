#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { runQaAgent, type QaEvent } from "./agent.js";
import { runTests } from "./runner.js";
import { RUNS_DIR, newRunId } from "./paths.js";

const HELP = `qa-agent: an AI SDET that explores a web app, writes Playwright tests, runs them, heals them, and reports bugs.

Usage
  qa-agent run --url <url> --goal "<what to test>" [options]
  qa-agent rerun --dir <run folder>          Re-run a generated suite without the AI (free, for regression)

Options for run
  --url <url>             Start page of the app under test (required)
  --goal <text>           What to test: a user story, acceptance criteria, or a plain sentence
  --goal-file <path>      Read the goal from a file instead
  --max-runs <n>          Test runs the agent may use while healing (default 5)
  --max-iterations <n>    Cap on model round-trips (default 80)
  --allowed-host <host>   Extra host the browser may visit, e.g. an SSO domain (repeatable)
  --model <id>            Claude model (default claude-opus-5-5, or QA_AGENT_MODEL)
  --effort <level>        low | medium | high | xhigh | max (default high)
  --out <dir>             Also copy the run folder here (handy in CI)
  --headed                Show the browser while exploring
  --fail-on-bugs          Exit 1 when the agent reports any application bug

Exit code is 1 when any test fails in the final run.
Needs ANTHROPIC_API_KEY in the environment for "run".`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "rerun") {
    const { values } = parseArgs({ args: rest, options: { dir: { type: "string" } } });
    if (!values.dir) throw new Error("--dir is required");
    const res = await runTests(path.resolve(values.dir), (l) => console.log(l));
    console.log(`\n${res.passed} passed, ${res.failed} failed, ${res.knownBugs} known bugs`);
    return res.failed > 0 || res.outcomes.length === 0 ? 1 : 0;
  }

  if (command !== "run") {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      "goal-file": { type: "string" },
      "max-runs": { type: "string" },
      "max-iterations": { type: "string" },
      "allowed-host": { type: "string", multiple: true },
      model: { type: "string" },
      effort: { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean" },
      "fail-on-bugs": { type: "boolean" },
    },
  });

  if (!values.url) throw new Error("--url is required");
  const goal = values["goal-file"] ? await fs.readFile(values["goal-file"], "utf8") : values.goal;
  if (!goal?.trim()) throw new Error("--goal or --goal-file is required");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Set ANTHROPIC_API_KEY first (get one at https://console.anthropic.com).");
  }
  const effort = (values.effort ?? process.env.QA_AGENT_EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Unknown --effort "${effort}"`);

  const workspace = path.join(RUNS_DIR, newRunId());
  console.log(`Run folder: ${workspace}\n`);

  const summary = await runQaAgent({
    url: values.url,
    goal,
    workspace,
    maxTestRuns: values["max-runs"] ? Number(values["max-runs"]) : undefined,
    maxIterations: values["max-iterations"] ? Number(values["max-iterations"]) : undefined,
    allowedHosts: values["allowed-host"],
    headless: !values.headed,
    model: values.model ?? process.env.QA_AGENT_MODEL,
    effort,
    onEvent: printEvent,
  });

  if (values.out) {
    await fs.cp(workspace, path.resolve(values.out), { recursive: true });
    console.log(`Copied run to ${path.resolve(values.out)}`);
  }

  console.log(`\nReport: ${path.join(workspace, "report.html")}`);
  console.log(`Final: ${summary.final.passed} passed, ${summary.final.failed} failed, ${summary.final.knownBugs} known bugs, ${summary.bugs.length} bugs reported`);
  if (summary.final.failed > 0 || summary.final.outcomes.length === 0) return 1;
  if (values["fail-on-bugs"] && summary.bugs.length > 0) return 1;
  return 0;
}

function printEvent(e: QaEvent): void {
  switch (e.type) {
    case "status":
      console.log(`\n== ${e.message}`);
      break;
    case "agent":
      console.log(`\n${e.text}\n`);
      break;
    case "tool":
      console.log(`  - ${e.name}: ${e.detail}`);
      break;
    case "test-output":
      console.log(`    ${e.line}`);
      break;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
