import { describe, expect, it } from "vitest";
import {
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseArchiveSchema,
  sourceServerReleaseDescriptorSchema,
} from "./contract.js";
import { exampleSourceServerRelease } from "./contract.example.js";

describe("Mikiko Source Server release public contract", () => {
  it("accepts the example four-platform descriptor with consistent release identity", () => {
    const descriptor = exampleSourceServerRelease("1.1.3");
    expect(descriptor.archives.map((archive) => archive.target)).toEqual(
      SOURCE_SERVER_RELEASE_TARGETS,
    );
    expect(sourceServerReleaseDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it("rejects mixed versions and duplicate targets in a release", () => {
    const descriptor = exampleSourceServerRelease("1.1.3");
    const archive = descriptor.archives[0]!;
    expect(
      sourceServerReleaseDescriptorSchema.safeParse({
        ...descriptor,
        archives: [archive, archive],
      }).success,
    ).toBe(false);
    expect(
      sourceServerReleaseDescriptorSchema.safeParse({
        ...descriptor,
        archives: [{ ...archive, version: "1.1.2" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    "../archive.tar.gz",
    "/tmp/archive.tar.gz",
    "dir\\archive.tar.gz",
    "dir/./archive.tar.gz",
  ])("rejects an unsafe archive address %s", (url) => {
    const archive = exampleSourceServerRelease("1.1.3").archives[0]!;
    expect(sourceServerReleaseArchiveSchema.safeParse({ ...archive, urls: [url] }).success).toBe(
      false,
    );
  });

  it("rejects the old product filename and malformed integrity metadata", () => {
    const archive = exampleSourceServerRelease("1.1.3").archives[0]!;
    for (const patch of [
      { fileName: "zcode-server-linux-x64.tar.gz" },
      { sha256: "not-a-sha256" },
      { sizeBytes: 0 },
      { unexpected: true },
    ])
      expect(sourceServerReleaseArchiveSchema.safeParse({ ...archive, ...patch }).success).toBe(
        false,
      );
  });
});
