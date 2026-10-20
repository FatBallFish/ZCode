import { readFile, writeFile } from "node:fs/promises";
import {
  planProjectSeedRecovery,
  applyProjectSeedRecovery,
  type ProjectSeedRecoveryFiles,
  type ProjectSeedRecoveryPlan,
} from "../packages/services/src/project-storage/startup-entry.js";

// 输入与plan必须保存在本次0700恢复副本中；stdout只输出数量/指纹，不打印项目或源路径。
const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: recover-project-seed <private-input.json> [--apply]");
const input = JSON.parse(await readFile(inputPath, "utf8")) as {
  files: ProjectSeedRecoveryFiles;
  planPath: string;
  resultPath: string;
};
if (process.argv.includes("--apply")) {
  const plan = JSON.parse(await readFile(input.planPath, "utf8")) as ProjectSeedRecoveryPlan;
  const result = await applyProjectSeedRecovery(input.files, plan);
  await writeFile(input.resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, kind: "applied" }));
} else {
  const plan = await planProjectSeedRecovery(input.files);
  await writeFile(input.planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...plan, kind: "dry-run" }));
}
