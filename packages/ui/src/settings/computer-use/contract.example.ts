import { createElement, type ComponentProps } from "react";
import { MikikoComputerUseSection } from "./contract.js";
export function nativeSettingsSurface(props: ComponentProps<typeof MikikoComputerUseSection>) {
  return createElement(MikikoComputerUseSection, props);
}
