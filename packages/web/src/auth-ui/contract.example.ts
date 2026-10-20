import type { ComponentProps } from "react";
import { WebLoggedInWaitingPage } from "./contract.js";
export type LoggedInWaitingPresentation = ComponentProps<typeof WebLoggedInWaitingPage>;
/** 登录 owner 提供退出命令，页面不接触 credential repo。 */
export function waitingPresentation(
  props: LoggedInWaitingPresentation,
): LoggedInWaitingPresentation {
  return props;
}
