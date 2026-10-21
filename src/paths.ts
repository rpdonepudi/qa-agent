import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. Runs live under it so generated specs can resolve @playwright/test. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNS_DIR = path.join(PACKAGE_ROOT, "runs");

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
}
