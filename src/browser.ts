import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * How the agent points at an element. These map 1:1 onto Playwright's
 * recommended locators, so whatever works during exploration can be copied
 * straight into the generated test.
 */
export interface Target {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  css?: string;
  /** 0-based index when the target matches several elements. */
  nth?: number;
}

const MAX_SNAPSHOT_CHARS = 20_000;

export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private shotCount = 0;
  private consoleErrors: string[] = [];

  constructor(
    private readonly shotsDir: string,
    private readonly headless = true,
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(this.shotsDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: this.headless,
      // Use a preinstalled Chromium instead of Playwright's download when one is provided.
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    this.page = await context.newPage();
    this.page.on("console", (msg) => {
      if (msg.type() === "error") this.consoleErrors.push(msg.text());
    });
    this.page.on("pageerror", (err) => this.consoleErrors.push(String(err)));
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  private get p(): Page {
    if (!this.page) throw new Error("browser not started");
    return this.page;
  }

  locate(t: Target): Locator {
    const p = this.p;
    let loc: Locator;
    if (t.role) {
      loc = p.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name ? { name: t.name } : undefined);
    } else if (t.label) loc = p.getByLabel(t.label);
    else if (t.placeholder) loc = p.getByPlaceholder(t.placeholder);
    else if (t.testId) loc = p.getByTestId(t.testId);
    else if (t.text) loc = p.getByText(t.text);
    else if (t.css) loc = p.locator(t.css);
    else throw new Error("target needs one of role, label, placeholder, testId, text or css");
    return t.nth === undefined ? loc : loc.nth(t.nth);
  }

  /** Page state the model reads after every action: URL, title, accessibility tree, new console errors. */
  async snapshot(): Promise<string> {
    const p = this.p;
    await p.waitForLoadState("domcontentloaded").catch(() => {});
    let tree = await p.locator("body").ariaSnapshot({ timeout: 5_000 }).catch((e) => `(snapshot failed: ${e})`);
    if (tree.length > MAX_SNAPSHOT_CHARS) tree = tree.slice(0, MAX_SNAPSHOT_CHARS) + "\n... (truncated)";
    const errors = this.consoleErrors.splice(0);
    return [
      `URL: ${p.url()}`,
      `Title: ${await p.title()}`,
      errors.length ? `Console errors since last action:\n${errors.map((e) => `  - ${e}`).join("\n")}` : "",
      "Accessibility tree:",
      tree,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async navigate(url: string): Promise<string> {
    const res = await this.p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return `HTTP ${res?.status() ?? "?"}\n${await this.snapshot()}`;
  }

  async click(t: Target): Promise<string> {
    await this.locate(t).click({ timeout: 5_000 });
    await this.settle();
    return this.snapshot();
  }

  async fill(t: Target, value: string): Promise<string> {
    await this.locate(t).fill(value, { timeout: 5_000 });
    return this.snapshot();
  }

  async select(t: Target, value: string): Promise<string> {
    await this.locate(t).selectOption(value, { timeout: 5_000 });
    return this.snapshot();
  }

  async press(key: string, t?: Target): Promise<string> {
    if (t) await this.locate(t).press(key, { timeout: 5_000 });
    else await this.p.keyboard.press(key);
    await this.settle();
    return this.snapshot();
  }

  async screenshot(label: string): Promise<{ file: string; base64: string }> {
    const safe = label.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 40) || "shot";
    const file = path.join(this.shotsDir, `${String(++this.shotCount).padStart(2, "0")}-${safe}.png`);
    const buf = await this.p.screenshot({ path: file });
    return { file, base64: buf.toString("base64") };
  }

  private async settle(): Promise<void> {
    await this.p.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  }
}
