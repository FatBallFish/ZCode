import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 读取插件根目录 .mikiko-plugin/plugin.json 的 name，兼容旧 manifest 目录。
 *
 * 原因：插件名决定 MCP 服务身份与 ui://<name>/ 资源地址。内置插件包目录名带 -plugin 后缀
 * （如 pdf-plugin），不能再从目录名推导，否则面板资源地址与 manifest 声明的 resourceUri 不一致。
 */
export async function readPluginName(pluginRoot) {
  for (const directory of [".mikiko-plugin", ".zcode-plugin", ".claude-plugin", ".codex-plugin"]) {
    const manifestPath = join(pluginRoot, directory, "plugin.json");
    let contents;
    try {
      contents = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const manifest = JSON.parse(contents);
    if (typeof manifest.name !== "string" || manifest.name.length === 0)
      throw new Error(`${manifestPath}: 缺少插件 name`);
    return manifest.name;
  }
  throw new Error(`${pluginRoot}: 缺少插件 manifest`);
}
