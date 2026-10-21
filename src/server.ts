import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { runQaAgent, type QaEvent, type QaRunSummary } from "./agent.js";
import { RUNS_DIR, newRunId } from "./paths.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = process.env.QA_AGENT_TOKEN ?? "";
const MAX_CONCURRENT = Number(process.env.QA_MAX_CONCURRENT ?? 1);
const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

interface Job {
  id: string;
  url: string;
  goal: string;
  maxRuns: number;
  allowedHosts: string[];
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: string;
  error?: string;
  summary?: QaRunSummary;
  events: QaEvent[];
  listeners: Set<http.ServerResponse>;
  abort: AbortController;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

function enqueue(job: Job): void {
  queue.push(job);
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!;
    if (job.state === "cancelled") continue;
    running++;
    void execute(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function execute(job: Job): Promise<void> {
  job.state = "running";
  const emit = (e: QaEvent) => {
    job.events.push(e);
    if (job.events.length > 5_000) job.events.splice(0, 1_000);
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  try {
    job.summary = await runQaAgent({
      url: job.url,
      goal: job.goal,
      workspace: path.join(RUNS_DIR, job.id),
      maxTestRuns: job.maxRuns,
      allowedHosts: job.allowedHosts,
      model: process.env.QA_AGENT_MODEL,
      effort: (process.env.QA_AGENT_EFFORT as "high" | undefined) ?? "high",
      onEvent: emit,
      signal: job.abort.signal,
    });
    job.state = "done";
  } catch (err) {
    job.state = job.abort.signal.aborted ? "cancelled" : "failed";
    job.error = err instanceof Error ? err.message : String(err);
    emit({ type: "status", message: `Run ${job.state}: ${job.error}` });
  }
  for (const res of job.listeners) {
    res.write(`event: end\ndata: ${JSON.stringify({ state: job.state })}\n\n`);
    res.end();
  }
  job.listeners.clear();
}

function publicJob(j: Job) {
  return {
    id: j.id,
    url: j.url,
    goal: j.goal,
    state: j.state,
    createdAt: j.createdAt,
    error: j.error,
    result: j.summary
      ? { ...j.summary.final, outcomes: undefined, bugs: j.summary.bugs.length, reportUrl: `/runs/${j.id}/report.html` }
      : undefined,
  };
}

/** Runs from earlier server processes, read back from disk so history survives restarts. */
async function loadPastRuns(): Promise<void> {
  const dirs = await fs.readdir(RUNS_DIR).catch(() => [] as string[]);
  for (const id of dirs) {
    if (jobs.has(id)) continue;
    try {
      const summary = JSON.parse(await fs.readFile(path.join(RUNS_DIR, id, "summary.json"), "utf8")) as QaRunSummary;
      const events = (await fs.readFile(path.join(RUNS_DIR, id, "events.ndjson"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as QaEvent);
      jobs.set(id, {
        id,
        url: summary.url,
        goal: summary.goal,
        maxRuns: 0,
        allowedHosts: [],
        state: "done",
        createdAt: summary.startedAt,
        summary,
        events,
        listeners: new Set(),
        abort: new AbortController(),
      });
    } catch {
      // Unfinished or foreign folder.
    }
  }
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const cookie = /(?:^|;\s*)qa_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const given = header || url.searchParams.get("token") || (cookie ? decodeURIComponent(cookie) : "");
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".md": "text/markdown; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".webm": "video/webm",
};

async function serveRunFile(res: http.ServerResponse, rel: string): Promise<void> {
  const file = path.resolve(RUNS_DIR, rel);
  if (!file.startsWith(RUNS_DIR + path.sep)) return send(res, 400, { error: "bad path" });
  const stat = await fs.stat(file).catch(() => null);
  const target = stat?.isDirectory() ? path.join(file, "index.html") : file;
  if (!(await fs.stat(target).catch(() => null))?.isFile()) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await fs.readFile(UI_FILE));
    }
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });

    if (url.pathname.startsWith("/runs/")) {
      // Reports link to their own screenshots and traces, which cannot carry the token, so remember it.
      if (TOKEN && url.searchParams.has("token")) {
        res.setHeader("set-cookie", `qa_token=${encodeURIComponent(TOKEN)}; Path=/runs/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      }
      return await serveRunFile(res, decodeURIComponent(url.pathname.slice(6)));
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return send(res, 200, { authRequired: Boolean(TOKEN), hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    }

    if (url.pathname === "/api/runs" && req.method === "GET") {
      await loadPastRuns();
      const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob);
      return send(res, 200, list);
    }

    if (url.pathname === "/api/runs" && req.method === "POST") {
      const body = await readJson(req);
      const target = String(body.url ?? "");
      const goal = String(body.goal ?? "").trim();
      try {
        const u = new URL(target);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        return send(res, 400, { error: "url must be an http(s) URL" });
      }
      if (!goal) return send(res, 400, { error: "goal is required" });
      const job: Job = {
        id: newRunId(),
        url: target,
        goal,
        maxRuns: Math.min(Math.max(Number(body.maxRuns ?? 5), 1), 15),
        allowedHosts: Array.isArray(body.allowedHosts) ? body.allowedHosts.map(String).filter(Boolean) : [],
        state: "queued",
        createdAt: new Date().toISOString(),
        events: [],
        listeners: new Set(),
        abort: new AbortController(),
      };
      jobs.set(job.id, job);
      enqueue(job);
      return send(res, 201, publicJob(job));
    }

    const m = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/events|\/cancel)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "no such run" });
      if (!m[2] && req.method === "GET") return send(res, 200, { ...publicJob(job), summary: job.summary });
      if (m[2] === "/cancel" && req.method === "POST") {
        job.state = job.state === "queued" ? "cancelled" : job.state;
        job.abort.abort();
        return send(res, 200, publicJob(job));
      }
      if (m[2] === "/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (job.state === "running" || job.state === "queued") {
          job.listeners.add(res);
          req.on("close", () => job.listeners.delete(res));
        } else {
          res.write(`event: end\ndata: ${JSON.stringify({ state: job.state })}\n\n`);
          res.end();
        }
        return;
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

await fs.mkdir(RUNS_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`qa-agent UI on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (!TOKEN) console.warn("QA_AGENT_TOKEN is not set: anyone who can reach this port can start runs on your API key.");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: runs will fail until it is.");
});
