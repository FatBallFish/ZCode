import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Locale } from "@zcode/shared";

type MenuFlavor = "production" | "preview" | "development";
// 三形态（正式/Preview/开发）并排安装时必须各写各的注册表键，否则后装的构建会覆盖
// 先装构建的右键菜单。production 沿用历史键名 ZCode.OpenInZCode：改名会在已装用户
// 机器上遗留孤儿菜单项且本模块从不删键；preview/dev 用 Mikiko 品牌新键。
const MENU_IDENTITIES: Record<MenuFlavor, { key: string; name: string }> = {
  production: { key: "ZCode.OpenInZCode", name: "Mikiko" },
  preview: { key: "Mikiko.Preview.OpenInMikiko", name: "Mikiko Preview" },
  development: { key: "Mikiko.Dev.OpenInMikiko", name: "Mikiko Dev" },
};
function menuFlavor(options: {
  flavor: "production" | "preview";
  isPackaged: boolean;
}): MenuFlavor {
  return options.isPackaged ? options.flavor : "development";
}

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

function getWindowsOpenFolderMenuName(locale: Locale, name: string): string {
  return locale === "zh-CN" ? `在 ${name} 中打开` : `Open in ${name}`;
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

export function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
  flavor: "production" | "preview";
  isPackaged: boolean;
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const identity = MENU_IDENTITIES[menuFlavor(options)];
  const menuName = getWindowsOpenFolderMenuName(options.locale, identity.name);
  const menuKeys = ["Directory", "Drive"].map(
    (kind) => `HKCU\\Software\\Classes\\${kind}\\shell\\${identity.key}`,
  );

  return menuKeys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  flavor: "production" | "preview";
  isPackaged: boolean;
  /** 测试注入假 runner；缺省真实调用 reg.exe。 */
  runRegistry?: (args: readonly string[]) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
    flavor: options.flavor,
    isPackaged: options.isPackaged,
  });

  try {
    for (const operation of operations) await (options.runRegistry ?? runRegAdd)(operation.args);

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
