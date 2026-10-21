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
    if (arg === "--expect-unconfirmed-click") options.expectUnconfirmedClick = true;
    else if (arg === "--production") options.production = true;
    else if (arg === "--execute") options.execute = true;
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
  assert.ok(
    !options.execute || !options.production || options["native-app"],
    "Production --execute requires --native-app for exact grant identity",
  );
  assert.ok(
    !options.expectUnconfirmedClick || (options.production && options.execute),
    "Unconfirmed-click acceptance requires production and execute",
  );
  return options;
}

export function classifyNativeSmokeFailure(doctor) {
  // 工具名含accessibility不代表权限失败；只按同一App的结构化权限事实区分环境阻塞。
  return doctor && (doctor.accessibilityTrusted === false || doctor.screenCaptureGranted === false)
    ? "blocked"
    : "failed";
}

export function isFixtureReady(state) {
  return Boolean(
    state &&
    Number.isInteger(state.windowId) &&
    state.windowId > 0 &&
    state.active === true &&
    state.visible === true &&
    state.intersectsDisplay === true &&
    state.cgBounds?.width >= 540 &&
    state.cgBounds?.height >= 180,
  );
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

export function selectFixtureElement(result, identifier, role = "AXTextField") {
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
    (item) => item.identifier === identifier && item.role === role,
  );
  assert.equal(matches.length, 1, "Expected exactly one controlled fixture element");
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
    scenario: options.expectUnconfirmedClick ? "uncertain-click-no-replay" : "full",
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
    if (options.production && options.execute) {
      const doctor = JSON.parse(
        (await exec(options.native, ["doctor", "--json"], { timeout: 15000 })).stdout,
      );
      assert.equal(doctor.appAgent, true, "Production doctor must run in the permission App");
      assert.equal(
        doctor.grantOwnerBundleId,
        "dev.mikiko.computer-use",
        "Unexpected production grant owner",
      );
      assert.equal(doctor.appPath, options["native-app"], "Doctor belongs to a different App");
      report.doctor = doctor;
      report.steps.push("exact-production-app-agent-identity-verified");
    }
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
      await until(
        readState,
        isFixtureReady,
        "controlled fixture active, full-sized and on a real display",
      ),
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
    if (options.production) {
      assert.ok(
        report.tools.includes("list_apps") && report.tools.includes("stop"),
        "Production discovery/stop unavailable",
      );
    } else {
      assert.ok(
        !report.tools.includes("list_apps"),
        "Preview must not enumerate user applications",
      );
    }
    report.steps.push("sdk-initialize-and-tool-discovery");
    if (options.production) {
      const restarted = JSON.parse(
        (await exec(options.native, ["restart-agent", "--json"], { timeout: 20000 })).stdout,
      );
      assert.equal(restarted.restarted, true);
      assert.equal(restarted.permissions.accessibilityTrusted, true);
      assert.equal(restarted.permissions.screenCaptureGranted, true);
      report.steps.push("discovery-idle-restart-before-first-observation");
    }
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
    const shot = observation.content.find((item) => item.type === "image");
    const suffix = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[shot.mimeType];
    assert.ok(suffix && typeof shot.data === "string", "Unsupported native screenshot payload");
    const bytes = Buffer.from(shot.data, "base64");
    assert.ok(bytes.length > 100, "Native screenshot is empty");
    report.screenshot = join(directory, `fixture-observation.${suffix}`);
    await writeFile(report.screenshot, bytes);
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
    if (options.production) {
      const observe = () =>
        call("get_app_state", {
          app: prepared.bundleId,
          include_ax: true,
          include_screenshot: true,
          window_placement: "keep",
        });
      await observe();
      const buttons = await call("query", {
        app: prepared.bundleId,
        role: "AXButton",
        window_id: initial.windowId,
        limit: 20,
        max_nodes: 500,
      });
      const button = selectFixtureElement(buttons, initial.buttonIdentifier, "AXButton");
      if (options.expectUnconfirmedClick) {
        const result = await client.callTool(
          {
            name: "click",
            arguments: { app: prepared.bundleId, element_index: String(button.index) },
            _meta: { "com.zcode/request-context": context },
          },
          { timeout: 15000 },
        );
        assert.equal(result.isError, true, "Delayed unconfirmed AX action must not claim success");
        assert.ok(
          JSON.stringify(result).includes("outcome unconfirmed"),
          "Missing native outcome classification",
        );
        const finished = await until(
          readState,
          (state) => state?.completedClicks === 1,
          "owned delayed action completed",
        );
        verifyFixtureIdentity(finished, expected);
        assert.equal(finished.clicks, 1, "Unconfirmed action was replayed");
        report.steps.push("unconfirmed-ax-action-dispatched-exactly-once");
        report.status = "passed";
        return report;
      }
      await call("click", { app: prepared.bundleId, element_index: String(button.index) });
      const clicked = await until(
        readState,
        (state) => state?.clicks === 1,
        "fixture-owned button click readback",
      );
      verifyFixtureIdentity(clicked, expected);
      report.steps.push("native-ax-click-confirmed-by-fixture-owner");
      await observe();
      await call("press_key", { app: prepared.bundleId, key: "super+a" });
      const typed = `mikiko-键盘🙂-${nonce}`;
      await observe();
      await call("type_text", { app: prepared.bundleId, text: typed });
      const keyboard = await until(
        readState,
        (state) => state?.value === typed,
        "fixture-owned keyboard input readback",
      );
      verifyFixtureIdentity(keyboard, expected);
      report.steps.push("native-keyboard-confirmed-by-fixture-owner");
      const inventory = await client.callTool(
        { name: "list_apps", arguments: {}, _meta: { "com.zcode/request-context": context } },
        { timeout: 15000 },
      );
      assert.ok(
        !inventory.isError && JSON.stringify(inventory).includes(prepared.bundleId),
        "App inventory did not include the owned fixture",
      );
      report.steps.push("native-inventory-includes-owned-fixture-without-persisting-user-app-list");
      await observe();
      const currentField = selectFixtureElement(await query(), initial.fieldIdentifier);
      await call("select_text", {
        app: prepared.bundleId,
        element_index: String(currentField.index),
        text: typed,
        selection: "text",
      });
      const selected = await until(
        readState,
        (state) => state?.selectionLength === typed.length,
        "owned UTF16 selection readback",
      );
      assert.equal(selected.selectionLocation, 0);
      report.steps.push("native-select-text-confirms-unicode-range");
      await observe();
      const windows = await call("query", {
        app: prepared.bundleId,
        role: "AXWindow",
        window_id: initial.windowId,
        limit: 20,
        max_nodes: 500,
      });
      const window = selectFixtureElement(windows, undefined, "AXWindow");
      await call("perform_secondary_action", {
        app: prepared.bundleId,
        element_index: String(window.index),
        action: "Raise",
      });
      report.steps.push("native-secondary-window-raise");
      await observe();
      const areas = await call("query", {
        app: prepared.bundleId,
        role: "AXScrollArea",
        window_id: initial.windowId,
        limit: 20,
        max_nodes: 500,
      });
      const area = selectFixtureElement(areas, initial.scrollIdentifier, "AXScrollArea");
      const beforeScroll = await readState();
      await call("scroll", {
        app: prepared.bundleId,
        element_index: String(area.index),
        direction: "down",
        pages: 1,
      });
      await until(
        readState,
        (state) => state?.scrollY > beforeScroll.scrollY,
        "owned scroll view offset changed",
      );
      report.steps.push("native-scroll-confirmed-by-fixture-owner");
      const dragObservation = await observe();
      const dragShot = dragObservation.content.find((item) => item.type === "image");
      assert.equal(
        dragShot?.mimeType,
        "image/png",
        "Controlled fixture uses default PNG for pixel mapping",
      );
      const dragPixels = Buffer.from(dragShot.data, "base64").readUInt32BE(16);
      const beforeDrag = await readState();
      const scale = dragPixels / beforeDrag.cgBounds.width;
      await call("drag", {
        app: prepared.bundleId,
        from_x: beforeDrag.dragFromX * scale,
        from_y: beforeDrag.dragY * scale,
        to_x: beforeDrag.dragToX * scale,
        to_y: beforeDrag.dragY * scale,
      });
      await until(
        readState,
        (state) => state?.dragMoves > 0 && state?.dragEnds === 1,
        "owned real-pointer drag events",
      );
      report.steps.push("native-real-pointer-drag-confirmed-by-fixture-owner");
      await call("stop", {});
      report.steps.push("production-stop-releases-owned-connection");
      const denied = await client.callTool(
        {
          name: "set_value",
          arguments: {
            app: prepared.bundleId,
            element_index: String(element.index),
            value: "must-not-send",
          },
          _meta: { "com.zcode/request-context": context },
        },
        { timeout: 15000 },
      );
      assert.equal(denied.isError, true, "Stopped connection reused old observation");
      assert.ok(JSON.stringify(denied).includes("observation-required"));
      report.steps.push("stopped-observation-cannot-authorize-action");
      // 只对本次自有窗口取消一次真实拖拽，验证原生释放而非仅SDK Promise取消。
      const cancelShotResult = await observe();
      const cancelShot = cancelShotResult.content.find((item) => item.type === "image");
      assert.equal(cancelShot?.mimeType, "image/png");
      const cancelBefore = await readState();
      const cancelScale =
        Buffer.from(cancelShot.data, "base64").readUInt32BE(16) / cancelBefore.cgBounds.width;
      const dragCancel = new AbortController();
      const dragging = client.callTool(
        {
          name: "drag",
          arguments: {
            app: prepared.bundleId,
            from_x: cancelBefore.dragFromX * cancelScale,
            from_y: cancelBefore.dragY * cancelScale,
            to_x: cancelBefore.dragToX * cancelScale,
            to_y: cancelBefore.dragY * cancelScale,
          },
          _meta: { "com.zcode/request-context": context },
        },
        { timeout: 15000, signal: dragCancel.signal },
      );
      // 马上注册拒绝处理，避免等待fixture期间出现未处理Promise。
      const canceledResult = dragging.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await until(
        readState,
        (state) => state?.dragStarts === cancelBefore.dragStarts + 1,
        "second real drag pressed",
      );
      dragCancel.abort();
      const canceled = await canceledResult;
      assert.ok(
        canceled.error || canceled.value?.isError,
        "Cancellation unexpectedly reported success",
      );
      const released = await until(
        readState,
        (state) => state?.dragEnds === cancelBefore.dragEnds + 1,
        "canceled native drag released mouse",
      );
      assert.ok(
        released.dragMoves < cancelBefore.dragMoves + 30,
        "Canceled drag completed all motion",
      );
      await setTimeout(250);
      const stable = await readState();
      assert.equal(
        stable.dragMoves,
        released.dragMoves,
        "Native continued motion after cancellation",
      );
      assert.equal(stable.dragEnds, released.dragEnds, "Native released mouse more than once");
      report.steps.push("real-drag-cancellation-stops-motion-and-releases-once");
    }
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = classifyNativeSmokeFailure(report.doctor);
    report.error = String(error.stack ?? error);
    report.finalFixture = await readState().catch(() => undefined);
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
