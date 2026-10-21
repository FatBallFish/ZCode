import { chmod, lstat, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

async function visitBundle(appPath, visit) {
  const root = resolve(appPath);
  const rootInfo = await lstat(root);
  if (
    extname(root).toLowerCase() !== ".app" ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink()
  )
    throw new Error("Expected a real .app directory for bundle permission checks.");
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const info = await lstat(path);
    // 仅处理新App的实际文件；不能沿Framework等符号链接改到依赖缓存或包外目录。
    if (info.isSymbolicLink()) continue;
    if (!info.isDirectory() && !info.isFile())
      throw new Error(`Unsupported Mac bundle entry: ${relative(root, path)}`);
    await visit(path, info, relative(root, path) || basename(root));
    if (info.isDirectory()) for (const name of await readdir(path)) pending.push(join(path, name));
  }
}

/** Normalize newly assembled bundles only, before their first signature. */
export async function normalizeMacBundleOwnerWrite(appPath) {
  await visitBundle(appPath, async (path, info) => {
    // SwiftPM LICENSE为0444，copyFile会保留；ShipIt移除quarantine因此EACCES。
    // 只补owner-write，不改变内容、执行位或group/world权限，也不修改只读来源。
    if (!(info.mode & 0o200)) await chmod(path, (info.mode & 0o7777) | 0o200);
  });
}

/** Signed/cache inputs are checked, never silently repaired. */
export async function assertMacBundleOwnerWrite(appPath) {
  await visitBundle(appPath, async (_path, info, name) => {
    if (!(info.mode & 0o200)) throw new Error(`Mac bundle entry is not owner-writable: ${name}`);
  });
}
