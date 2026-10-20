import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import { DesktopCommandIds, type IPlatformService } from "@zcode/shared";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "missing";
const calls = { capability: 0, status: 0, authorize: 0, restart: 0, initialize: 0, toggle: 0 };
(window as any).__cuaCalls = calls;
document.documentElement.classList.add(`theme-mikiko-${params.get("theme") ?? "light"}`);
const platform = {
  executeDesktopCommand: async (command: string) => {
    if (command !== DesktopCommandIds.GetCuaOsSupport)
      throw new Error("Unexpected desktop command");
    calls.capability++;
    return mode === "real"
      ? { kind: "supported" }
      : mode === "old-os"
        ? { kind: "macos-below-minimum", minimumMacOs: "12.0", currentMacOs: "11" }
        : { kind: "build-unavailable" };
  },
  openCuaPermissionOnboarding: async () => {
    calls.authorize++;
  },
};
const services = {
  pluginManagementService: {},
  cuaPermissionService: {
    getStatus: async () => {
      calls.status++;
      return {
        available: true,
        accessibility: "denied",
        screenRecording: "denied",
        grantOwner: "Mikiko Helper",
      };
    },
    restartHelper: async () => {
      calls.restart++;
      return { ok: true };
    },
  },
};
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      <ServiceProvider services={services as unknown as IServiceAccessor}>
        <PlatformProvider platform={platform as unknown as IPlatformService}>
          <main className="min-h-screen bg-background p-8 text-foreground">
            <ComputerUseSection isDesktop isMacDesktop workspacePath="/fixture/cua-build" />
          </main>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
