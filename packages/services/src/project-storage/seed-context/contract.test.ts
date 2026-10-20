import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSettingServiceWithMigrations } from "#src/setting/settingService.js";
import { fixture, port } from "../test-fixture.js";

it("does not stamp the first local project migration without a settings snapshot", async () => {
  const { db, context } = await fixture(["/fixture/empty", "/fixture/pinned", "/fixture/normal"]);
  const { settings: _missing, ...unknownContext } = context;
  await expect(port.migrate(db, unknownContext)).rejects.toThrow(
    "project.migration-settings-required",
  );
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()).toBeUndefined();
  await port.migrate(db, context);
  expect(port.repository(db).readTree().projects).toHaveLength(3);
});

it("reads the original settings before projection and never rewrites its source", async () => {
  const home = await mkdtemp(join(tmpdir(), "mikiko-project-seed-settings-"));
  const original = process.env.MIKIKO_DESKTOP_HOME_DIR;
  process.env.MIKIKO_DESKTOP_HOME_DIR = home;
  const owner = createSettingServiceWithMigrations();
  if (original === undefined) delete process.env.MIKIKO_DESKTOP_HOME_DIR;
  else process.env.MIKIKO_DESKTOP_HOME_DIR = original;
  try {
    const path = join(home, ".mikiko", "v2", "setting.json");
    await mkdir(join(home, ".mikiko", "v2"), { recursive: true });
    const content = JSON.stringify({
      lastWorkspaceSession: ["/fixture/empty", "/fixture/pinned", "/fixture/normal"].map(
        (workspacePath) => ({ kind: "local", workspacePath }),
      ),
    });
    await writeFile(path, content);
    const projection = vi.fn(async () => {
      throw new Error("projection must wait for seed");
    });
    owner.setWorkspaceProjection(projection);
    const snapshot = await owner.readForProjectMigration();
    expect(snapshot.lastWorkspaceSession).toHaveLength(3);
    expect(projection).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(content);
    const { db, context } = await fixture();
    await port.migrate(db, {
      ...context,
      settings: undefined,
      loadSettings: () => owner.readForProjectMigration(),
    });
    expect(port.repository(db).readTree().projects).toHaveLength(3);
    const mustNotRead = vi.fn(async () => {
      throw new Error("already seeded");
    });
    await port.migrate(db, { ...context, settings: undefined, loadSettings: mustNotRead });
    expect(mustNotRead).not.toHaveBeenCalled();
    await expect(owner.service.get()).rejects.toThrow("projection must wait for seed");
    expect(await readFile(path, "utf8")).toBe(content);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps malformed original settings intact and refuses to stamp the project seed", async () => {
  const home = await mkdtemp(join(tmpdir(), "mikiko-project-seed-malformed-"));
  const original = process.env.MIKIKO_DESKTOP_HOME_DIR;
  process.env.MIKIKO_DESKTOP_HOME_DIR = home;
  const owner = createSettingServiceWithMigrations();
  if (original === undefined) delete process.env.MIKIKO_DESKTOP_HOME_DIR;
  else process.env.MIKIKO_DESKTOP_HOME_DIR = original;
  try {
    const path = join(home, ".mikiko", "v2", "setting.json");
    await mkdir(join(home, ".mikiko", "v2"), { recursive: true });
    await writeFile(path, "{broken");
    const { db, context } = await fixture();
    await expect(
      port.migrate(db, {
        ...context,
        settings: undefined,
        loadSettings: owner.readForProjectMigration,
      }),
    ).rejects.toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("{broken");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
