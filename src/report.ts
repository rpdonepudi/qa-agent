import fs from "node:fs/promises";
import path from "node:path";
import type { QaRunSummary } from "./agent.js";
import type { TestOutcome } from "./runner.js";

const STATUS_LABEL: Record<TestOutcome["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  interrupted: "Interrupted",
  skipped: "Skipped",
  knownBug: "Known bug",
};

/** Writes report.html: one self-contained page linking to the Playwright report and screenshots. */
export async function writeReport(workspace: string, s: QaRunSummary): Promise<string> {
  const shots = await fs.readdir(path.join(workspace, "screenshots")).catch(() => [] as string[]);
  const total = s.final.outcomes.length;
  const verdict = total === 0 ? "No tests ran" : s.final.failed === 0 ? "Suite green" : "Failures";
  const verdictClass = total === 0 || s.final.failed > 0 ? "bad" : "good";

  const rows = s.final.outcomes
    .map(
      (o) => `<tr>
  <td><span class="pill ${o.status}">${STATUS_LABEL[o.status]}</span></td>
  <td>${esc(o.title)}<div class="muted">${esc(o.file)} · ${(o.durationMs / 1000).toFixed(1)}s</div>${
        o.error ? `<details><summary>Error</summary><pre>${esc(o.error)}</pre></details>` : ""
      }</td>
</tr>`,
    )
    .join("\n");

  const bugs = s.bugs.length
    ? s.bugs
        .map(
          (b) => `<article class="bug">
  <h3><span class="pill sev-${b.severity}">${b.severity}</span> ${esc(b.title)}</h3>
  ${b.test ? `<p class="muted">Exposed by: ${esc(b.test)}</p>` : ""}
  <h4>Steps</h4><pre>${esc(b.steps)}</pre>
  <div class="grid2"><div><h4>Expected</h4><p>${esc(b.expected)}</p></div><div><h4>Actual</h4><p>${esc(b.actual)}</p></div></div>
</article>`,
        )
        .join("\n")
    : `<p class="muted">No application bugs reported.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report</title>
<style>
:root { --bg:#f7f7f5; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --good:#1f7a4d; --bad:#b3261e; --warn:#9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --text:#ecebe6; --muted:#a09f99; --line:#33332f; --good:#5cc495; --bad:#ff8a80; --warn:#e3b341; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width:1000px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:18px; margin:32px 0 12px; } h3 { font-size:16px; margin:0 0 8px; } h4 { margin:12px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.muted { color:var(--muted); font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-top:16px; }
.stat b { display:block; font-size:28px; }
.verdict.good { color:var(--good); } .verdict.bad { color:var(--bad); }
table { width:100%; border-collapse:collapse; } td:first-child { width:1%; } td, th { text-align:left; vertical-align:top; padding:10px 8px; border-bottom:1px solid var(--line); }
.table-wrap { overflow-x:auto; }
.pill { display:inline-block; font-size:12px; font-weight:600; padding:2px 8px; border-radius:99px; border:1px solid currentColor; white-space:nowrap; }
.passed { color:var(--good); } .failed, .timedOut, .interrupted, .sev-critical { color:var(--bad); } .knownBug, .sev-major { color:var(--warn); } .skipped, .sev-minor { color:var(--muted); }
pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:12.5px; }
.bug { margin-bottom:12px; } .bug.card, .bug { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; } @media (max-width:640px) { .grid2 { grid-template-columns:1fr; } }
.plan table { font-size:14px; } .plan th { background:var(--bg); }
.shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; } .shots img { width:100%; border:1px solid var(--line); border-radius:6px; }
a { color:inherit; }
</style>
</head>
<body><main>
<h1>QA report</h1>
<div class="muted">${esc(s.url)} · ${new Date(s.finishedAt).toUTCString()}</div>

<div class="stats">
  <div class="card stat"><span class="muted">Verdict</span><b class="verdict ${verdictClass}">${verdict}</b></div>
  <div class="card stat"><span class="muted">Passed</span><b>${s.final.passed}</b></div>
  <div class="card stat"><span class="muted">Failed</span><b>${s.final.failed}</b></div>
  <div class="card stat"><span class="muted">Known bugs</span><b>${s.final.knownBugs}</b></div>
  <div class="card stat"><span class="muted">Bugs reported</span><b>${s.bugs.length}</b></div>
</div>

<h2>Goal</h2>
<div class="card"><pre style="margin:0;border:0;background:none;padding:0">${esc(s.goal)}</pre></div>

<h2>Agent summary</h2>
<div class="card">${markdown(s.agentSummary || "_No summary._")}</div>

<h2>Bugs</h2>
${bugs}

<h2>Test results</h2>
<div class="card table-wrap"><table>${rows || `<tr><td class="muted">No results.</td></tr>`}</table></div>
<p class="muted">Traces, failure screenshots and step-by-step logs: <a href="playwright-report/index.html">Playwright HTML report</a> · Specs are in <code>tests/</code>.</p>

<h2>Test plan</h2>
<div class="card plan table-wrap">${markdown(s.testPlan || "_The agent did not save a test plan._")}</div>

${
  shots.length
    ? `<h2>Exploration screenshots</h2><div class="shots">${shots
        .map((f) => `<a href="screenshots/${encodeURIComponent(f)}"><img src="screenshots/${encodeURIComponent(f)}" alt="${esc(f)}" loading="lazy"></a>`)
        .join("")}</div>`
    : ""
}

<p class="muted" style="margin-top:32px">${s.testRunsUsed} healing runs · ${s.usage.inputTokens.toLocaleString()} input / ${s.usage.outputTokens.toLocaleString()} output tokens (${s.usage.cacheReadTokens.toLocaleString()} from cache)</p>
</main></body></html>
`;
  const file = path.join(workspace, "report.html");
  await fs.writeFile(file, html);
  return file;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Small Markdown renderer covering what the agent writes: headings, lists, tables, code, bold, italics. */
export function markdown(src: string): string {
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, "$1<em>$2</em>")
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  const lines = src.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      out.push(`<pre>${esc(body.join("\n"))}</pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)![0].length + 2, 6);
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
    } else if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i++;
      const body: string[][] = [];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) body.push(cells(lines[++i]));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      i--;
      while (i + 1 < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*([-*]|\d+\.)\s/, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  return out.join("\n");
}
