// 默认只编译自有 fixture；--execute 才连接 gateway，且目标始终为本次创建的唯一 bundle。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseOptions(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--prepare") options.execute = false;
    else if (["--native", "--gateway", "--native-app"].includes(arg)) {
      const value = args[++i];
      assert.ok(value && isAbsolute(value), `${arg} requires an absolute path`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(
    !options.execute || (options.native && options.gateway),
    "--execute requires --native and --gateway",
  );
  return options;
}

export function verifyFixtureIdentity(state, expected) {
  for (const key of ["pid", "bundleId", "nonce", "title"]) {
    assert.equal(state[key], expected[key], `Fixture identity mismatch: ${key}`);
  }
  assert.ok(
    Number.isInteger(state.windowId) && state.windowId > 0,
    "Fixture window is unavailable",
  );
  return state;
}

export function selectFixtureElement(result, identifier) {
  assert.ok(!result.isError, "Native query returned an error");
  const data =
    result.structuredContent ??
    result.content
      ?.filter((item) => item.type === "text")
      .map((item) => {
        try {
          return JSON.parse(item.text);
        } catch {
          return undefined;
        }
      })
      .find((item) => Array.isArray(item?.matches));
  assert.ok(
    data && data.truncated === false && data.stop_reason === "complete",
    "Native query is incomplete",
  );
  const matches = data.matches.filter(
    (item) => item.identifier === identifier && item.role === "AXTextField",
  );
  assert.equal(matches.length, 1, "Expected exactly one controlled fixture text field");
  assert.ok(
    Number.isInteger(matches[0].index) && matches[0].index > 0,
    "Invalid native element index",
  );
  return matches[0];
}

async function until(read, predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await setTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), setTimeout(2000, false)]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function prepare(directory, nonce) {
  const bundleId = `dev.mikiko.computer-use.fixture.${nonce}`;
  const app = join(directory, "Mikiko Controlled Fixture.app");
  const contents = join(app, "Contents");
  const executable = join(contents, "MacOS", "mikiko-controlled-fixture");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Mikiko Controlled Fixture</string>
<key>CFBundleExecutable</key><string>mikiko-controlled-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`,
  );
  const built = await exec(
    "xcrun",
    [
      "swiftc",
      "-framework",
      "Cocoa",
      join(root, "scripts/fixtures/mikiko-computer-use/ControlledTextFixture.swift"),
      "-o",
      executable,
    ],
    { timeout: 60_000 },
  );
  await writeFile(join(directory, "fixture-build.log"), built.stdout + built.stderr);
  await exec("codesign", ["--force", "--sign", "-", app], { timeout: 15_000 });
  return { app, executable, bundleId };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  assert.equal(process.platform, "darwin", "This controlled native smoke requires macOS 14+");
  const macVersion = (await exec("sw_vers", ["-productVersion"])).stdout.trim();
  assert.ok(Number(macVersion.split(".")[0]) >= 14, `macOS 14+ required; found ${macVersion}`);
  const directory = await mkdtemp("/tmp/mikiko-computer-use-smoke-");
  const nonce = randomUUID().replaceAll("-", "");
  const report = {
    mode: options.execute ? "execute" : "prepare",
    directory,
    status: "preparing",
    steps: [],
  };
  let fixture;
  let client;
  let transport;
  let fixtureStderr = "";
  let gatewayStderr = "";
  const cancellation = new AbortController();
  const statePath = join(directory, "fixture-state.json");
  const readState = async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const interrupted = () => {
    cancellation.abort(new Error("Smoke interrupted"));
    process.exitCode = 130;
    void stopOwnedChild(fixture);
    void client?.close();
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const prepared = await prepare(directory, nonce);
    cancellation.signal.throwIfAborted();
    Object.assign(report, prepared);
    report.steps.push("fixture-compiled-and-ad-hoc-signed");
    if (!options.execute) {
      report.status = "prepared";
      report.note = "No application launched; no native permission check or action performed.";
      return report;
    }
    fixture = spawn(prepared.executable, [statePath, nonce], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    fixture.stderr.on("data", (chunk) => {
      fixtureStderr += chunk;
    });
    fixture.on("error", (error) => {
      fixtureStderr += String(error);
    });
    const expected = {
      pid: fixture.pid,
      bundleId: prepared.bundleId,
      nonce,
      title: `Mikiko Controlled Fixture ${nonce}`,
    };
    const initial = verifyFixtureIdentity(
      await until(readState, Boolean, "controlled fixture ready"),
      expected,
    );
    report.fixture = initial;
    report.steps.push("fixture-child-identity-verified");

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/client/stdio"),
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          !key.startsWith("OPEN_COMPUTER_USE_") &&
          !key.startsWith("MIKIKO_COMPUTER_USE_") &&
          key !== "NODE_OPTIONS",
      ),
    );
    Object.assign(env, {
      MIKIKO_COMPUTER_USE_BINARY: options.native,
      MIKIKO_COMPUTER_USE_ALLOWED_APPS: JSON.stringify([prepared.bundleId]),
      MIKIKO_COMPUTER_USE_CONFIG_FILE: join(directory, "native-config.json"),
      ...(options["native-app"] ? { MIKIKO_COMPUTER_USE_APP_PATH: options["native-app"] } : {}),
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [options.gateway],
      cwd: directory,
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      gatewayStderr += chunk;
    });
    client = new Client(
      { name: "mikiko-controlled-smoke", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport, { timeout: 10_000, signal: cancellation.signal });
    const tools = await client.listTools();
    report.tools = tools.tools.map((tool) => tool.name);
    assert.ok(
      report.tools.includes("get_app_state") &&
        report.tools.includes("query") &&
        report.tools.includes("set_value"),
    );
    assert.ok(!report.tools.includes("list_apps"), "Preview must not enumerate user applications");
    report.steps.push("sdk-initialize-and-tool-discovery");
    const context = {
      runtime_scope: "main",
      session_id: `ocu-smoke-${nonce}`,
      turn_id: "turn-1",
      workspace_path: directory,
      client_mode: "desktop-continuous",
      delivery_kind: "desktop-continuous",
    };
    const call = async (name, arguments_) => {
      cancellation.signal.throwIfAborted();
      verifyFixtureIdentity(await readState(), expected);
      assert.equal(fixture.exitCode, null, "Fixture child exited before native action");
      const result = await client.callTool(
        { name, arguments: arguments_, _meta: { "com.zcode/request-context": context } },
        { timeout: 15_000, signal: cancellation.signal },
      );
      const trace = { name, result };
      await writeFile(
        join(directory, `${report.steps.length}-${name}.json`),
        JSON.stringify(trace, null, 2),
      );
      assert.ok(!result.isError, `Native ${name} failed: ${JSON.stringify(result)}`);
      return result;
    };
    const observation = await call("get_app_state", {
      app: prepared.bundleId,
      include_ax: true,
      include_screenshot: true,
      window_placement: "keep",
    });
    report.imageCount = observation.content.filter((item) => item.type === "image").length;
    assert.ok(report.imageCount > 0, "Native observation did not return a real screenshot");
    report.steps.push("native-fixture-ax-and-screenshot");
    const query = () =>
      call("query", {
        app: prepared.bundleId,
        role: "AXTextField",
        window_id: initial.windowId,
        limit: 20,
        max_nodes: 500,
      });
    const element = selectFixtureElement(await query(), initial.fieldIdentifier);
    assert.equal(element.value, initial.value, "AX read differs from fixture-owned state");
    report.steps.push("native-query-identifies-controlled-text-field");
    const value = `mikiko-readback-${nonce}`;
    await call("set_value", {
      app: prepared.bundleId,
      element_index: String(element.index),
      value,
    });
    const updated = await until(
      readState,
      (state) => state?.value === value,
      "fixture-owned input readback",
    );
    verifyFixtureIdentity(updated, expected);
    report.steps.push("native-set-value-confirmed-by-fixture-owner");
    assert.equal(selectFixtureElement(await query(), initial.fieldIdentifier).value, value);
    report.steps.push("native-ax-readback-matches");
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = /permission|not.authorized|accessibility|screen.capture|Screen Recording/i.test(
      String(error),
    )
      ? "blocked"
      : "failed";
    report.error = String(error.stack ?? error);
    process.exitCode = cancellation.signal.aborted ? 130 : report.status === "blocked" ? 2 : 1;
    return report;
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await stopOwnedChild(fixture);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await writeFile(join(directory, "gateway-stderr.log"), gatewayStderr);
    await writeFile(join(directory, "fixture-stderr.log"), fixtureStderr);
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
