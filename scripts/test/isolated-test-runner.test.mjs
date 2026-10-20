import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const runner = resolve(import.meta.dirname, "../run-isolated-tests.mjs");

for (const exitCode of [0, 7]) {
  test(`isolates child data and removes it after exit ${exitCode}`, async (t) => {
    const parentHome = await mkdtemp(join(tmpdir(), "mikiko-test-parent-"));
    t.after(() => rm(parentHome, { recursive: true, force: true }));
    const sentinel = join(parentHome, "sentinel.json");
    const parent = process.env.HOME;
    const program = `const fs=require('node:fs'),path=require('node:path'),os=require('node:os'); const dir=path.join(os.homedir(),'.mikiko','cli');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'probe'),'child');console.log(JSON.stringify({home:os.homedir(),base:process.env.MIKIKO_DATA_BASE_DIR,storage:process.env.MIKIKO_STORAGE_DIR??null,db:process.env.ZCODE_SESSION_DB_PATH??null,productHome:process.env.MIKIKO_HOME??null,logDir:process.env.MIKIKO_LOG_DIR??null}));process.exitCode=${exitCode};`;
    let result;
    try {
      result = await exec(process.execPath, [runner, "node", "-e", program], {
        env: {
          ...process.env,
          HOME: parentHome,
          USERPROFILE: parentHome,
          MIKIKO_DATA_BASE_DIR: parentHome,
          MIKIKO_STORAGE_DIR: sentinel,
          ZCODE_SESSION_DB_PATH: sentinel,
          MIKIKO_HOME: parentHome,
          MIKIKO_LOG_DIR: sentinel,
        },
      });
      assert.equal(exitCode, 0);
    } catch (error) {
      assert.equal(error.code, exitCode);
      result = error;
    }
    const state = JSON.parse(result.stdout.trim());
    assert.notEqual(state.home, parentHome);
    assert.notEqual(state.home, homedir());
    assert.equal(state.base, state.home);
    assert.equal(state.storage, null);
    assert.equal(state.db, null);
    assert.equal(state.productHome, null);
    assert.equal(state.logDir, null);
    await assert.rejects(readFile(join(state.home, ".mikiko/cli/probe")), /ENOENT/);
    assert.deepEqual(await readdir(parentHome), []);
    assert.equal(process.env.HOME, parent);
  });
}

test("missing command reports usage without creating an isolated home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-runner-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    exec(process.execPath, [runner], {
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    }),
    (error) => error.code === 1 && /Usage: run-isolated-tests/u.test(error.stderr),
  );
  assert.deepEqual(await readdir(root), []);
});

test("a command spawn failure exits nonzero and removes the temporary home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-runner-spawn-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    exec(process.execPath, [runner, join(root, "missing-test-command")], {
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    }),
    (error) => error.code === 1 && /missing-test-command/u.test(error.stderr),
  );
  assert.deepEqual(await readdir(root), []);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

for (const [signalToSend, mode] of [
  ["SIGTERM", "command"],
  ["SIGTERM", "descendants"],
  ["SIGTERM", "graceful-zero"],
  ["SIGINT", "graceful-zero"],
]) {
  test(
    `${signalToSend} cancels owned ${mode} and cleans its home`,
    {
      skip:
        process.platform === "win32"
          ? "POSIX signal semantics; Windows process-tree behavior needs its native runner"
          : false,
      timeout: 10000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "mikiko-runner-cancel-"));
      let ownedPid;
      const program =
        mode === "descendants"
          ? `const {spawn}=require('node:child_process');const nested=spawn(process.execPath,['-e','console.log("ready");setTimeout(()=>process.exit(0),8000);'],{stdio:['ignore','pipe','ignore']});nested.stdout.once('data',()=>console.log(JSON.stringify({home:require('node:os').homedir(),ownedPid:nested.pid})));setInterval(()=>{},1000);`
          : `${mode === "graceful-zero" ? `process.on(${JSON.stringify(signalToSend)},()=>process.exit(0));` : ""}console.log(JSON.stringify({home:require('node:os').homedir(),ownedPid:process.pid}));setInterval(()=>{},1000);`;
      const wrapper = spawn(process.execPath, [runner, "node", "-e", program], {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.after(async () => {
        if (ownedPid && processExists(ownedPid)) process.kill(ownedPid, "SIGTERM");
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
        await rm(root, { recursive: true, force: true });
      });
      const closed = once(wrapper, "close");
      const state = await new Promise((resolveReady, rejectReady) => {
        let output = "";
        const timer = setTimeout(
          () => rejectReady(new Error("owned test command did not report readiness")),
          5000,
        );
        wrapper.once("error", (error) => {
          clearTimeout(timer);
          rejectReady(error);
        });
        wrapper.stdout.on("data", (chunk) => {
          output += chunk;
          if (!output.includes("\n")) return;
          clearTimeout(timer);
          try {
            resolveReady(JSON.parse(output.trim().split("\n")[0]));
          } catch (error) {
            rejectReady(error);
          }
        });
      });
      ownedPid = state.ownedPid;
      assert.ok(processExists(ownedPid));
      wrapper.kill(signalToSend);
      const [code, signal] = await closed;
      assert.equal(code, signalToSend === "SIGINT" ? 130 : 143);
      assert.equal(signal, null);
      assert.deepEqual(await readdir(root), []);
      const deadline = Date.now() + 1000;
      while (processExists(ownedPid) && Date.now() < deadline)
        await new Promise((resolveGone) => setTimeout(resolveGone, 20));
      assert.equal(
        processExists(ownedPid),
        false,
        "canceled runner must not leave its owned test process running",
      );
    },
  );
}

test("the exported runner keeps its caller's home and data environment intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-runner-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ["HOME", "USERPROFILE", "MIKIKO_DATA_BASE_DIR", "GIT_CONFIG_GLOBAL"];
  const before = keys.map((key) => process.env[key]);
  const { runIsolatedTests } = await import(pathToFileURL(runner).href);
  const record = join(root, "child.json");
  const program =
    "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({home:require('node:os').homedir(),base:process.env.MIKIKO_DATA_BASE_DIR}));";
  assert.equal(await runIsolatedTests(["node", "-e", program, record]), 0);
  assert.deepEqual(
    keys.map((key) => process.env[key]),
    before,
  );
  const child = JSON.parse(await readFile(record, "utf8"));
  assert.notEqual(child.home, homedir());
  assert.equal(child.home, child.base);
  await assert.rejects(readdir(child.home), /ENOENT/u);
});

test(
  "the real vitest entry receives a regex filter without shell interpretation",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mikiko runner filter "));
    t.after(() => rm(root, { recursive: true, force: true }));
    await symlink(
      resolve(import.meta.dirname, "../../node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = join(root, "vitest.config.mjs");
    const report = join(root, "report.json");
    await writeFile(config, 'export default {test:{include:["filter.test.mjs"],maxWorkers:1}};');
    await writeFile(
      join(root, "filter.test.mjs"),
      'import {test,expect} from "vitest";for(const name of ["foo","bar","baz"])test(name,()=>expect(true).toBe(true));',
    );
    await exec(
      process.execPath,
      [
        runner,
        "vitest",
        "run",
        "--config",
        config,
        "--root",
        root,
        "--testNamePattern",
        "foo|bar",
        "--reporter=json",
        "--outputFile",
        report,
      ],
      { timeout: 12000 },
    );
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.numPassedTests, 2);
    assert.equal(result.numPendingTests, 1);
  },
);
