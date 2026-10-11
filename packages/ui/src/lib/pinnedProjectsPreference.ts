interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PINNED_PROJECTS_STORAGE_KEY = "zcode-pinned-projects";
// 防御上限：置顶键只来自本项目 tab，正常远低于该值；异常膨胀时截断保护 localStorage。
const MAX_PINNED_PROJECT_KEYS = 200;

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizePinnedProjectKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const key = item.trim();
    if (!key) {
      continue;
    }
    seen.add(key);
    if (seen.size >= MAX_PINNED_PROJECT_KEYS) {
      break;
    }
  }
  return [...seen];
}

/** 置顶项目键（buildTaskWorkspaceKey）集合；本设备 UI 偏好，见 specs/desktop/sidebar-projects.md。 */
export function readPinnedProjectKeys(
  storage: StorageLike | null = getBrowserStorage(),
): Set<string> {
  const rawValue = storage?.getItem(PINNED_PROJECTS_STORAGE_KEY);
  if (!rawValue) {
    return new Set();
  }

  try {
    return new Set(normalizePinnedProjectKeys(JSON.parse(rawValue)));
  } catch {
    return new Set();
  }
}

export function persistPinnedProjectKeys(
  keys: ReadonlySet<string>,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  storage?.setItem(
    PINNED_PROJECTS_STORAGE_KEY,
    JSON.stringify(normalizePinnedProjectKeys([...keys])),
  );
}
