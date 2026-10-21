// Scripted stand-in for the streaming Messages API, so the agent loop can be tested without an API key.
// Each request gets the next scripted tool call; after the script ends it replies with a final summary.
import http from "node:http";

const spec = `import { test, expect } from "@playwright/test";

test("TC-01 rejects empty sign-in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Email and password are required.");
});

test("TC-02 deletes the clicked task", async ({ page }) => {
  // BUG-1: Delete removes the first task instead of the clicked one.
  test.fail();
  await page.goto("/");
  await page.getByLabel("Email").fill("demo@acme.test");
  await page.getByLabel("Password").fill("secret123");
  await page.getByRole("button", { name: "Sign in" }).click();
  for (const t of ["first", "second"]) {
    await page.getByPlaceholder("What needs doing?").fill(t);
    await page.getByRole("button", { name: "Add" }).click();
  }
  await page.getByRole("button", { name: "Delete second" }).click();
  await expect(page.getByRole("list", { name: "Tasks" })).toContainText("first");
});
`;

const SCRIPT = [
  ["browser_navigate", { url: "/" }],
  ["browser_click", { target: { role: "button", name: "Sign in" } }],
  ["browser_navigate", { url: "https://example.org/" }],
  ["browser_screenshot", { label: "empty-error" }],
  ["save_test_plan", { markdown: "| ID | Title |\n|---|---|\n| TC-01 | rejects empty sign-in |\n| TC-02 | deletes the clicked task |" }],
  ["write_test_file", { filename: "login.spec.ts", content: spec }],
  ["write_test_file", { filename: "../escape.spec.ts", content: "x" }],
  ["run_tests", {}],
  ["report_bug", { title: "Delete removes the wrong task", severity: "major", steps: "1. Add two tasks\n2. Delete the second", expected: "First remains", actual: "Second remains", test: "TC-02" }],
];

export function startFakeApi(port) {
  let step = 0;
  const toolResults = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    requests.push({ headers: req.headers, body: json });
    const last = json.messages.at(-1);
    if (Array.isArray(last.content)) {
      for (const b of last.content) {
        if (b.type === "tool_result") toolResults.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
      }
    }

    const call = SCRIPT[step++];
    const content = call
      ? [{ type: "text", text: `Step ${step}` }, { type: "tool_use", id: `toolu_${step}`, name: call[0], input: call[1] }]
      : [{ type: "text", text: "Covered sign-in validation and task deletion. Found 1 bug." }];

    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    send("message_start", {
      message: { id: `msg_${step}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3 } },
    });
    content.forEach((b, index) => {
      if (b.type === "text") {
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
      } else {
        send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      send("content_block_stop", { index });
    });
    send("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", {});
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, toolResults, requests })));
}
