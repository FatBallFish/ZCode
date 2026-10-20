import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { parseClientConfigSnapshot } from "@zcode/shared";
import {
  activateNewTabSidePane,
  activatePluginMarketSidePane,
  stampSidePaneTabsOwnership,
} from "@/lib/workspaceSidePane.js";
import { openPluginUiSidePane } from "@/plugin-ui/index.js";

export const noop = () => {};
export const Pass = ({ children }: { children: ReactNode }) => children;
export const Empty = () => null;
const workspacePath = "/fixture/session-window";
const workspaceIdentity = "fixture-session-window-identity";
const sessionId = "fixture-session-window-session";
const listeners = new Set<() => void>();
let settings: Record<string, unknown> = { voiceCleanupEnabled: true };
export function useSettings() {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => settings,
  );
  return {
    settings: snapshot,
    update: async (patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
      (window as any).__uiSettingWrites.push(patch);
      listeners.forEach((listener) => listener());
    },
  };
}
export const modelView = {
  providers: ["first", "relay"].map((id) => ({
    providerId: `${id}-provider`,
    providerName: id === "first" ? "Local Provider" : "Mikiko Relay",
    config: { api: { type: "anthropic" }, access: { type: "api-key" } },
    models: ["one", "two"].map((model) => ({
      modelId: `${id}-${model}`,
      config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
    })),
  })),
};
export const useModelSelectionView = () => ({ state: { status: "ready", view: modelView } });
export const useChatGPTAccounts = () => ({ accounts: [] });
export const buildChatGPTAccountLabels = () => ({});
const tabState = {
  tabs: [{ id: "fixture", kind: "workspace", workspacePath, workspaceIdentity }],
  activeTabId: "fixture",
};
export const useTabStore = (selector: (state: any) => unknown) => selector(tabState);
export const useZCodeStore = () => null;
export const useWorkspaceShellZCodeState = () => ({ workspaceShellZCodeState: {} });
export const useWorkspaceActiveTaskState = () => ({
  taskNativeSessionLogFile: {},
  taskSessionFile: null,
});
export const useWorkspaceProviderConfigFile = () => ({});
export const useGitRepository = () => ({ sourceOptions: [], summary: {} });
export const getGitDirtyFileCount = () => 0;
export const useAnimatedResizablePanel = ({ open }: { open: boolean }) => ({
  panelRef: useRef(null),
  panelElementRef: useRef(null),
  isVisible: open,
});
export const useTaskSidePaneMemoryBridge = () => ({ browserRestoreUrls: {} });
export const useBrowserScreenshotSurfaceRequest = () => null;
export function useAppPanels() {
  const [sidePaneState, setState] = useState(() =>
    stampSidePaneTabsOwnership(activateNewTabSidePane(null), {
      workspaceKey: workspaceIdentity,
      ownerTaskId: sessionId,
    }),
  );
  const [isSidePaneCollapsed, setCollapsed] = useState(false);
  useEffect(() => {
    (window as any).__uiPanelState = sidePaneState;
  }, [sidePaneState]);
  const handleOpenPluginUi = useCallback((request: any) => {
    (window as any).__uiPanelRequests.push(request);
    setState((state) =>
      openPluginUiSidePane(state, { ...request, workspaceKey: workspaceIdentity }),
    );
  }, []);
  return {
    sidePaneState,
    isSidePaneCollapsed,
    recentClosedSidePaneTabs: [],
    handleOpenPluginUi,
    handleOpenPluginMarket: () => setState(activatePluginMarketSidePane),
    handleOpenNewSidePaneTab: () => setState(activateNewTabSidePane),
    handleActivateSidePaneTab: (id: string) => setState((state) => ({ ...state, activeTabId: id })),
    handleToggleSidePaneCollapse: () => setCollapsed((current) => !current),
    handleCloseSidePaneTab: (id: string) =>
      setState((state) => ({ ...state, tabs: state.tabs.filter((tab) => tab.id !== id) })),
  };
}

export const PluginStorePage = () => (
  <section data-testid="fixture-market">Mikiko fixture plugin catalog</section>
);
export const PluginUiSidePane = () => (
  <section data-testid="fixture-plugin-panel">Fixture plugin content</section>
);
const surface = {
  id: "panel",
  pluginId: "fixture@personal",
  pluginName: "Fixture plugin",
  title: { en: "Fixture plugin", "zh-CN": "测试插件" },
  server: "plugin:fixture:server",
  resourceUri: "ui://fixture/panel.html",
};
const catalog = {
  plugins: [
    {
      id: surface.pluginId,
      name: "Fixture plugin",
      marketplace: "personal",
      enabled: true,
      uiSurfaces: [surface],
    },
  ],
  availablePlugins: [
    {
      id: surface.pluginId,
      name: "Fixture plugin",
      marketplace: "personal",
      installed: true,
      info: { name: "Fixture plugin" },
    },
  ],
  marketplaces: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
};
export const services = {
  pluginManagementService: {
    listPlugins: async () => catalog,
    getPluginsOverview: async () => catalog,
  },
  clientConfigService: {
    getSnapshot: async () =>
      parseClientConfigSnapshot({
        code: 0,
        data: {
          configs: {
            uiPluginRecommendations: [{ pluginId: surface.pluginId, surfaceId: surface.id }],
          },
        },
      }),
  },
  pluginUiBridgeService: { listSurfaces: async () => [surface] },
};
export const platform = { voiceGetState: async () => null, pluginSandbox: {} };
