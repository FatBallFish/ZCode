import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const modulePath = "../scripts/macos-notarization.mjs";
async function api() {
  return import(modulePath);
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mac-notary-resume-"));
  directories.push(dir);
  await mkdir(join(dir, "mac-arm64/Mikiko.app"), { recursive: true });
  await writeFile(join(dir, "Mikiko-1.1.3-mac-arm64.dmg"), "signed original DMG");
  await writeFile(join(dir, "Mikiko-1.1.3-mac-arm64.zip"), "signed original ZIP");
  const { createBundleManifest } = await api();
  const bundle = await createBundleManifest(dir, {
    sourceRunId: "123",
    commit: "a".repeat(40),
    ref: "v1.1.3",
    version: "1.1.3",
    arch: "arm64",
  });
  return { dir, bundle, statePath: join(dir, "state/state.json") };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("可恢复的 Apple 公证", () => {
  it("提交意图先归档；runner丢失后没有响应和history时拒绝二次提交", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { prepareSubmissionIntent, submitNotarization } = await api();
    expect(await prepareSubmissionIntent({ bundle, statePath })).toBe(true);
    // 模拟下载的是上传前的意图 artifact，原 runner 已不存在，没有任何响应可恢复。
    expect(await prepareSubmissionIntent({ bundle, statePath })).toBe(false);
    let submits = 0;
    const runNotary = async (args: string[]) => {
      if (args[0] === "history") return { history: [] };
      submits++;
      return { id: "duplicate" };
    };
    await expect(submitNotarization({ dir, bundle, statePath, runNotary })).rejects.toThrow(
      /uncertain/i,
    );
    expect(submits).toBe(0);
  });

  it("manifest 校验拒绝被修改的原始 DMG，不允许拿其他字节续查", async () => {
    const { dir, bundle } = await fixture();
    const { verifyBundleManifest } = await api();
    await verifyBundleManifest(dir, bundle, { sourceRunId: "123", ref: "v1.1.3", arch: "arm64" });
    await writeFile(join(dir, bundle.dmg), "modified DMG");
    await expect(
      verifyBundleManifest(dir, bundle, { sourceRunId: "123", ref: "v1.1.3", arch: "arm64" }),
    ).rejects.toThrow(/hash/i);
  });

  it("pending 超时后恢复只 wait/info，不再次 submit", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { submitNotarization, waitNotarization } = await api();
    let submissions = 0;
    let status = "In Progress";
    const runNotary = async (args: string[]) => {
      if (args[0] === "history") return { history: [] };
      if (args[0] === "submit") {
        submissions++;
        expect(args).not.toContain("--wait");
        return { id: "submission-one" };
      }
      if (args[0] === "wait") throw new Error("client wait timeout");
      return { id: "submission-one", status };
    };
    await submitNotarization({ dir, bundle, statePath, runNotary });
    expect(JSON.parse(await readFile(statePath, "utf8")).id).toBe("submission-one");
    expect(await waitNotarization({ bundle, statePath, runNotary, timeout: "1s" })).toBe(false);
    status = "Accepted";
    await submitNotarization({ dir, bundle, statePath, runNotary });
    expect(await waitNotarization({ bundle, statePath, runNotary, timeout: "1s" })).toBe(true);
    expect(submissions).toBe(1);
  });

  it("submit 响应丢失后按含 SHA256 的上传名找回，不重复上传", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { submitNotarization } = await api();
    let uploadName = "";
    let submitted = false;
    let submissions = 0;
    const runNotary = async (args: string[]) => {
      if (args[0] === "history")
        return {
          history: submitted ? [{ id: "recovered", name: uploadName, status: "In Progress" }] : [],
        };
      submissions++;
      uploadName = args[1].split("/").at(-1)!;
      expect(uploadName).toContain(bundle.files[bundle.dmg].sha256);
      submitted = true;
      throw new Error("lost response");
    };
    await expect(submitNotarization({ dir, bundle, statePath, runNotary })).rejects.toThrow(
      "lost response",
    );
    await submitNotarization({ dir, bundle, statePath, runNotary });
    expect(JSON.parse(await readFile(statePath, "utf8")).id).toBe("recovered");
    expect(submissions).toBe(1);
  });

  it("不确定的提交查不到或找到多个匹配时阻止自动重交", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { submitNotarization } = await api();
    const runNotary = async (args: string[]) => {
      if (args[0] === "history") return { history: [] };
      throw new Error("lost response");
    };
    await expect(submitNotarization({ dir, bundle, statePath, runNotary })).rejects.toThrow();
    await expect(submitNotarization({ dir, bundle, statePath, runNotary })).rejects.toThrow(
      /uncertain/i,
    );
  });

  it("状态绑定其他哈希、版本或 source run 时拒绝恢复", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { submitNotarization } = await api();
    const runNotary = async (args: string[]) =>
      args[0] === "history" ? { history: [] } : { id: "existing" };
    await submitNotarization({ dir, bundle, statePath, runNotary });
    const changed = { ...bundle, sourceRunId: "999" };
    await expect(
      submitNotarization({ dir, bundle: changed, statePath, runNotary }),
    ).rejects.toThrow(/identity/i);
  });

  it("Invalid 保存拒绝日志，后续重试不会创建新 submission", async () => {
    const { dir, bundle, statePath } = await fixture();
    const { submitNotarization, waitNotarization } = await api();
    let submitted = 0;
    const runNotary = async (args: string[]) => {
      if (args[0] === "history") return { history: [] };
      if (args[0] === "submit") {
        submitted++;
        return { id: "bad-signature" };
      }
      if (args[0] === "log") return { issues: [{ message: "missing timestamp" }] };
      return { id: "bad-signature", status: "Invalid" };
    };
    await submitNotarization({ dir, bundle, statePath, runNotary });
    await expect(waitNotarization({ bundle, statePath, runNotary, timeout: "1s" })).rejects.toThrow(
      "Invalid",
    );
    expect(await readFile(join(dir, "state/notary-log.json"), "utf8")).toContain(
      "missing timestamp",
    );
    await submitNotarization({ dir, bundle, statePath, runNotary });
    expect(submitted).toBe(1);
  });

  it("路径越界、错误 ref、版本和架构必须在任何网络请求前失败", async () => {
    const { dir, bundle } = await fixture();
    const { verifyBundleManifest } = await api();
    await expect(
      verifyBundleManifest(dir, bundle, { sourceRunId: "123", ref: "v1.1.4", arch: "arm64" }),
    ).rejects.toThrow(/identity/i);
    const unsafe = {
      ...bundle,
      files: { ...bundle.files, "../escape.dmg": { sha256: "a", size: 1 } },
    };
    await expect(
      verifyBundleManifest(dir, unsafe, { sourceRunId: "123", ref: "v1.1.3", arch: "arm64" }),
    ).rejects.toThrow(/path/i);
  });
});
