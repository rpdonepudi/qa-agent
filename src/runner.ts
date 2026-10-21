import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = path.join(path.dirname(require.resolve("@playwright/test/package.json")), "cli.js");

export interface TestOutcome {
  file: string;
  title: string;
  /** knownBug: marked test.fail() for a reported defect, and it failed as expected. */
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted" | "knownBug";
  durationMs: number;
  error?: string;
}

export interface RunResult {
  outcomes: TestOutcome[];
  passed: number;
  failed: number;
  skipped: number;
  knownBugs: number;
  /** Raw CLI output, useful when the config or a spec does not even compile. */
  output: string;
}

export async function writePlaywrightConfig(workspace: string, baseURL: string): Promise<void> {
  const config = `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: 0,
  workers: 2,
  reporter: [
    ["list"],
    ["json", { outputFile: "results.json" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: ${JSON.stringify(baseURL)},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
  await fs.writeFile(path.join(workspace, "playwright.config.ts"), config);
}

export async function runTests(workspace: string, onOutput?: (line: string) => void): Promise<RunResult> {
  await fs.rm(path.join(workspace, "results.json"), { force: true });
  const output = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", "--config", "playwright.config.ts"], {
      cwd: workspace,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    let buf = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      buf += s;
      for (const line of s.split("\n")) if (line.trim()) onOutput?.(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", () => resolve(buf));
  });

  let outcomes: TestOutcome[] = [];
  try {
    const json = JSON.parse(await fs.readFile(path.join(workspace, "results.json"), "utf8"));
    outcomes = flatten(json.suites ?? []);
  } catch {
    // No results.json means Playwright failed before running anything (syntax error etc.).
  }
  return {
    outcomes,
    passed: outcomes.filter((o) => o.status === "passed").length,
    failed: outcomes.filter((o) => o.status === "failed" || o.status === "timedOut" || o.status === "interrupted").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    knownBugs: outcomes.filter((o) => o.status === "knownBug").length,
    output,
  };
}

// Playwright's JSON reporter nests suites: one per file at the top, then one per describe block.
interface JsonSuite {
  title: string;
  suites?: JsonSuite[];
  specs?: {
    title: string;
    file: string;
    tests: { status: "expected" | "unexpected" | "flaky" | "skipped"; results: { status: TestOutcome["status"]; duration: number; error?: { message?: string } }[] }[];
  }[];
}

function flatten(suites: JsonSuite[], prefix: string[] | null = null): TestOutcome[] {
  const out: TestOutcome[] = [];
  for (const suite of suites) {
    // The top-level suite's title is the file name, which we already report separately.
    const here = prefix === null ? [] : [...prefix, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        const raw = last?.status ?? "skipped";
        out.push({
          file: spec.file,
          title: [...here, spec.title].join(" › "),
          status: classify(test.status, raw),
          durationMs: last?.duration ?? 0,
          error: last?.error?.message
            ? stripAnsi(last.error.message).slice(0, 4_000)
            : test.status === "unexpected" && raw === "passed"
              ? "Marked test.fail() but passed: the bug may be fixed, so remove test.fail()."
              : undefined,
        });
      }
    }
    out.push(...flatten(suite.suites ?? [], here));
  }
  return out;
}

// A test.fail() test reports its result as "failed" when it fails as expected, and as
// "passed" when it unexpectedly passes, so the test-level verdict decides.
function classify(verdict: string, raw: TestOutcome["status"]): TestOutcome["status"] {
  if (verdict === "expected" && raw !== "passed" && raw !== "skipped") return "knownBug";
  if (verdict === "unexpected" && raw === "passed") return "failed";
  return raw;
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}
