import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../..");
const exec = promisify(execFile);

describe("发布恢复工作流契约", () => {
  it("原包保存和提交 checkpoint 都发生在限时等待前，恢复跳过编译", async () => {
    const workflow = parse(
      await readFile(resolve(root, ".github/workflows/release-desktop.yml"), "utf8"),
    );
    expect(workflow.jobs.build.if).toContain("!inputs.source-run-id");
    expect(workflow.jobs.relay.if).toContain("!inputs.source-run-id");
    expect(
      workflow.jobs.build.steps.some(
        (s: { name: string }) => s.name === "Save original signed macOS bundle before notarization",
      ),
    ).toBe(true);
    expect(
      workflow.jobs.build.steps.some((s: { name: string }) => s.name?.includes("Wait on existing")),
    ).toBe(false);
    const archive = workflow.jobs.build.steps.find(
      (s: { name: string }) => s.name === "Archive original signed macOS bundle",
    );
    expect(archive.run).toContain('codesign --force --sign "$APPLE_SIGNING_IDENTITY"');
    expect(archive.run.indexOf("--timestamp")).toBeLessThan(
      archive.run.indexOf("macos-notarization.mjs prepare"),
    );
    const steps = workflow.jobs.notarize.steps;
    const checkpoint = steps.findIndex(
      (s: { name: string }) => s.name === "Persist submission immediately before waiting",
    );
    const intent = steps.findIndex(
      (s: { name: string }) => s.name === "Persist upload intent before contacting Apple",
    );
    const submit = steps.findIndex((s: { id: string }) => s.id === "submit");
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(intent).toBeLessThan(submit);
    const wait = steps.findIndex((s: { id: string }) => s.id === "wait");
    expect(checkpoint).toBeLessThan(wait);
    expect(steps[checkpoint].if).toBe("always()");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs.release.needs).toContain("notarize");
  });

  it("正式公证版本的用户安装说明不能继续要求解除 quarantine", async () => {
    const { stdout } = await exec(
      process.execPath,
      [".github/scripts/generate-release-notes.mjs", "v1.1.2"],
      {
        cwd: root,
        env: { ...process.env, MIKIKO_RELEASE_NOTARIZED: "1" },
      },
    );
    expect(stdout).not.toContain("xattr -rc");
    expect(stdout).toContain("公证");
  });

  it("补充申请只导入已有ID，按架构隔离并先checkpoint再等待", async () => {
    const workflow = parse(
      await readFile(resolve(root, ".github/workflows/release-desktop.yml"), "utf8"),
    );
    expect(workflow.on.workflow_dispatch.inputs["additional-notary-id"].default).toBe("");
    expect(workflow.on.workflow_dispatch.inputs["additional-notary-arch"].options).toEqual([
      "arm64",
      "x64",
    ]);
    const steps = workflow.jobs.notarize.steps;
    const adoption = steps.findIndex(
      (s: { name: string }) => s.name === "Adopt additional same-package submission",
    );
    const checkpoint = steps.findIndex(
      (s: { name: string }) => s.name === "Persist submission immediately before waiting",
    );
    expect(adoption).toBeGreaterThan(steps.findIndex((s: { id: string }) => s.id === "submit"));
    expect(adoption).toBeLessThan(checkpoint);
    expect(steps[adoption].if).toContain("matrix.arch == inputs.additional-notary-arch");
    expect(steps[adoption].run).toContain("macos-notarization.mjs adopt");
    expect(steps[adoption].run).not.toContain(" submit ");
    expect(workflow.jobs.identity.steps[0].run).toContain('"$RECOVERY_SOURCE"');
  });

  it("恢复时上游跳过构建不会使feed被隐式success条件跳过", async () => {
    const workflow = parse(
      await readFile(resolve(root, ".github/workflows/release-desktop.yml"), "utf8"),
    );
    const condition = workflow.jobs["publish-update-feed"].if;
    expect(condition).toContain("always()");
    expect(condition).toContain("needs.identity.result == 'success'");
    expect(condition).toContain("needs.release.result == 'success'");
  });

  it("仅发布feed复用已验收run，不重跑公证或Release上传", async () => {
    const workflow = parse(
      await readFile(resolve(root, ".github/workflows/release-desktop.yml"), "utf8"),
    );
    expect(workflow.on.workflow_dispatch.inputs["publish-feed-only"].default).toBe(false);
    expect(workflow.jobs.notarize.if).toContain("!inputs.publish-feed-only");
    expect(workflow.jobs.release.if).toContain("!inputs.publish-feed-only");
    const feed = workflow.jobs["publish-update-feed"];
    expect(feed.if).toContain("inputs.publish-feed-only");
    expect(feed.if).toContain("needs.release.result == 'skipped'");
    const download = feed.steps.find(
      (s: { name: string }) => s.name === "Download verified installers",
    );
    expect(download.env.MAC_RUN_ID).toContain("inputs.verified-mac-run-id");
    expect(workflow.jobs.identity.steps[0].run).toContain('"$VERIFIED_MAC_RUN_ID"');
  });
});
