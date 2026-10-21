import { describe, expect, it } from "vitest";
import {
  completeModelPropertiesDataSchema,
  modelPropertiesDataSchema,
  completeEnumOptionSpecDataSchema,
} from "@zcode/shared/model-config";

function completeProperties() {
  return {
    requiresMfjsToolSchema: false,
    contextWindow: 128000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  };
}

describe("共享 Model 数据合同", () => {
  it("拒绝未发布的旧格式名字，不双读、不静默丢字段", () => {
    for (const key of ["input_format", "output_format"]) {
      expect(modelPropertiesDataSchema.safeParse({ [key]: {} }).success).toBe(false);
    }
    for (const key of [
      "support_text",
      "support_image",
      "support_video",
      "support_audio",
      "support_pdf",
    ]) {
      expect(modelPropertiesDataSchema.safeParse({ inputFormat: { [key]: true } }).success).toBe(
        false,
      );
    }
  });

  it("公共合同不把缺省/null补成默认能力，不放宽完整模型", () => {
    const partial = { inputFormat: { supportsImage: null } };
    expect(modelPropertiesDataSchema.parse(partial)).toEqual(partial);
    expect(completeModelPropertiesDataSchema.safeParse(partial).success).toBe(false);
    expect(modelPropertiesDataSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("共享层保留纯表达式校验，不只验证字符串类型", () => {
    expect(
      completeEnumOptionSpecDataSchema.safeParse({
        values: ["disabled", "high"],
        map: '{"reasoning_effort": reasoningLevel}',
      }).success,
    ).toBe(true);
    expect(completeEnumOptionSpecDataSchema.safeParse({ values: ["high"], map: "{" }).success).toBe(
      false,
    );
  });

  it("promptCacheKeyMode 是可选枚举：接受 auto/on/off 与缺省，拒绝非法值", () => {
    for (const mode of ["auto", "on", "off"]) {
      expect(modelPropertiesDataSchema.safeParse({ promptCacheKeyMode: mode }).success).toBe(true);
      expect(
        completeModelPropertiesDataSchema.safeParse({
          ...completeProperties(),
          promptCacheKeyMode: mode,
        }).success,
      ).toBe(true);
    }
    expect(modelPropertiesDataSchema.safeParse({ promptCacheKeyMode: "always" }).success).toBe(
      false,
    );
    expect(completeModelPropertiesDataSchema.safeParse(completeProperties()).success).toBe(true);
  });
});
