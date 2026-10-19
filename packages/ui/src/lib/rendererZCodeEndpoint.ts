import {
  buildRuntimeZCodeEndpointUrls,
  ZCODE_ENV,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";

interface RendererImportMetaEnv {
  VITE_MIKIKO_BASE_URL?: string;
  VITE_MIKIKO_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

export function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    MIKIKO_ENV: ZCODE_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看编译期环境常量，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    MIKIKO_BASE_URL: env.VITE_MIKIKO_BASE_URL,
    MIKIKO_ENDPOINT_ORIGIN: env.VITE_MIKIKO_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ZCODE_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);
