import assert from "node:assert/strict";
import test from "node:test";
import { parseExternalCdpConfiguration } from "@zcode/adapters/browser";
import {
  DEFAULT_EXTERNAL_CDP_CONFIGURATION,
  EXTERNAL_CDP_CONFIGURATION_ENV,
  EXTERNAL_CDP_REMOTE_CONTROL_ENV,
} from "@zcode/shared";
import {
  buildExternalCdpEnvPatch,
  resolveExternalCdpRuntimeConfig,
  validateExternalCdpConfiguration,
} from "../../src/main/externalCdpSettings.js";

/**
 * 外部浏览器配置解析（specs/desktop/external-cdp.md）：
 * 优先级 settings > MIKIKO_EXTERNAL_CDP env > 内置默认；非法 settings 回退；
 * 远控开关 settings 显式值 > env "0" > 默认允许。
 */

const SETTINGS_CONFIG = '{"instances":[{"id":"work-a","endpoint":"http://127.0.0.1:9333"}]}';
const ENV_CONFIG = '{"instances":[{"id":"env-b","endpoint":"http://127.0.0.1:9334"}]}';

test("内置默认配置本身可通过 adapters 校验且指向 9333", () => {
  const parsed = parseExternalCdpConfiguration(DEFAULT_EXTERNAL_CDP_CONFIGURATION);
  assert.equal(parsed.instances.length, 1);
  assert.equal(parsed.instances[0]?.id, "default");
  assert.equal(parsed.instances[0]?.endpoint, "http://127.0.0.1:9333");
});

test("优先级：settings > env > 内置默认", () => {
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      settings: { externalCdpConfig: SETTINGS_CONFIG },
      env: { [EXTERNAL_CDP_CONFIGURATION_ENV]: ENV_CONFIG },
    }).config,
    SETTINGS_CONFIG,
  );
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      env: { [EXTERNAL_CDP_CONFIGURATION_ENV]: ENV_CONFIG },
    }).config,
    ENV_CONFIG,
  );
  assert.equal(
    resolveExternalCdpRuntimeConfig({ env: {} }).config,
    DEFAULT_EXTERNAL_CDP_CONFIGURATION,
  );
});

test("非法 settings 配置回退 env/默认，不把坏配置塞给 host", () => {
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      settings: { externalCdpConfig: '{"instances":"bad"}' },
      env: { [EXTERNAL_CDP_CONFIGURATION_ENV]: ENV_CONFIG },
    }).config,
    ENV_CONFIG,
  );
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      settings: { externalCdpConfig: "not-json" },
      env: {},
    }).config,
    DEFAULT_EXTERNAL_CDP_CONFIGURATION,
  );
  assert.equal(validateExternalCdpConfiguration("not-json").ok, false);
  assert.equal(validateExternalCdpConfiguration(SETTINGS_CONFIG).ok, true);
});

test("远控开关：settings 显式值 > env 0 > 默认允许", () => {
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      settings: { externalCdpRemoteControlEnabled: false },
      env: {},
    }).remoteControlEnabled,
    false,
  );
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      env: { [EXTERNAL_CDP_REMOTE_CONTROL_ENV]: "0" },
    }).remoteControlEnabled,
    false,
  );
  // settings 未定义时跟随 env；settings 显式 true 覆盖 env 0。
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      env: { [EXTERNAL_CDP_REMOTE_CONTROL_ENV]: "1" },
    }).remoteControlEnabled,
    true,
  );
  assert.equal(
    resolveExternalCdpRuntimeConfig({
      settings: { externalCdpRemoteControlEnabled: true },
      env: { [EXTERNAL_CDP_REMOTE_CONTROL_ENV]: "0" },
    }).remoteControlEnabled,
    true,
  );
  assert.equal(resolveExternalCdpRuntimeConfig({ env: {} }).remoteControlEnabled, true);
});

test("env 注入片段包含最终配置与远控开关", () => {
  const patch = buildExternalCdpEnvPatch({
    config: SETTINGS_CONFIG,
    remoteControlEnabled: false,
  });
  assert.deepEqual(patch, {
    [EXTERNAL_CDP_CONFIGURATION_ENV]: SETTINGS_CONFIG,
    [EXTERNAL_CDP_REMOTE_CONTROL_ENV]: "0",
  });
});
