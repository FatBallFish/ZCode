import { basename, join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { getE2EAppDataPaths, seedSettings, clearAppData } from "#e2e/helpers/desktop-app";

const exec = promisify(execFile);
export function requireIntegrationReplay() {
  const paths = getE2EAppDataPaths();
  if (!basename(paths.homeDir).startsWith(".e2e-home-integration-"))
    throw new Error("Integration acceptance requires its own .e2e-home-integration-* profile");
  if (process.env.E2E_PROVIDER_CAPTURE_MODE !== "replay")
    throw new Error("Integration acceptance only runs against fixture replay");
  const upstream = new URL(process.env.E2E_PROVIDER_RUNTIME_BASE_URL ?? "http://invalid");
  if (!["127.0.0.1", "localhost"].includes(upstream.hostname))
    throw new Error("Integration provider must be isolated on loopback");
  return paths;
}
export async function prepareIntegrationProfile() {
  const paths = requireIntegrationReplay();
  await seedSettings({ locale: "en-US", localePreference: "en-US", desktopPetEnabled: false });
  await browser.refresh();
  return paths;
}
export async function createIntegrationRepository() {
  const paths = requireIntegrationReplay();
  const workspace = paths.workspace;
  await mkdir(workspace, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: workspace });
  await writeFile(
    join(workspace, "E2E_INTEGRATION_REPOSITORY.txt"),
    "isolated Mikiko acceptance repository\n",
  );
  await exec("git", ["add", "E2E_INTEGRATION_REPOSITORY.txt"], { cwd: workspace });
  await exec(
    "git",
    [
      "-c",
      "user.name=Mikiko E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Mikiko integration fixture",
    ],
    { cwd: workspace },
  );
  const asset = join(workspace, ".agents", "skills", "integration-probe");
  await mkdir(asset, { recursive: true });
  await writeFile(
    join(asset, "SKILL.md"),
    "---\nname: integration-probe\ndescription: Isolated asset inheritance evidence.\n---\nMIKIKO_INTEGRATION_ASSET_SENTINEL\n",
  );
  await seedSettings({
    worktreeConfig: {
      rootDir: join(paths.homeDir, "integration-worktrees"),
      fetchBeforeCreate: false,
      autoPruneEnabled: false,
      autoPruneLimit: 5,
    },
  });
  return workspace;
}
export async function git(workspace: string, args: string[]) {
  return (await exec("git", args, { cwd: workspace })).stdout.trim();
}
export function readTaskMembership(taskId: string) {
  const paths = requireIntegrationReplay();
  const db = new DatabaseSync(join(paths.storageRoot, "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT task_id,workspace_key,workspace_path,workspace_identity,project_id FROM tasks WHERE task_id=?",
      )
      .all(taskId);
  } finally {
    db.close();
  }
}
export async function waitForTaskMembership(taskId: string) {
  await browser.waitUntil(async () => readTaskMembership(taskId).length > 0, {
    timeout: 30_000,
    timeoutMsg: "Task never reached the real App SQLite index",
  });
  return readTaskMembership(taskId);
}
export function readHostMetrics() {
  return browser.electron.execute((electron) =>
    electron.app
      .getAppMetrics()
      .filter((metric) => /^mikiko-host(?:-|$)/i.test(metric.name ?? ""))
      .map((metric) => ({ pid: metric.pid, name: metric.name }))
      .sort((a, b) => a.pid - b.pid),
  );
}
export async function readMainProviderRequests(marker: string) {
  const path = process.env.E2E_PROVIDER_CAPTURE_PATH;
  if (!path) throw new Error("Missing replay wire evidence");
  const capture = JSON.parse(await readFile(path, "utf8"));
  return (capture.records as { requestJson?: unknown; host?: string }[]).filter((entry) => {
    const text = JSON.stringify(entry.requestJson ?? null);
    return (
      text.includes(marker) &&
      !text.includes("Generate a concise title") &&
      !text.includes("CRITICAL: Respond with TEXT ONLY")
    );
  });
}
export async function readSavedSkin(name: string) {
  const root = join(requireIntegrationReplay().storageRoot, "v2", "theme-skins");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name, "theme.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record.name === name) return { path, record };
  }
  throw new Error(`No real theme.json for ${name}`);
}
export async function writeIntegrationEvidence(caseName: string, evidence: unknown) {
  const root = process.env.MIKIKO_E2E_ARTIFACT_DIR ?? process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!root) throw new Error("Runner artifact directory is missing");
  await writeFile(join(root, `${caseName}.json`), JSON.stringify(evidence, null, 2));
  await browser.saveScreenshot(join(root, `${caseName}.png`));
}

export async function readProviderCaptureRecords() {
  const path = process.env.E2E_PROVIDER_CAPTURE_PATH;
  if (!path) throw new Error("Missing replay wire evidence");
  return JSON.parse(await readFile(path, "utf8")).records as unknown[];
}

/** Guard cleanup as well: a failed profile check must never fall through to a legacy/personal HOME. */
export async function cleanupIntegrationProfile() {
  requireIntegrationReplay();
  await clearAppData();
}
