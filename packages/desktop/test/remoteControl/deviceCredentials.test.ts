import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  createDeviceCredentialStore,
  type SafeStorageLike,
} from "../../src/main/remoteControl/deviceCredentials.js";

function fakeSafeStorage(): SafeStorageLike & { calls: number } {
  const calls = { count: 0 };
  return {
    get count() {
      return calls.count;
    },
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      calls.count += 1;
      return Buffer.from(`enc::${plain}`, "utf8");
    },
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc::")) {
        throw new Error("bad ciphertext");
      }
      return text.slice("enc::".length);
    },
  };
}

test("首启生成 mid；saveToken/load 往返（safeStorage 加密）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rc-cred-"));
  const file = join(dir, "device.json");
  const storage = fakeSafeStorage();
  const store = createDeviceCredentialStore(file, storage);

  const first = await store.load();
  assert.ok(first.mid, "首启生成 mid");
  assert.equal(first.token, undefined);

  await store.saveToken("token-1");
  const second = await store.load();
  assert.equal(second.mid, first.mid, "mid 稳定");
  assert.equal(second.token, "token-1");
  assert.ok(storage.count >= 1, "经过加密");

  // 新实例（进程重启）仍能读回。
  const reopened = createDeviceCredentialStore(file, fakeSafeStorage());
  const third = await reopened.load();
  assert.equal(third.token, "token-1");
});

test("safeStorage 不可用时明文降级仍可用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rc-cred-"));
  const store = createDeviceCredentialStore(join(dir, "device.json"));
  await store.saveToken("plain-token");
  assert.equal((await store.load()).token, "plain-token");
});

test("加密token在钥匙串失效后按无凭证处理；clearToken 保留 mid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rc-cred-"));
  const file = join(dir, "device.json");
  const store = createDeviceCredentialStore(file, fakeSafeStorage());
  await store.saveToken("token-2");

  // 换一个「解密必失败」的钥匙串（模拟系统迁移/重装）。
  const broken = createDeviceCredentialStore(file, {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from("x"),
    decryptString: () => {
      throw new Error("keychain gone");
    },
  });
  assert.equal((await broken.load()).token, undefined, "解密失败降级为无凭证");

  const cleared = createDeviceCredentialStore(file, fakeSafeStorage());
  const before = await cleared.load();
  assert.equal(before.token, "token-2");
  await cleared.clearToken();
  const after = await cleared.load();
  assert.equal(after.token, undefined);
  assert.equal(after.mid, before.mid, "clearToken 不动 mid");
});
