import {
  resolveMikikoComputerUseResources,
  areMikikoComputerUseResourcesAvailable,
  mikikoComputerUseResourceEnv,
} from "./contract.js";
export async function packagedComputerUseEnvironment(resourcesPath: string, workspaceRoot: string) {
  const resources = resolveMikikoComputerUseResources({
    resourcesPath,
    workspaceRoot,
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
  });
  return mikikoComputerUseResourceEnv(
    (await areMikikoComputerUseResourcesAvailable(resources)) ? resources : undefined,
  );
}
