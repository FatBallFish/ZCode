import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { VoiceInputSettingsSection } from "@/settings/VoiceInputSettingsSection.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform, services } from "./ui-regressions-478.state.fixture.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const SessionWindowRoot =
  params.get("mode") === "session"
    ? (await import("@/SessionWindowRoot.js")).SessionWindowRoot
    : () => null;
document.documentElement.classList.add(`theme-mikiko-${params.get("theme") ?? "light"}`);
(window as any).__uiSettingWrites = [];
(window as any).__uiPanelRequests = [];
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const push = (value: string) => setEvents((current) => [...current, value]);
  const mode = params.get("mode");
  if (mode === "session")
    return (
      <SessionWindowRoot
        services={services as unknown as IServiceAccessor}
        platform={platform as unknown as IPlatformService}
        workspacePath="/fixture/session-window"
        workspaceIdentity="fixture-session-window-identity"
        sessionId="fixture-session-window-session"
        isMacDesktop
      />
    );
  return (
    <main className="relative min-h-screen bg-background p-6 pt-24 text-foreground">
      {mode === "voice" ? (
        <VoiceInputSettingsSection isDesktop />
      ) : (
        <DesktopTopOverlay
          workspaceAbsPath="/fixture"
          isDesktop
          isMacDesktop={params.get("platform") === "mac"}
          isWindowsDesktop={params.get("platform") === "windows"}
          isSidebarVisible
          updateReadyVersion={null}
          updateState={null}
          toggleSidebarShortcutLabel=""
          newTaskShortcutLabel=""
          goBackShortcutLabel=""
          goForwardShortcutLabel=""
          canTaskNavBack
          canTaskNavForward
          canGoBack
          canGoForward
          platform={platform as unknown as IPlatformService}
          onToggleSidebar={() => push("toggle")}
          onGoBack={() => push("back")}
          onGoForward={() => push("forward")}
          onCreateTask={() => push("create")}
        />
      )}
      <output data-testid="fixture-events">{JSON.stringify(events)}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      <PlatformProvider platform={platform as unknown as IPlatformService}>
        <Fixture />
      </PlatformProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
