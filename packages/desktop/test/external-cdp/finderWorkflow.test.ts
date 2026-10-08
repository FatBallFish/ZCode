import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFinderOpenFolderWorkflow } from "../../src/main/desktopFinderOpenFolderWorkflow.js";

/**
 * Finder「打开」服务三形态隔离（specs/desktop/external-cdp.md）：
 * workflow 目录名/bundle id/文案按形态隔离互不覆盖；production 清理旧 ZCode.workflow；
 * 非 macOS no-op。refreshServicesIndex 注入避免真实 pbs 调用。
 */

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), "mikiko-finder-test-"));
  const logger = {
    info: () => {},
    warn: () => {},
  };
  return {
    homeDir,
    logger,
    servicesDir: join(homeDir, "Library", "Services"),
    install: (options: {
      locale?: "zh-CN" | "en-US";
      flavor: "production" | "preview";
      isPackaged?: boolean;
    }) =>
      installFinderOpenFolderWorkflow({
        platform: "darwin",
        locale: options.locale ?? "zh-CN",
        flavor: options.flavor,
        isPackaged: options.isPackaged ?? true,
        homeDir,
        logger,
        refreshServicesIndex: () => {},
      }),
  };
}

test("production 写 Mikiko workflow 并清理旧 ZCode.workflow", () => {
  const harness = createHarness();
  try {
    // 预置本 fork 早期版本遗留的 ZCode workflow，模拟历史安装。
    const legacyDir = join(harness.servicesDir, "Open in ZCode.workflow");
    mkdirSync(join(legacyDir, "Contents"), { recursive: true });
    writeFileSync(join(legacyDir, "Contents", "Info.plist"), "legacy");
    harness.install({ flavor: "production" });
    assert.equal(existsSync(legacyDir), false, "旧 ZCode.workflow 应被清理");
    const plist = readFileSync(
      join(harness.servicesDir, "Open in Mikiko.workflow", "Contents", "Info.plist"),
      "utf8",
    );
    assert.ok(plist.includes("dev.mikiko.app.finder-open-workflow</string>"));
    assert.ok(plist.includes("在 Mikiko 中打开"));
  } finally {
    rmSync(harness.homeDir, { recursive: true, force: true });
  }
});

test("preview/dev 各写各的 workflow，不覆盖 production", () => {
  const harness = createHarness();
  try {
    harness.install({ flavor: "production" });
    const productionPlist = readFileSync(
      join(harness.servicesDir, "Open in Mikiko.workflow", "Contents", "Info.plist"),
      "utf8",
    );
    harness.install({ flavor: "preview" });
    harness.install({ flavor: "preview", isPackaged: false });
    const previewPlist = readFileSync(
      join(harness.servicesDir, "Open in Mikiko Preview.workflow", "Contents", "Info.plist"),
      "utf8",
    );
    const devPlist = readFileSync(
      join(harness.servicesDir, "Open in Mikiko Dev.workflow", "Contents", "Info.plist"),
      "utf8",
    );
    assert.ok(previewPlist.includes("dev.mikiko.app.finder-open-workflow.preview"));
    assert.ok(previewPlist.includes("在 Mikiko Preview 中打开"));
    assert.ok(devPlist.includes("dev.mikiko.app.finder-open-workflow.dev"));
    assert.equal(
      readFileSync(
        join(harness.servicesDir, "Open in Mikiko.workflow", "Contents", "Info.plist"),
        "utf8",
      ),
      productionPlist,
      "production workflow 不得被其他形态改写",
    );
  } finally {
    rmSync(harness.homeDir, { recursive: true, force: true });
  }
});

test("en-US 文案与 zh-CN 切换互不残留；非 macOS no-op", () => {
  const harness = createHarness();
  try {
    harness.install({ flavor: "production", locale: "en-US" });
    const plist = readFileSync(
      join(harness.servicesDir, "Open in Mikiko.workflow", "Contents", "Info.plist"),
      "utf8",
    );
    assert.ok(plist.includes("Open in Mikiko</string>"));
    assert.ok(!plist.includes("在 Mikiko 中打开"));
    installFinderOpenFolderWorkflow({
      platform: "linux",
      locale: "zh-CN",
      flavor: "production",
      isPackaged: true,
      homeDir: harness.homeDir,
      logger: harness.logger,
      refreshServicesIndex: () => {},
    });
    assert.equal(existsSync(join(harness.servicesDir, "Open in Mikiko Dev.workflow")), false);
  } finally {
    rmSync(harness.homeDir, { recursive: true, force: true });
  }
});
