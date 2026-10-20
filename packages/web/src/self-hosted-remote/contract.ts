/** 自建 relay transport 的公开兼容入口；不装配上游 Relay V2。 */
export {
  WebRemoteControlTerminalTransport,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlAppPayloadRequester,
} from "../webRemoteControlTransport.js";
export {
  calculateBrowserWebRemoteControlProof,
  createBrowserWebRemoteControlRelayAuthProvider,
} from "../webRemoteControlRelayAuthProvider.js";
