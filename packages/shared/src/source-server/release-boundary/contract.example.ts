import {
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
  type SourceServerReleaseDescriptor,
} from "./contract.js";

/** 示例只构造并校验元数据，不发布、下载或断言归档字节完整性。 */
export function exampleSourceServerRelease(version: string): SourceServerReleaseDescriptor {
  return sourceServerReleaseDescriptorSchema.parse({
    schemaVersion: 1,
    version,
    archives: SOURCE_SERVER_RELEASE_TARGETS.map((target) => ({
      target,
      version,
      fileName: `mikiko-server-${target}.tar.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 1,
      urls: [`releases/${version}/mikiko-server-${target}.tar.gz`],
    })),
  });
}
