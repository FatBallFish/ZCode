import { useCallback, useEffect, useRef, useState } from "react";
import { DesktopCommandIds, type CuaPermissionKind } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function useMikikoComputerUseActions(options: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  refresh(): void;
}) {
  const platform = usePlatform();
  const services = useServices();
  const { intl } = useZCodeIntl();
  const [restarting, setRestarting] = useState(false);
  const restartPromise = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const contextKey = options.workspaceIdentity?.trim() || options.workspacePath || "";
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openSettings = useCallback(
    async (kind: CuaPermissionKind) => {
      try {
        const result = (await platform.executeDesktopCommand?.(
          kind === "accessibility"
            ? DesktopCommandIds.OpenMikikoComputerUseAccessibilitySettings
            : DesktopCommandIds.OpenMikikoComputerUseScreenRecordingSettings,
        )) as { success?: boolean; error?: string } | undefined;
        if (!result?.success)
          throw new Error(
            result?.error ?? intl.formatMessage({ id: "cuaPermission.modal.unavailable" }),
          );
      } catch (error) {
        if (mounted.current) toast(error instanceof Error ? error.message : String(error));
      }
    },
    [platform, intl],
  );
  const restart = useCallback((): Promise<void> => {
    if (restartPromise.current) return restartPromise.current;
    const path = options.workspacePath;
    const service = services.cuaPermissionService;
    if (!path || !service) return Promise.resolve();
    setRestarting(true);
    // 先登记single-flight再进入service，防止同步抛错在赋值前finally清空后又被已完成Promise覆盖。
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await service.restartHelper(path, options.workspaceIdentity);
        if (!result.ok && mounted.current && currentContext.current === contextKey)
          toast(result.reason ?? intl.formatMessage({ id: "cuaPermission.modal.unavailable" }));
      } catch (error) {
        if (mounted.current && currentContext.current === contextKey)
          toast(error instanceof Error ? error.message : String(error));
      } finally {
        restartPromise.current = null;
        if (mounted.current) setRestarting(false);
        if (mounted.current && currentContext.current === contextKey) options.refresh();
      }
    });
    restartPromise.current = operation;
    return operation;
  }, [
    options.workspacePath,
    options.workspaceIdentity,
    options.refresh,
    services.cuaPermissionService,
    contextKey,
    intl,
  ]);
  return { restarting, openSettings, restart };
}
