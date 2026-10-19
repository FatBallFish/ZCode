#!/usr/bin/env node
// staple 会追加 DMG ticket；必须按最终字节更新清单和差分文件，避免下载后的哈希校验失败。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const dmg = resolve(process.argv[2]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const blockmap = `${dmg}.blockmap`;
if (await exists(blockmap)) {
  const { appBuilderPath } = require("app-builder-bin");
  await execFileAsync(appBuilderPath, ["blockmap", "--input", dmg, "--output", blockmap]);
}

const manifestPath = join(dirname(dmg), "latest-mac.yml");
if (await exists(manifestPath)) {
  const manifest = parse(await readFile(manifestPath, "utf8"));
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(dmg)) hash.update(chunk);
  const sha512 = hash.digest("base64");
  const { size } = await stat(dmg);
  let changed = false;
  for (const file of manifest.files ?? []) {
    if (basename(file.url) === basename(dmg)) {
      file.sha512 = sha512;
      file.size = size;
      changed = true;
    }
  }
  if (manifest.path && basename(manifest.path) === basename(dmg)) {
    manifest.sha512 = sha512;
    changed = true;
  }
  if (changed) await writeFile(manifestPath, stringify(manifest));
}
