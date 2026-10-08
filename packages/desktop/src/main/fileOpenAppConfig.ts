/**
 * 文件打开方式格式规则表 —— 纯配置模块（无 IO / 无 electron 依赖，可单测）。
 *
 * 规则按声明顺序匹配，同一扩展命中多条规则时按序合并应用 id 并去重；
 * appIds 可引用 editors.ts 的编辑器 id（如 vscode、goland）与本文件的格式应用 id，
 * id 解析不到 def 时由调用方（fileOpenApps.ts）静默跳过，规则表允许先于安装环境演进。
 */

export interface FileOpenAppDef {
  id: string;
  name: string;
  /** macOS .app bundle 主路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名；null 走 `open -a`（mac）/ 直接执行 appPath（win） */
  command: string | null;
}

export interface FileOpenFormatRule {
  id: string;
  extensions: string[];
  appIds: string[];
}

/** 与 editors.ts 平台编辑器 id 保持一致（纯配置侧副本，测试用于交叉校验规则表） */
export const EDITOR_APP_IDS: readonly string[] = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "trae",
  "zed",
  "sublime",
  "codebuddy",
  "qoder",
  "idea",
  "idea-ce",
  "webstorm",
  "pycharm",
  "goland",
  "phpstorm",
  "rider",
  "clion",
  "rubymine",
  "datagrip",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "finder",
  "qspace",
  "qspace-pro",
  "explorer",
];

function macApp(
  id: string,
  name: string,
  appPath: string,
  extraCandidates: string[] = [],
): FileOpenAppDef {
  return {
    id,
    name,
    appPath,
    appPathCandidates: extraCandidates.length > 0 ? extraCandidates : undefined,
    command: null,
  };
}

/** Adobe 年份化安装目录候选（2025+ 统一命名在前，年份目录兜底） */
function adobeMacCandidates(appDirName: string): string[] {
  const years = [2026, 2025, 2024, 2023, 2022, 2021];
  return [
    `/Applications/${appDirName}/${appDirName}.app`,
    ...years.map((year) => `/Applications/${appDirName} ${year}/${appDirName} ${year}.app`),
  ];
}

function adobeMacApp(id: string, name: string, appDirName: string): FileOpenAppDef {
  return {
    id,
    name,
    appPath: `/Applications/${appDirName}/${appDirName}.app`,
    appPathCandidates: adobeMacCandidates(appDirName).slice(1),
    command: null,
  };
}

function windowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ];
  return Array.from(
    new Set(roots.filter((root): root is string => typeof root === "string" && root.length > 0)),
  );
}

function windowsOfficeCandidates(exeName: string): string[] {
  return windowsProgramFilesRoots().flatMap((root) => [
    `${root}\\Microsoft Office\\root\\Office16\\${exeName}`,
    `${root}\\Microsoft Office\\root\\Office15\\${exeName}`,
  ]);
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  const systemDrive = process.env.SystemDrive || "C:";
  const localAppData = process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`;
  return [localAppData, ...segments].join("\\");
}

function windowsProgramFilesCandidate(...segments: string[]): string[] {
  return windowsProgramFilesRoots().map((root) => [root, ...segments].join("\\"));
}

/** 格式感知的非编辑器应用（文档/媒体/Adobe/IDE）；通用编辑器沿用 editors.ts 的 id */
export const FILE_OPEN_APP_DEFS: readonly FileOpenAppDef[] = [
  // 文档
  macApp("wps", "WPS Office", "/Applications/wpsoffice.app", [
    windowsLocalProgramCandidate("Kingsoft", "WPS Office", "office6", "wpsoffice.exe"),
    ...windowsProgramFilesCandidate("Kingsoft", "WPS Office", "office6", "wpsoffice.exe"),
  ]),
  macApp(
    "word",
    "Microsoft Word",
    "/Applications/Microsoft Word.app",
    windowsOfficeCandidates("WINWORD.EXE"),
  ),
  macApp(
    "excel",
    "Microsoft Excel",
    "/Applications/Microsoft Excel.app",
    windowsOfficeCandidates("EXCEL.EXE"),
  ),
  macApp(
    "powerpoint",
    "Microsoft PowerPoint",
    "/Applications/Microsoft PowerPoint.app",
    windowsOfficeCandidates("POWERPNT.EXE"),
  ),
  macApp("pages", "Pages", "/Applications/Pages.app"),
  macApp("numbers", "Numbers", "/Applications/Numbers.app"),
  macApp("keynote", "Keynote", "/Applications/Keynote.app"),
  adobeMacApp("adobe-acrobat", "Adobe Acrobat", "Adobe Acrobat"),
  // 媒体
  macApp("vlc", "VLC", "/Applications/VLC.app", [
    ...windowsProgramFilesCandidate("VideoLAN", "VLC", "vlc.exe"),
  ]),
  macApp("iina", "IINA", "/Applications/IINA.app"),
  macApp("quicktime-player", "QuickTime Player", "/System/Applications/QuickTime Player.app"),
  macApp("music", "Music", "/System/Applications/Music.app"),
  {
    id: "windows-media-player",
    name: "Windows Media Player",
    appPath: "C:\\Program Files\\Windows Media Player\\wmplayer.exe",
    command: null,
  },
  // Adobe 设计系（年份目录由 candidates 覆盖；Windows 仅 Photoshop/Acrobat 参与扫描）
  adobeMacApp("adobe-photoshop", "Adobe Photoshop", "Adobe Photoshop"),
  adobeMacApp("adobe-illustrator", "Adobe Illustrator", "Adobe Illustrator"),
  adobeMacApp("adobe-indesign", "Adobe InDesign", "Adobe InDesign"),
  adobeMacApp("adobe-premiere-pro", "Adobe Premiere Pro", "Adobe Premiere Pro"),
  adobeMacApp("adobe-after-effects", "Adobe After Effects", "Adobe After Effects"),
  macApp("sketch", "Sketch", "/Applications/Sketch.app"),
  macApp("figma", "Figma", "/Applications/Figma.app"),
  // 编程/工程（不进通用编辑器白名单的专用 IDE）
  macApp("xcode", "Xcode", "/Applications/Xcode.app"),
  macApp("rustrover", "RustRover", "/Applications/RustRover.app"),
];

/** 通用编程类扩展集合：命中后追加通用编辑器列表（在语言专属规则之后） */
const CODE_EXTENSIONS: readonly string[] = [
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "conf",
  "config",
  "properties",
  "env",
  "md",
  "markdown",
  "mdx",
  "txt",
  "log",
  "csv",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "make",
  "mk",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "hh",
  "cs",
  "fs",
  "php",
  "sql",
  "swift",
  "m",
  "mm",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "graphql",
  "gql",
  "proto",
  "pl",
  "lua",
  "dart",
  "kt",
  "kts",
  "scala",
  "ex",
  "exs",
  "erl",
  "hs",
  "jl",
  "nim",
  "zig",
  "r",
  "cmake",
  "gradle",
  "lock",
];

export const FILE_OPEN_FORMAT_RULES: readonly FileOpenFormatRule[] = [
  // —— 文档 —— //
  {
    id: "word-document",
    extensions: ["doc", "docx", "docm", "dotx", "rtf", "odt"],
    appIds: ["wps", "word", "pages"],
  },
  {
    id: "spreadsheet",
    extensions: ["xls", "xlsx", "xlsm", "xlsb", "ods", "ets"],
    appIds: ["wps", "excel", "numbers"],
  },
  {
    id: "presentation",
    extensions: ["ppt", "pptx", "pptm", "potx"],
    appIds: ["wps", "powerpoint", "keynote"],
  },
  { id: "pdf", extensions: ["pdf"], appIds: ["wps", "adobe-acrobat"] },
  // —— 音频 / 视频 —— //
  {
    id: "audio",
    extensions: [
      "mp3",
      "wav",
      "m4a",
      "m4b",
      "aac",
      "ogg",
      "oga",
      "opus",
      "flac",
      "weba",
      "aiff",
      "aif",
      "wma",
    ],
    appIds: ["vlc", "iina", "music", "quicktime-player", "windows-media-player"],
  },
  {
    id: "video",
    // 注意不含 "ts"：编程语境下 .ts 几乎总是 TypeScript，视频 transport stream 由 mts/m2ts 覆盖
    extensions: [
      "mp4",
      "mov",
      "webm",
      "m4v",
      "mkv",
      "avi",
      "wmv",
      "flv",
      "mpg",
      "mpeg",
      "mts",
      "m2ts",
    ],
    appIds: ["vlc", "iina", "quicktime-player", "windows-media-player"],
  },
  // —— Adobe / 设计 —— //
  { id: "photoshop", extensions: ["psd", "psb"], appIds: ["adobe-photoshop"] },
  { id: "illustrator", extensions: ["ai", "eps"], appIds: ["adobe-illustrator"] },
  { id: "indesign", extensions: ["indd", "indt", "idml"], appIds: ["adobe-indesign"] },
  { id: "premiere", extensions: ["prproj"], appIds: ["adobe-premiere-pro"] },
  {
    id: "after-effects",
    extensions: ["aep", "aepx", "aegraphic"],
    appIds: ["adobe-after-effects"],
  },
  { id: "sketch", extensions: ["sketch"], appIds: ["sketch"] },
  { id: "figma", extensions: ["fig"], appIds: ["figma"] },
  // —— 编程语言（专用 IDE 在前，通用编辑器由 code 规则追加） —— //
  {
    id: "xcode-project",
    extensions: ["xcodeproj", "xcworkspace", "playground"],
    appIds: ["xcode"],
  },
  { id: "golang", extensions: ["go"], appIds: ["goland"] },
  { id: "python", extensions: ["py", "pyi", "pyw", "ipynb"], appIds: ["pycharm"] },
  {
    id: "web-lang",
    extensions: [
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "html",
      "htm",
      "css",
      "scss",
      "sass",
      "less",
      "vue",
      "svelte",
      "astro",
    ],
    appIds: ["webstorm"],
  },
  { id: "java-lang", extensions: ["java"], appIds: ["idea", "idea-ce"] },
  { id: "clang", extensions: ["c", "cc", "cpp", "cxx", "h", "hpp", "hh"], appIds: ["clion"] },
  { id: "dotnet", extensions: ["cs", "csproj", "sln", "fs"], appIds: ["rider"] },
  { id: "ruby", extensions: ["rb"], appIds: ["rubymine"] },
  { id: "php", extensions: ["php"], appIds: ["phpstorm"] },
  { id: "sql-lang", extensions: ["sql"], appIds: ["datagrip"] },
  { id: "rust", extensions: ["rs"], appIds: ["rustrover"] },
  { id: "swift-lang", extensions: ["swift", "m", "mm"], appIds: ["xcode"] },
  {
    id: "code",
    extensions: [...CODE_EXTENSIONS],
    appIds: ["vscode", "vscode-insiders", "cursor", "zed", "sublime", "trae", "codebuddy", "qoder"],
  },
];

/** 按扩展名解析有序应用 id 列表（多规则命中时按规则声明顺序合并去重；未知扩展返回空） */
export function resolveFileOpenAppIdsForExtension(extension: string): string[] {
  const normalized = extension.trim().toLowerCase().replace(/^\.+/, "");
  if (!normalized || normalized.includes("/")) {
    return [];
  }

  const appIds: string[] = [];
  for (const rule of FILE_OPEN_FORMAT_RULES) {
    if (!rule.extensions.includes(normalized)) {
      continue;
    }
    for (const appId of rule.appIds) {
      if (!appIds.includes(appId)) {
        appIds.push(appId);
      }
    }
  }
  return appIds;
}
