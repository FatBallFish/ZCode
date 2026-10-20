import { createBrowserWebRemoteControlRelayAuthProvider } from "./contract.js";
/** 凭据由既有配对 owner 提供；HMAC 只绑定当前 nonce/角色/deviceSid，不改变服务协议。 */
export function provePairedTerminal(
  passHash: string,
  nonce: string,
  deviceSid: string,
): Promise<string> {
  return createBrowserWebRemoteControlRelayAuthProvider().calculateProof(
    passHash,
    nonce,
    "terminal",
    deviceSid,
  );
}
