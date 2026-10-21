import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { BrowserSession, type Target } from "./browser.js";
import { runTests, writePlaywrightConfig, type RunResult } from "./runner.js";
import { writeReport } from "./report.js";

export interface QaRunOptions {
  /** Page the agent starts on. Navigation is limited to this origin plus `allowedHosts`. */
  url: string;
  /** Plain-English goal, user story, or acceptance criteria. */
  goal: string;
  /** Directory for this run's tests, screenshots and reports. */
  workspace: string;
  /** How many times the agent may run the suite while fixing it (the self-heal budget). */
  maxTestRuns?: number;
  /** Cap on model round-trips for the whole run. */
  maxIterations?: number;
  allowedHosts?: string[];
  headless?: boolean;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  onEvent?: (e: QaEvent) => void;
  signal?: AbortSignal;
}

export type QaEvent =
  | { type: "status"; message: string }
  | { type: "agent"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "test-output"; line: string };

export interface Bug {
  title: string;
  severity: "critical" | "major" | "minor";
  steps: string;
  expected: string;
  actual: string;
  test?: string;
}

export interface QaRunSummary {
  url: string;
  goal: string;
  startedAt: string;
  finishedAt: string;
  agentSummary: string;
  testPlan: string;
  testFiles: string[];
  bugs: Bug[];
  final: Omit<RunResult, "output">;
  testRunsUsed: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

const SYSTEM_PROMPT = `You are a senior SDET (software development engineer in test). You test web applications end to end.

You work in four stages, and you keep going until all four are done:

1. Explore. Use the browser tools to walk through the application flows that the goal covers. Read the accessibility tree after every action. Note what the page actually does, which locators identify elements reliably, and anything that looks broken (console errors, wrong text, dead buttons, validation that does not fire).
2. Plan. Call save_test_plan with a Markdown test plan: a short scope section, then a table of test cases with ID, title, type (positive, negative, edge, accessibility), priority, steps, and expected result. Cover the happy path, invalid input, and the edge cases a careful tester would check.
3. Automate. Write Playwright Test specs in TypeScript with write_test_file. Group related cases into one file per feature.
4. Run and heal. Call run_tests. For each failure decide whether the test is wrong (bad locator, timing, wrong assumption) or the application is wrong. Fix test problems and run again. When the application is wrong, keep the test asserting the correct behaviour, call report_bug, and mark that test with test.fail() and a comment that names the bug, so the suite documents the defect without staying red.

Rules for the specs:
- Import from "@playwright/test" only. No other packages, no fixtures files, no page objects.
- baseURL is already configured to the application's origin, so navigate with page.goto("/path").
- Prefer getByRole, getByLabel, getByPlaceholder, getByText and getByTestId over CSS. Use only locators you saw in the accessibility tree.
- Use web-first assertions (await expect(locator).toBeVisible(), toHaveText, toHaveURL). Never use waitForTimeout.
- Every test must be independent and start from page.goto.
- Use each test-plan ID in the test title, for example test("TC-03 rejects an empty email", ...).

Stay on the application you were given. Do not submit real payments, send real emails, or delete data you did not create. If a flow needs credentials you were not given, test what you can reach and say what you skipped.

When you are done, reply with a short summary: what you covered, the final pass and fail counts, the bugs you found, and anything you could not test.`;

export async function runQaAgent(opts: QaRunOptions): Promise<QaRunSummary> {
  const startedAt = new Date().toISOString();
  await fs.mkdir(opts.workspace, { recursive: true });
  // Keep a replayable log next to the report so finished runs can be reviewed later.
  const log = createWriteStream(path.join(opts.workspace, "events.ndjson"), { flags: "a" });
  const emit = (e: QaEvent) => {
    opts.onEvent?.(e);
    log.write(JSON.stringify(e) + "\n");
  };
  const start = new URL(opts.url);
  const allowed = new Set([start.host, ...(opts.allowedHosts ?? [])]);
  const maxTestRuns = opts.maxTestRuns ?? 5;
  const testsDir = path.join(opts.workspace, "tests");

  await fs.mkdir(testsDir, { recursive: true });
  await writePlaywrightConfig(opts.workspace, start.origin);

  const browser = new BrowserSession(path.join(opts.workspace, "screenshots"), opts.headless ?? true);
  await browser.start();

  let testPlan = "";
  let testRunsUsed = 0;
  const bugs: Bug[] = [];

  const targetSchema = z
    .object({
      role: z.string().optional().describe("ARIA role, e.g. button, link, textbox, heading, checkbox"),
      name: z.string().optional().describe("Accessible name, used together with role"),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      testId: z.string().optional(),
      text: z.string().optional(),
      css: z.string().optional().describe("Last resort when nothing above identifies the element"),
      nth: z.number().int().min(0).optional().describe("0-based index when several elements match"),
    })
    .describe("Which element to act on. Give role (+ name), or one of label, placeholder, testId, text, css.");

  // Every browser tool returns errors as text, so a bad locator becomes feedback rather than a crash.
  const guard = (name: string, fn: () => Promise<string>) => async () => {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      emit({ type: "tool", name, detail: `error: ${msg}` });
      return `Error: ${msg}\n\n${await browser.snapshot().catch(() => "")}`;
    }
  };
  const describeTarget = (t: Target) => JSON.stringify(t);

  const tools = [
    betaZodTool({
      name: "browser_navigate",
      description: "Open a URL in the browser. Relative paths resolve against the application's start URL.",
      inputSchema: z.object({ url: z.string() }),
      run: (i) =>
        guard("browser_navigate", async () => {
          const u = new URL(i.url, opts.url);
          if (!allowed.has(u.host)) return `Refused: ${u.host} is outside the application under test (${[...allowed].join(", ")}).`;
          emit({ type: "tool", name: "navigate", detail: u.href });
          return browser.navigate(u.href);
        })(),
    }),
    betaZodTool({
      name: "browser_snapshot",
      description: "Read the current page: URL, title, accessibility tree and new console errors.",
      inputSchema: z.object({}),
      run: () => guard("browser_snapshot", () => browser.snapshot())(),
    }),
    betaZodTool({
      name: "browser_click",
      description: "Click an element, then return the updated page snapshot.",
      inputSchema: z.object({ target: targetSchema }),
      run: (i) =>
        guard("browser_click", () => {
          emit({ type: "tool", name: "click", detail: describeTarget(i.target) });
          return browser.click(i.target);
        })(),
    }),
    betaZodTool({
      name: "browser_fill",
      description: "Clear an input and type a value into it.",
      inputSchema: z.object({ target: targetSchema, value: z.string() }),
      run: (i) =>
        guard("browser_fill", () => {
          emit({ type: "tool", name: "fill", detail: `${describeTarget(i.target)} = ${JSON.stringify(i.value)}` });
          return browser.fill(i.target, i.value);
        })(),
    }),
    betaZodTool({
      name: "browser_select",
      description: "Choose an option in a <select> by value or label.",
      inputSchema: z.object({ target: targetSchema, value: z.string() }),
      run: (i) =>
        guard("browser_select", () => {
          emit({ type: "tool", name: "select", detail: `${describeTarget(i.target)} = ${i.value}` });
          return browser.select(i.target, i.value);
        })(),
    }),
    betaZodTool({
      name: "browser_press",
      description: "Press a key such as Enter, Tab or Escape, optionally on a specific element.",
      inputSchema: z.object({ key: z.string(), target: targetSchema.optional() }),
      run: (i) =>
        guard("browser_press", () => {
          emit({ type: "tool", name: "press", detail: i.key });
          return browser.press(i.key, i.target);
        })(),
    }),
    betaZodTool({
      name: "browser_screenshot",
      description: "Take a screenshot to check layout or visual state. Use sparingly; the accessibility tree is usually enough.",
      inputSchema: z.object({ label: z.string().describe("Short name for the file, e.g. login-error") }),
      run: async (i) => {
        try {
          const shot = await browser.screenshot(i.label);
          emit({ type: "tool", name: "screenshot", detail: path.basename(shot.file) });
          return [
            { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: shot.base64 } },
            { type: "text" as const, text: `Saved ${path.basename(shot.file)}` },
          ];
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    betaZodTool({
      name: "save_test_plan",
      description: "Save the Markdown test plan. Call again to replace it if the plan changes.",
      inputSchema: z.object({ markdown: z.string() }),
      run: async (i) => {
        testPlan = i.markdown;
        await fs.writeFile(path.join(opts.workspace, "test-plan.md"), testPlan);
        emit({ type: "tool", name: "save_test_plan", detail: `${testPlan.split("\n").length} lines` });
        return "Test plan saved.";
      },
    }),
    betaZodTool({
      name: "write_test_file",
      description: "Create or overwrite a Playwright spec in the tests folder. The filename must end in .spec.ts.",
      inputSchema: z.object({ filename: z.string().describe("e.g. login.spec.ts"), content: z.string() }),
      run: async (i) => {
        const file = safeSpecPath(testsDir, i.filename);
        if (!file) return "Refused: filename must be a plain name ending in .spec.ts, with no folders.";
        await fs.writeFile(file, i.content);
        emit({ type: "tool", name: "write_test_file", detail: path.basename(file) });
        return `Wrote tests/${path.basename(file)}.`;
      },
    }),
    betaZodTool({
      name: "read_test_file",
      description: "Read back a spec you wrote.",
      inputSchema: z.object({ filename: z.string() }),
      run: async (i) => {
        const file = safeSpecPath(testsDir, i.filename);
        if (!file) return "Refused: not a spec in the tests folder.";
        return fs.readFile(file, "utf8").catch(() => `No such file: ${i.filename}`);
      },
    }),
    betaZodTool({
      name: "run_tests",
      description: `Run the whole Playwright suite and get each test's result and error. You can call this at most ${maxTestRuns} times.`,
      inputSchema: z.object({}),
      run: async () => {
        if (testRunsUsed >= maxTestRuns) {
          return `Test-run budget used up (${maxTestRuns} runs). Stop fixing, report remaining failures as open issues, and write your summary.`;
        }
        testRunsUsed++;
        emit({ type: "status", message: `Running the suite (run ${testRunsUsed} of ${maxTestRuns})` });
        const res = await runTests(opts.workspace, (line) => emit({ type: "test-output", line }));
        return formatRunForModel(res, maxTestRuns - testRunsUsed);
      },
    }),
    betaZodTool({
      name: "report_bug",
      description: "Record a defect in the application under test (not a mistake in your own test).",
      inputSchema: z.object({
        title: z.string(),
        severity: z.enum(["critical", "major", "minor"]),
        steps: z.string().describe("Numbered steps to reproduce"),
        expected: z.string(),
        actual: z.string(),
        test: z.string().optional().describe("Title of the test that exposes it"),
      }),
      run: async (i) => {
        bugs.push(i);
        emit({ type: "tool", name: "report_bug", detail: `[${i.severity}] ${i.title}` });
        return `Bug ${bugs.length} recorded.`;
      },
    }),
  ];

  const client = new Anthropic();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let agentSummary = "";

  try {
    emit({ type: "status", message: `Exploring ${opts.url}` });
    const runner = client.beta.messages.toolRunner(
      {
        model: opts.model ?? "claude-opus-5-5",
        max_tokens: 32_000,
        // Large max_tokens needs streaming to stay clear of HTTP timeouts.
        stream: true,
        max_iterations: opts.maxIterations ?? 80,
        // Claude Opus 5.5 always thinks; effort sets how hard.
        output_config: { effort: opts.effort ?? "high" },
        // Re-run on the server's default fallback model if a request is declined.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: SYSTEM_PROMPT,
        tools,
        messages: [
          {
            role: "user",
            content: `Application start URL: ${opts.url}\n\nGoal:\n${opts.goal}\n\nYou have ${maxTestRuns} test runs for running and healing the suite.`,
          },
        ],
      },
      { signal: opts.signal },
    );

    for await (const stream of runner) {
      const message = await stream.finalMessage();
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) {
        emit({ type: "agent", text });
        agentSummary = text;
      }
      if (message.stop_reason === "refusal") {
        agentSummary = `The model declined to continue: ${message.stop_details?.explanation ?? "no reason given"}`;
        break;
      }
    }
  } catch (err) {
    log.end();
    throw err;
  } finally {
    await browser.close();
  }

  // The agent's last run may be stale (or never happened), so take the final numbers ourselves.
  emit({ type: "status", message: "Final verification run" });
  const final = await runTests(opts.workspace, (line) => emit({ type: "test-output", line }));
  const testFiles = (await fs.readdir(testsDir)).filter((f) => f.endsWith(".spec.ts"));

  const summary: QaRunSummary = {
    url: opts.url,
    goal: opts.goal,
    startedAt,
    finishedAt: new Date().toISOString(),
    agentSummary,
    testPlan,
    testFiles,
    bugs,
    final: { outcomes: final.outcomes, passed: final.passed, failed: final.failed, skipped: final.skipped, knownBugs: final.knownBugs },
    testRunsUsed,
    usage,
  };
  await fs.writeFile(path.join(opts.workspace, "summary.json"), JSON.stringify(summary, null, 2));
  await writeReport(opts.workspace, summary);
  emit({ type: "status", message: `Done: ${final.passed} passed, ${final.failed} failed, ${bugs.length} bugs` });
  log.end();
  return summary;
}

function safeSpecPath(dir: string, filename: string): string | null {
  if (!/^[\w.-]+\.spec\.ts$/.test(filename)) return null;
  return path.join(dir, filename);
}

function formatRunForModel(res: RunResult, runsLeft: number): string {
  if (!res.outcomes.length) {
    return `No test results. Playwright output (likely a syntax or import error):\n${res.output.slice(-6_000)}\n\nRuns left: ${runsLeft}`;
  }
  const lines = res.outcomes.map((o) => {
    const head = `[${o.status}] ${o.file} :: ${o.title}`;
    return o.error ? `${head}\n${o.error.slice(0, 1_500)}` : head;
  });
  return `${res.passed} passed, ${res.failed} failed, ${res.knownBugs} known-bug (test.fail), ${res.skipped} skipped. Runs left: ${runsLeft}\n\n${lines.join("\n\n")}`;
}
