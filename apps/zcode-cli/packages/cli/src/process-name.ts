export const CLI_COMMAND_NAME = "zcode";
// 2026-10-15 品牌化：进程名（ps 可见）改为 mikiko-cli；命令名 zcode 属安装产物命名空间（D8），暂不改。
export const CLI_PROCESS_NAME = "mikiko-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
