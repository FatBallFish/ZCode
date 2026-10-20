import {
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
} from "./contract.js";

/** 在实际构建开始前撤销旧发布凭证，全部平台构建完成后发布本轮描述文件。 */
export async function example(options: {
  distReleaseDir: string;
  versionReleaseDir: string;
  version: string;
  build: () => Promise<void>;
}): Promise<string[]> {
  await beginSourceServerRemoteReleaseGeneration(options);
  await options.build();
  return collectSourceServerRemoteReleaseArchives(options);
}
