import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const run = promisify(execFile);
const packages = fileURLToPath(new URL("../../", import.meta.url));
const base = "https://agent-dl.mikiko.ai/mikiko/office-skill/fonts";
const plugins = [
  ["documents-plugin", "docx"],
  ["pdf-plugin", "pdf"],
  ["spreadsheets-plugin", "xlsx"],
];
describe("Office font download boundary", () => {
  for (const [plugin, skill] of plugins) {
    const dir = `${packages}${plugin}/skills/${skill}/env_setup/`;
    it(`${plugin} Windows downloads use the own CDN and normalize historical system paths`, async () => {
      const source = await readFile(`${dir}setup_windows.ps1`, "utf8");
      expect(source).toContain(`$FontCdnBase = "${base}"`);
      expect(source).toContain(
        "$cdnRelative = $relPath -replace '^/usr/share/fonts/truetype/', ''",
      );
      expect(source).toContain("$encoded = $cdnRelative -replace");
      expect(source).not.toContain("z-cdn.chatglm.cn");
    });
    if (plugin === "spreadsheets-plugin") continue;
    it(`${plugin} constructs valid URLs for absolute, relative and bracket font names`, async () => {
      const source = await readFile(`${dir}setup_mac_linux.sh`, "utf8");
      expect(source).toContain(`FONT_CDN_BASE="${base}"`);
      const normalization = source.match(/^\s*cdn_relative=.*$/m)?.[0];
      const encoding = source.match(/^\s*encoded=.*$/m)?.[0];
      expect(normalization).toBeTruthy();
      expect(encoding).toBeTruthy();
      for (const input of [
        "/usr/share/fonts/truetype/chinese/Noto Sans[wght].ttf",
        "chinese/Noto Sans[wght].ttf",
      ]) {
        const result = await run(
          "bash",
          ["-c", `${normalization}\n${encoding}\nprintf '%s' "$encoded"`],
          { env: { ...process.env, rel_path: input } },
        );
        expect(`${base}/${result.stdout}`).toBe(`${base}/chinese/Noto%20Sans%5Bwght%5D.ttf`);
      }
    });
  }
});

it("downloads a normalized font from a real local HTTP endpoint using the installer curl command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikiko-font-http-"));
  const seen = [];
  const bytes = Buffer.from("font-fixture-bytes");
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local font port");
    const source = await readFile(
      `${packages}documents-plugin/skills/docx/env_setup/setup_mac_linux.sh`,
      "utf8",
    );
    const assignments = [
      source.match(/^\s*cdn_relative=.*$/m)?.[0],
      source.match(/^\s*encoded=.*$/m)?.[0],
      source.match(/^\s*url=.*$/m)?.[0],
    ];
    const curl = source.match(/if (curl .*?) 2>\/dev\/null; then/)?.[1];
    expect(assignments.every(Boolean)).toBe(true);
    expect(curl).toBeTruthy();
    await run("bash", ["-c", [...assignments, curl].join("\n")], {
      env: {
        ...process.env,
        rel_path: "/usr/share/fonts/truetype/chinese/Noto Sans[wght].ttf",
        FONT_CDN_BASE: `http://127.0.0.1:${address.port}/mikiko/office-skill/fonts`,
        USER_FONT_DIR: directory,
        fname: "fixture.ttf",
      },
    });
    expect(seen).toEqual(["/mikiko/office-skill/fonts/chinese/Noto%20Sans%5Bwght%5D.ttf"]);
    expect(await readFile(join(directory, "fixture.ttf"))).toEqual(bytes);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
