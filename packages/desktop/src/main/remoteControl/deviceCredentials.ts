import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 桌面设备凭证存储（spec §5.2）：mid 明文 + deviceToken 经 Electron safeStorage 加密落盘。
 *
 * safeStorage 不可用（Linux 未装钥匙串等）或解密失败时退化为明文标记存储——
 * deviceToken 仅是 relay 注册凭证（丢失即重新注册），明文降级的风险可接受，
 * 不做拒绝服务式 fail-closed。
 */

/** Electron safeStorage 的最小子集，便于测试注入。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const ENCRYPTED_PREFIX = "enc:v1:";
const PLAIN_PREFIX = "plain:v1:";

interface StoredCredentials {
  mid: string;
  token?: string;
}

export interface DeviceCredentialStore {
  load(): Promise<StoredCredentials>;
  saveToken(token: string): Promise<void>;
  /** 清除 token（保留 mid）；relay 失效后由下一次注册重新换发。 */
  clearToken(): Promise<void>;
}

export function createDeviceCredentialStore(
  filePath: string,
  safeStorage?: SafeStorageLike,
  fs: { readFile: typeof readFile; writeFile: typeof writeFile; mkdir: typeof mkdir } = {
    readFile,
    writeFile,
    mkdir,
  },
): DeviceCredentialStore {
  let cached: StoredCredentials | null = null;

  async function readRaw(): Promise<StoredCredentials> {
    if (cached) {
      return cached;
    }
    try {
      const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as StoredCredentials;
      cached = {
        mid: typeof raw.mid === "string" && raw.mid ? raw.mid : randomUUID(),
        token: raw.token,
      };
      return cached;
    } catch {
      // 首次使用或文件损坏：生成新 mid 并落盘。
      cached = { mid: randomUUID() };
      await persist(cached);
      return cached;
    }
  }

  async function persist(value: StoredCredentials): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  function decryptStored(token: string): string | undefined {
    if (token.startsWith(ENCRYPTED_PREFIX)) {
      if (!safeStorage?.isEncryptionAvailable()) {
        return undefined;
      }
      try {
        return safeStorage.decryptString(
          Buffer.from(token.slice(ENCRYPTED_PREFIX.length), "base64"),
        );
      } catch {
        return undefined; // 钥匙串换了/迁移了：当作无凭证重新注册。
      }
    }
    if (token.startsWith(PLAIN_PREFIX)) {
      return token.slice(PLAIN_PREFIX.length);
    }
    return undefined;
  }

  return {
    async load() {
      const raw = await readRaw();
      return { mid: raw.mid, token: raw.token ? decryptStored(raw.token) : undefined };
    },
    async saveToken(token) {
      const raw = await readRaw();
      const stored = safeStorage?.isEncryptionAvailable()
        ? ENCRYPTED_PREFIX + safeStorage.encryptString(token).toString("base64")
        : PLAIN_PREFIX + token;
      raw.token = stored;
      await persist(raw);
      cached = raw;
    },
    async clearToken() {
      const raw = await readRaw();
      raw.token = undefined;
      await persist(raw);
      cached = raw;
    },
  };
}
