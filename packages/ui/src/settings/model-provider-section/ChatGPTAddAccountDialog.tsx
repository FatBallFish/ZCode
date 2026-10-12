import { useCallback, useEffect, useState } from "react";
import { AlertTriangleIcon, FileUpIcon, GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { ChatGPTAuthorizationResult, ChatGPTImportResult } from "@zcode/services";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

type AddStep = "risk" | "choose" | "authorizing" | "importing";

/**
 * 添加 ChatGPT 账号对话框（需求 2 + 补充 5）：先展示风险提醒（继续即视为接受），
 * 再选择「浏览器授权」（host 起 1455 回调监听 + 打开系统浏览器）或
 * 「导入 sub2api 导出文件」（忽略 proxies/extra，仅取 ChatGPT OAuth 凭证后接口补全）。
 */
export function ChatGPTAddAccountDialog({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const service = services.chatgptAccountService;
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [step, setStep] = useState<AddStep>("risk");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!service) return;
    const disposeCompleted = service.onAuthorizationCompleted(
      (result: ChatGPTAuthorizationResult) => {
        toast(
          intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.add.completed" },
            { email: result.email },
          ),
        );
        onClose();
      },
    );
    const disposeFailed = service.onAuthorizationFailed((event: { message: string }) => {
      toast(event.message, { variant: "warning" });
      setStep("choose");
    });
    return () => {
      disposeCompleted.dispose();
      disposeFailed.dispose();
    };
  }, [intl, onClose, service]);

  const requireService = useCallback(() => {
    if (!service) {
      toast(intl.formatMessage({ id: "settings.modelProvider.chatgpt.add.failed" }), {
        variant: "warning",
      });
      return null;
    }
    return service;
  }, [intl, service]);

  const startBrowserAuthorization = useCallback(async () => {
    const target = requireService();
    if (!target) return;
    setBusy(true);
    try {
      const session = await target.startAuthorization();
      platform.openExternal(session.authUrl);
      setStep("authorizing");
    } catch (error) {
      toast(error instanceof Error ? error.message : "", { variant: "warning" });
    } finally {
      setBusy(false);
    }
  }, [platform, requireService]);

  const importSub2ApiFile = useCallback(async () => {
    const target = requireService();
    if (!target) return;
    const filePath = await platform.selectFile();
    if (!filePath) return;
    setBusy(true);
    setStep("importing");
    try {
      const result: ChatGPTImportResult = await target.importSub2ApiAccounts(filePath);
      const imported = result.imported.length;
      toast(
        intl.formatMessage(
          { id: "settings.modelProvider.chatgpt.add.importResult" },
          { imported, skipped: result.skipped.length },
        ),
        imported > 0 ? undefined : { variant: "warning" },
      );
      for (const entry of result.imported) {
        if (entry.enrichError) {
          logger.warn("chatgpt import enrich failed", {
            accountId: entry.accountId,
            error: entry.enrichError,
          });
        }
      }
      if (imported > 0) {
        onClose();
        return;
      }
      setStep("choose");
    } catch (error) {
      toast(error instanceof Error ? error.message : "", { variant: "warning" });
      setStep("choose");
    } finally {
      setBusy(false);
    }
  }, [intl, onClose, platform, requireService]);

  const t = (id: string) => intl.formatMessage({ id: `settings.modelProvider.chatgpt.add.${id}` });

  const cancelAuthorization = useCallback(async () => {
    try {
      await service?.cancelAuthorization();
    } catch {
      /* 取消失败不阻塞 UI 复位 */
    }
    onClose();
  }, [onClose, service]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : void cancelAuthorization())}>
      {/* 默认 DialogContent 跟随 App 宽度，风险提示/添加方式是短文案弹窗，按项目提示型弹窗惯例限宽。 */}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          {step === "risk" ? <DialogDescription>{t("subtitle")}</DialogDescription> : null}
        </DialogHeader>

        {step === "risk" ? (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
              <AlertTriangleIcon className="size-5 shrink-0 text-warning" aria-hidden="true" />
              <div className="text-ui-sm leading-relaxed">{t("riskNotice")}</div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button onClick={() => setStep("choose")} data-testid="chatgpt-add-accept-risk">
                {t("acceptRisk")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full justify-start gap-3"
              disabled={busy}
              onClick={() => void startBrowserAuthorization()}
              data-testid="chatgpt-add-browser"
            >
              <GlobeIcon className="size-4" aria-hidden="true" />
              <span className="flex-1 text-left">{t("browserAuth")}</span>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-3"
              disabled={busy}
              onClick={() => void importSub2ApiFile()}
              data-testid="chatgpt-add-import"
            >
              <FileUpIcon className="size-4" aria-hidden="true" />
              <span className="flex-1 text-left">{t("importSub2Api")}</span>
            </Button>
            {step === "authorizing" || step === "importing" ? (
              <div className="text-ui-sm text-foreground-subtle">
                {step === "authorizing" ? t("authorizingHint") : t("importingHint")}
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => void cancelAuthorization()}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
