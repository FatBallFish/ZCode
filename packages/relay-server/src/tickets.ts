import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 手机远控票据与会话凭证的签发/校验（spec §5/§21.1）。
 *
 * 二维码票据: accessHash = HMAC-SHA256(relaySecret, `<prefix>:${sid}:${mid}:${t}`)，
 * 前缀短时票据 `zrc1`（10min TTL）、长效票据 `zrc1l`（无 TTL）；票据可多次 bind（§21.1）。
 * 会话凭证: 32 字节随机 sessionToken，仅存 relay 内存。
 * 设备凭证: 32 字节随机 deviceToken，relay 只存 sha256 哈希。
 */

const BASE62_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function base62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62_ALPHABET[bytes[i]! % BASE62_ALPHABET.length];
  }
  return out;
}

/** 票据签发串接格式是 wire 契约，不得变更（变更需先改 spec 并升协议版本）。 */
export function computeAccessHash(
  secret: string,
  sid: string,
  mid: string,
  issuedAt: number,
  persistent = false,
): string {
  const prefix = persistent ? "zrc1l" : "zrc1";
  return createHmac("sha256", secret)
    .update(`${prefix}:${sid}:${mid}:${issuedAt}`)
    .digest("base64url");
}

export function verifyAccessHash(
  secret: string,
  sid: string,
  mid: string,
  issuedAt: number,
  hash: string,
  persistent = false,
): boolean {
  // 双侧都必须显式按 base64url 解码；Buffer.from(string) 默认 UTF-8 会导致长度恒不等。
  const expected = Buffer.from(
    computeAccessHash(secret, sid, mid, issuedAt, persistent),
    "base64url",
  );
  let actual: Buffer;
  try {
    actual = Buffer.from(hash, "base64url");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function newSessionId(): string {
  return `s_${base62(22)}`;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newMachineId(): string {
  return crypto.randomUUID();
}
