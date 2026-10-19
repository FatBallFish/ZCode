import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { signRuntimeExecutables } from "../scripts/sign-runtime-executables.mjs";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirs: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "zcode-mac-sign-test-"));
  temporaryDirs.push(path);
  return path;
}

async function macho(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from("cffaedfe" + "00".repeat(28), "hex"), { mode: 0o644 });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("macOS CI 签名生命周期", () => {
  it("临时钥匙链解锁有效期覆盖整个 job，builder 显式使用该钥匙链", async () => {
    const workflow = await readFile(
      join(workspaceRoot, ".github/workflows/release-desktop.yml"),
      "utf8",
    );
    const jobMinutes = Number(workflow.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    const lifetime = Number(
      workflow.match(/security set-keychain-settings[^\n]*-lut\s+(\d+)/)?.[1],
    );
    expect(lifetime).toBeGreaterThan(jobMinutes * 60);
    expect(workflow).toMatch(/CSC_KEYCHAIN=.*KEYCHAIN/);
    expect(workflow.indexOf("security set-keychain-settings")).toBeLessThan(
      workflow.indexOf("security unlock-keychain"),
    );
  });

  it("无执行位的原生 addon 也签名，跳过文本和符号链接，保留 builder 对窗口工具的所有权", async () => {
    const out = await temporaryDirectory();
    const resources = join(out, "Mikiko.app/Contents/Resources");
    await macho(join(resources, "glm/pkg/koffi.node"));
    await macho(join(resources, "tools/rg"));
    await macho(join(resources, "macos-window-bounds/zcode-window-bounds"));
    await writeFile(join(resources, "tools/readme.txt"), "plain text");
    if (process.platform !== "win32") {
      await macho(join(out, "outside.node"));
      await symlink(join(out, "outside.node"), join(resources, "tools/link.node"));
    }
    const calls: Array<{ args: string[]; options: { timeout: number; killSignal: string } }> = [];
    await signRuntimeExecutables(
      { electronPlatformName: "darwin", appOutDir: out },
      {
        identity: "Test Developer ID",
        keychain: "/tmp/test-signing.keychain-db",
        execFileImpl: async (_command: string, args: string[], options: never) => {
          calls.push({ args, options });
        },
      },
    );
    expect(calls.map(({ args }) => args.at(-1))).toEqual([
      join(resources, "glm/pkg/koffi.node"),
      join(resources, "tools/rg"),
    ]);
    for (const { args, options } of calls) {
      expect(args).toEqual(
        expect.arrayContaining([
          "--timestamp",
          "--options",
          "runtime",
          "--entitlements",
          "--keychain",
          "/tmp/test-signing.keychain-db",
        ]),
      );
      expect(options).toMatchObject({ timeout: 120_000, killSignal: "SIGKILL" });
    }
  });

  it("签名确实并发执行且最多四个，所有子进程完成前不返回", async () => {
    const out = await temporaryDirectory();
    for (let index = 0; index < 6; index += 1) {
      await macho(join(out, `Mikiko.app/Contents/Resources/tools/${index}`));
    }
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let started!: () => void;
    const firstBatch = new Promise<void>((resolveBatch) => {
      started = resolveBatch;
    });
    let active = 0;
    let maximum = 0;
    let total = 0;
    const signing = signRuntimeExecutables(
      { electronPlatformName: "darwin", appOutDir: out },
      {
        identity: "Test Developer ID",
        execFileImpl: async () => {
          active += 1;
          total += 1;
          maximum = Math.max(maximum, active);
          if (active === 4) started();
          await gate;
          active -= 1;
        },
      },
    );
    await Promise.race([
      firstBatch,
      signing.then(() => {
        throw new Error("returned before signing");
      }),
    ]);
    expect(active).toBe(4);
    release();
    await signing;
    expect(total).toBe(6);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });

  it("签名失败保留错误并终止，不降级、不接受旧签名", async () => {
    const out = await temporaryDirectory();
    await macho(join(out, "Mikiko.app/Contents/Resources/tools/rg"));
    let calls = 0;
    await expect(
      signRuntimeExecutables(
        { electronPlatformName: "darwin", appOutDir: out },
        {
          identity: "Test Developer ID",
          execFileImpl: async () => {
            calls += 1;
            throw new Error("private key is locked");
          },
        },
      ),
    ).rejects.toThrow("private key is locked");
    expect(calls).toBe(1);
  });
});

async function notarizationFixture(status: string, failure?: "second-app" | "staple") {
  const root = await temporaryDirectory();
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "calls.jsonl");
  const fakeCli = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({name,args})+'\\n');
if (name === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') {
  console.log(JSON.stringify({id:'11111111-2222-3333-4444-555555555555',status:process.env.TEST_STATUS}));
}
if (name === 'hdiutil') fs.writeFileSync(args.at(-1), 'rebuilt image');
if (name === 'xcrun' && args[0] === 'stapler' && args[1] === 'staple') {
  if (process.env.TEST_FAIL_STAPLE === '1') process.exit(1);
  fs.appendFileSync(args.at(-1), 'ticket');
}
if (name === 'spctl' && process.env.TEST_FAIL_SECOND === '1' && args.some(x=>x.includes('/mac/Mikiko.app'))) process.exit(1);
`;
  for (const command of ["codesign", "xcrun", "spctl", "hdiutil"]) {
    const path = join(bin, command);
    await writeFile(path, fakeCli);
    await chmod(path, 0o755);
  }
  const dmg = join(root, "Mikiko-test.dmg");
  await writeFile(dmg, "test image");
  await writeFile(`${dmg}.blockmap`, "outdated");
  const zipHash = createHash("sha512").update("unchanged ZIP").digest("base64");
  await writeFile(
    join(root, "latest-mac.yml"),
    JSON.stringify({
      version: "1.1.2",
      files: [
        { url: "Mikiko-test.dmg", sha512: "old", size: 10 },
        { url: "Mikiko-test.zip", sha512: zipHash, size: 13 },
      ],
      path: "Mikiko-test.zip",
      sha512: zipHash,
    }),
  );
  for (const architecture of ["mac", "mac-arm64"]) {
    await mkdir(join(root, architecture, "Mikiko.app/Contents/Frameworks"), { recursive: true });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    APPLE_KEYCHAIN_PROFILE: "test-profile",
    APPLE_SIGNING_IDENTITY: "Test Developer ID",
    TEST_CALLS: calls,
    TEST_STATUS: status,
    LC_ALL: "C",
    TEST_FAIL_SECOND: failure === "second-app" ? "1" : "0",
    TEST_FAIL_STAPLE: failure === "staple" ? "1" : "0",
  };
  let code = 0;
  try {
    await execFileAsync("bash", [join(workspaceRoot, "scripts/notarize-macos.sh"), dmg], { env });
  } catch (error) {
    code = Number((error as { code: number }).code);
  }
  const invocations = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string; args: string[] });
  return {
    code,
    invocations,
    metadata: parse(await readFile(join(root, "latest-mac.yml"), "utf8")),
    blockmap: await readFile(`${dmg}.blockmap`),
    zipHash,
  };
}

describe.skipIf(process.platform === "win32")("公证脚本失败边界", () => {
  it("notarytool 退出 0 但返回 Invalid 时获取日志并失败，不进行 staple", async () => {
    const { code, invocations } = await notarizationFixture("Invalid");
    expect(code).not.toBe(0);
    expect(invocations.some(({ args }) => args[0] === "notarytool" && args[1] === "log")).toBe(
      true,
    );
    expect(invocations.some(({ args }) => args[0] === "stapler")).toBe(false);
  });

  it("Accepted 后验收全部架构，第二个 App 失败也不能报告成功", async () => {
    const { code, invocations } = await notarizationFixture("Accepted", "second-app");
    expect(code).not.toBe(0);
    expect(
      invocations
        .filter(({ name }) => name === "spctl")
        .flatMap(({ args }) => args)
        .filter((arg) => arg.endsWith(".app")),
    ).toHaveLength(2);
  });

  it("staple 改变 DMG 后刷新清单与 blockmap，ZIP 的哈希保持正确", async () => {
    const { code, metadata, blockmap, zipHash } = await notarizationFixture("Accepted");
    expect(code).toBe(0);
    expect(metadata.files[0]).toMatchObject({
      sha512: createHash("sha512").update("test imageticket").digest("base64"),
      size: 16,
    });
    expect(metadata.files[1].sha512).toBe(zipHash);
    expect(metadata.sha512).toBe(zipHash);
    expect(blockmap.equals(Buffer.from("outdated"))).toBe(false);
  });

  it("Apple Accepted 后 staple 失败也必须终止，不刷新元数据或继续验收", async () => {
    const { code, invocations, metadata, blockmap } = await notarizationFixture(
      "Accepted",
      "staple",
    );
    expect(code).not.toBe(0);
    expect(invocations.some(({ name }) => name === "spctl")).toBe(false);
    expect(metadata.files[0].sha512).toBe("old");
    expect(blockmap.equals(Buffer.from("outdated"))).toBe(true);
  });
});
