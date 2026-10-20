// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceInputSettingsSection } from "@/settings/VoiceInputSettingsSection.js";

const fixture = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  view: {
    providers: [
      {
        providerId: "fixture-provider",
        providerName: "Fixture Provider",
        config: { api: { type: "anthropic" }, access: { type: "api-key" } },
        models: [
          {
            modelId: "fixture-model",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
    ],
  },
  pickerProps: null as Record<string, any> | null,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { voiceCleanupEnabled: true }, update: fixture.update }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ voiceGetState: async () => null }),
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({ state: { status: "ready", view: fixture.view } }),
}));
vi.mock("@/hooks/useChatGPTAccounts.js", () => ({
  useChatGPTAccounts: () => ({ accounts: [] }),
  buildChatGPTAccountLabels: () => ({}),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: unknown) => unknown) => selector({ tabs: [], activeTabId: null }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({ useShortcutCommandLabel: () => "" }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/settings/VoiceModelCardList.js", () => ({ VoiceModelCardList: () => null }));
vi.mock("@/settings/VoiceDevicePermissionCard.js", () => ({
  VoiceDevicePermissionCard: () => null,
}));
vi.mock("@/ModelConfigSelect.js", () => ({
  ModelConfigSelect: (props: Record<string, any>) => {
    fixture.pickerProps = props;
    return createElement(
      "button",
      { onClick: () => props.onValueChange(props.modelGroups[0].items[0].value) },
      "Choose cleanup model",
    );
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixture.pickerProps = null;
});

it("uses the conversation menu while keeping cleanup selection local and at lowest effort", () => {
  render(createElement(VoiceInputSettingsSection, { isDesktop: true }));
  expect(fixture.pickerProps?.composerOptions).toMatchObject({
    providerLabel: "chat.toolbar.combined.provider",
    modelsLabel: "chat.toolbar.combined.models",
    levels: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose cleanup model" }));
  expect(fixture.update).toHaveBeenCalledTimes(1);
  expect(fixture.update).toHaveBeenCalledWith({
    voiceCleanupSelection: {
      providerId: "fixture-provider",
      modelId: "fixture-model",
      reasoningLevel: "low",
    },
  });
});
