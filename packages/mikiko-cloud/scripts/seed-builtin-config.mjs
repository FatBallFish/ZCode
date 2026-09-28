#!/usr/bin/env node
/**
 * 模型预置配置种子化脚本（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.2 初始化）。
 *
 * 2026-09-28 实测：官方线上 client/configs 已停发 builtin_provider_config_json 字段
 * （configs 仅剩 captcha/forceUpdate 等运营键），远端规则热更通道事实下线。因此种子源
 * 默认改为仓库打包的 config/provider/zcode-builtin.json——它本身就是一份合法 Release
 * （revision 30），也是客户端当前实际生效的最新快照。
 *
 * 写入 KV：current 与 revisions/r{revision}（调用 wrangler kv key put）。
 *
 * 用法：
 *   node scripts/seed-builtin-config.mjs                 # 仓库打包文件 → 写 KV（需要已登录 wrangler）
 *   node scripts/seed-builtin-config.mjs --dry-run       # 只校验并输出到 ./seed-builtin.json
 *   node scripts/seed-builtin-config.mjs --file x.json   # 用本地文件代替（手工修正规则后导入）
 *
 * 跨平台说明：仅使用 Node 内置 fetch / child_process / fs，无平台专属 API。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoBundledPath = resolve(packageDir, "..", "..", "config", "provider", "zcode-builtin.json");
const KV_BINDING = "MIKIKO_BUILTIN_CONFIG";
const NAMESPACE_ARG = process.env.MIKIKO_SEED_KV_NAMESPACE?.trim() || "";
const BUILTIN_BODY_LIMIT_BYTES = 10_000_000;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileFlagIndex = args.indexOf("--file");
const fileSource = fileFlagIndex !== -1 ? args[fileFlagIndex + 1] : undefined;

function fail(message) {
  console.error(`[seed] 失败：${message}`);
  process.exit(1);
}

function validateRelease(release) {
  if (typeof release !== "object" || release === null) fail("Release 必须是对象");
  if (release.schemaVersion !== 1)
    fail(`schemaVersion 必须为 1，实际 ${String(release.schemaVersion)}`);
  if (!Number.isInteger(release.revision) || release.revision < 0) {
    fail(`revision 必须是非负整数，实际 ${String(release.revision)}`);
  }
  const config = release.config;
  if (typeof config !== "object" || config === null) fail("config 必须是对象");
  const keys = Object.keys(config).sort();
  if (keys.length !== 2 || keys[0] !== "modelConfigRules" || keys[1] !== "providerConfigRules") {
    fail(
      `config 只允许 providerConfigRules 与 modelConfigRules 两键，实际：${keys.join(",") || "空"}`,
    );
  }
  for (const value of [config.providerConfigRules, config.modelConfigRules]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("规则必须是对象");
  }
  const serialized = JSON.stringify(config);
  if (serialized.length > BUILTIN_BODY_LIMIT_BYTES)
    fail(`配置超过 ${BUILTIN_BODY_LIMIT_BYTES} 字节上限`);
  if (serialized.includes("builtin:zapi"))
    fail("配置包含已退役 provider（builtin:zapi），客户端会整份拒绝");
  return { schemaVersion: 1, revision: release.revision, config };
}

async function loadRelease() {
  const source = fileSource ?? repoBundledPath;
  console.log(
    `[seed] 种子源：${source}${fileSource ? "" : "（仓库打包内置，官方通道已停发的最新可得快照）"}`,
  );
  return validateRelease(JSON.parse(await readFile(source, "utf8")));
}

function runWrangler(kvArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    // Windows 下不经 shell 直接 spawn 可执行文件，避免引号转义差异。
    const child = spawn("npx", ["wrangler", ...kvArgs], {
      cwd: packageDir,
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`wrangler 退出码 ${code}`));
    });
  });
}

async function main() {
  const release = await loadRelease();
  const record = {
    schemaVersion: 1,
    revision: release.revision,
    updatedAt: new Date().toISOString(),
    config: release.config,
  };
  const seedPath = join(packageDir, "seed-builtin.json");
  await mkdir(packageDir, { recursive: true });
  await writeFile(seedPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`[seed] 校验通过：revision=${record.revision}，已写入 ${seedPath}`);

  if (dryRun) {
    console.log("[seed] --dry-run：跳过 KV 写入。部署时执行去掉 --dry-run 的同一命令，或手动：");
    console.log(
      `[seed]   npx wrangler kv key put --binding ${KV_BINDING} current --path seed-builtin.json`,
    );
    return;
  }

  const namespaceArgs = NAMESPACE_ARG
    ? ["--namespace-id", NAMESPACE_ARG]
    : ["--binding", KV_BINDING];
  // wrangler v4 的 kv key put 默认写 local 模拟（.wrangler/state）；必须显式 --remote
  // 才写生产 namespace——否则种子静默落错地方，部署后公开端点仍 404。
  await runWrangler([
    "kv",
    "key",
    "put",
    ...namespaceArgs,
    "--remote",
    "current",
    "--path",
    seedPath,
  ]);
  await runWrangler([
    "kv",
    "key",
    "put",
    ...namespaceArgs,
    "--remote",
    `revisions/r${record.revision}`,
    "--path",
    seedPath,
  ]);
  console.log(
    `[seed] 完成：current 与 revisions/r${record.revision} 已写入 KV binding ${KV_BINDING}。`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
