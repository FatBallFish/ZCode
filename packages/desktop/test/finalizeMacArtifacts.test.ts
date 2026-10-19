import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { finalizeMacArtifacts } from "../scripts/finalize-macos-artifacts.mjs";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(failStaple = false) {
  const dir = await mkdtemp(join(tmpdir(), "notary-finalize-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const app = join(dir, "mac-arm64/Mikiko.app");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "payload"), "signed App");
  const dmg = "Mikiko-1.1.3-arm64.dmg",
    zip = "Mikiko-1.1.3-arm64.zip";
  await writeFile(join(dir, dmg), "signed DMG");
  await writeFile(join(dir, zip), "old ZIP");
  await writeFile(join(dir, `${dmg}.blockmap`), "old");
  await writeFile(join(dir, `${zip}.blockmap`), "old");
  await writeFile(
    join(dir, "latest-mac.yml"),
    JSON.stringify({
      files: [
        { url: dmg, sha512: "old", size: 10 },
        { url: zip, sha512: "old", size: 7 },
      ],
      path: zip,
      sha512: "old",
    }),
  );
  const fake = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const name=path.basename(process.argv[1]), args=process.argv.slice(2);
fs.appendFileSync(process.env.FINALIZE_CALLS,JSON.stringify({name,args})+'\\n');
if(name==='codesign'&&args.includes('-d'))console.error('CDHash=identical-approved-code');
if(name==='xcrun'&&args[0]==='stapler'&&args[1]==='staple'){
 if(process.env.FAIL_STAPLE==='1')process.exit(1);
 const target=args.at(-1);if(target.endsWith('.dmg'))fs.appendFileSync(target,'ticket');else fs.writeFileSync(path.join(target,'ticket'),'ticket');
}
if(name==='hdiutil'&&args[0]==='attach')fs.cpSync(process.env.FINALIZE_APP,path.join(args.at(-1),'Mikiko.app'),{recursive:true});
if(name==='ditto'&&args.includes('-c'))fs.writeFileSync(args.at(-1),'new ZIP with ticket');
if(name==='ditto'&&args.includes('-x'))fs.cpSync(process.env.FINALIZE_APP,path.join(args.at(-1),'Mikiko.app'),{recursive:true});
`;
  for (const command of ["codesign", "spctl", "xcrun", "hdiutil", "ditto"]) {
    const p = join(bin, command);
    await writeFile(p, fake);
    await chmod(p, 0o755);
  }
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("FINALIZE_CALLS", join(dir, "calls"));
  vi.stubEnv("FINALIZE_APP", app);
  vi.stubEnv("FAIL_STAPLE", failStaple ? "1" : "0");
  return {
    dir,
    bundle: {
      sourceRunId: "123",
      commit: "a".repeat(40),
      ref: "v1.1.3",
      version: "1.1.3",
      arch: "arm64",
      dmg,
      zip,
      app: "mac-arm64/Mikiko.app",
    },
    state: { id: "accepted-one", status: "Accepted" },
  };
}
describe.skipIf(process.platform === "win32")("公证完成后的安装包收尾", () => {
  it("未Accepted不能staple或修改原包", async () => {
    const { dir, bundle, state } = await fixture();
    await expect(
      finalizeMacArtifacts(dir, bundle, { ...state, status: "In Progress" }),
    ).rejects.toThrow(/Accepted/);
    expect(await readFile(join(dir, bundle.zip), "utf8")).toBe("old ZIP");
  });
  it("staple失败不产出已验收标记，成功重试不需要重新签名或submit", async () => {
    const { dir, bundle, state } = await fixture(true);
    await expect(finalizeMacArtifacts(dir, bundle, state)).rejects.toThrow();
    await expect(readFile(join(dir, "release-verification.json"))).rejects.toThrow();
    vi.stubEnv("FAIL_STAPLE", "0");
    await finalizeMacArtifacts(dir, bundle, state);
    const proof = JSON.parse(await readFile(join(dir, "release-verification.json"), "utf8"));
    expect(proof).toMatchObject({
      status: "Accepted",
      submissionId: "accepted-one",
      appStapled: true,
      dmgStapled: true,
      zipPayloadVerified: true,
    });
    const manifest = parse(await readFile(join(dir, "latest-mac.yml"), "utf8"));
    for (const file of manifest.files) {
      const bytes = await readFile(join(dir, file.url));
      expect(file.sha512).toBe(createHash("sha512").update(bytes).digest("base64"));
      expect(file.size).toBe(bytes.length);
    }
    expect(manifest.sha512).toBe(manifest.files[1].sha512);
    const calls = (await readFile(join(dir, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(calls.some((c) => c.args.includes("--sign") || c.args.includes("submit"))).toBe(false);
    expect(calls.filter((c) => c.name === "ditto" && c.args.includes("-x"))).toHaveLength(1);
  }, 30_000);
});
