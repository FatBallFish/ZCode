import { expect, it } from "vitest";
import {
  buildWebRemoteControlExternalQrUrl,
  parseWebRemoteControlExternalQrParams,
} from "../src/web-remote-control.js";

it("retains self-hosted relay QR credentials instead of applying Relay V2 sanitization", () => {
  const options = {
    baseUrl: "https://remote.mikiko.ai/remote/",
    deviceSid: "self-session",
    passHash: "signed-ticket",
    timestamp: 12345,
    deviceMid: "desktop",
  };
  const url = new URL(buildWebRemoteControlExternalQrUrl(options));
  expect(url.searchParams.get("hash")).toBe("signed-ticket");
  expect(url.searchParams.get("t")).toBe("12345");
  expect(parseWebRemoteControlExternalQrParams(url.searchParams)).toMatchObject({
    deviceSid: options.deviceSid,
    passHash: options.passHash,
    timestamp: options.timestamp,
  });
});
