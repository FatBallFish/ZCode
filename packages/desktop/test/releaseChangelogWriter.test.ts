import { describe, expect, it } from "vitest";
import { writeChangelog } from "conventional-changelog-writer";
import releaseConfig from "../../../.release-it.mjs";
import {
  createReleaseChangelogWriterOpts,
  extractCommitBodyBullets,
  isHiddenReleaseScope,
} from "../../../scripts/release-it/changelog-writer.mjs";

describe("release changelog writer", () => {
  it("只启用 release-it 的 conventional changelog 插件", () => {
    expect(Object.keys(releaseConfig.plugins)).toEqual(["@release-it/conventional-changelog"]);
  });

  it("extracts markdown bullet items from commit body", () => {
    expect(
      extractCommitBodyBullets(`- first change

- second change

plain paragraph

* third change`),
    ).toEqual(["first change", "second change", "third change"]);
  });

  it("carries commit body bullets into transformed changelog commits", () => {
    const writerOpts = createReleaseChangelogWriterOpts();
    const transformed = writerOpts.transform?.(
      {
        type: "fix",
        scope: "web-remote",
        subject: "harden mobile reconnect flow",
        body:
          "- add safe home-only services\n\n" +
          "- extend workspace reconnect timeout\n\n" +
          "- bump package version to 1.10.0",
        notes: [],
        references: [],
        hash: "38dd68bc37234cdecb2e11276b7f715a56bf3e06",
      },
      {
        host: "https://git.example.invalid",
        owner: "codegeex",
        repository: "z-code",
      },
    );

    expect(transformed).toMatchObject({
      type: "问题修复",
      scope: "web-remote",
      subject: "harden mobile reconnect flow",
      bodyBullets: [
        "add safe home-only services",
        "extend workspace reconnect timeout",
        "bump package version to 1.10.0",
      ],
    });
  });

  it("drops dev-facing scopes entirely from the changelog", () => {
    const writerOpts = createReleaseChangelogWriterOpts();
    const context = {
      host: "https://git.example.invalid",
      owner: "codegeex",
      repository: "z-code",
    };

    for (const scope of ["mikiko-cloud", "pre-push", "desktop/ci", "sync, ui"]) {
      expect(
        writerOpts.transform?.(
          {
            type: "fix",
            scope,
            subject: "internal only change",
            body: null,
            notes: [],
            references: [],
            hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
          context,
        ),
      ).toBeFalsy();
    }

    expect(isHiddenReleaseScope(undefined)).toBe(false);
    expect(isHiddenReleaseScope("desktop")).toBe(false);
    expect(isHiddenReleaseScope("mikiko-cloud")).toBe(true);
    expect(isHiddenReleaseScope("desktop/pre-push")).toBe(true);
  });

  it("renders body bullets on their own indented lines", async () => {
    const changelog = writeChangelog(
      {
        version: "1.10.0",
        host: "https://git.example.invalid",
        owner: "codegeex",
        repository: "z-code",
        commit: "commit",
        linkCompare: false,
        linkReferences: true,
      },
      createReleaseChangelogWriterOpts(),
    );
    const chunks: string[] = [];

    for await (const chunk of changelog([
      {
        type: "fix",
        scope: "web-remote",
        subject: "harden mobile reconnect flow",
        body:
          "- add safe home-only services\n\n" +
          "- extend workspace reconnect timeout\n\n" +
          "- bump package version to 1.10.0",
        notes: [],
        references: [],
        hash: "38dd68bc37234cdecb2e11276b7f715a56bf3e06",
      },
      {
        type: "fix",
        scope: "zzz",
        subject: "keep next commit on its own line",
        body: null,
        notes: [],
        references: [],
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ])) {
      chunks.push(String(chunk));
    }

    const output = chunks.join("");

    expect(output).toContain(
      "* **web-remote:** harden mobile reconnect flow " +
        "([38dd68b](https://git.example.invalid/codegeex/z-code/commit/38dd68bc37234cdecb2e11276b7f715a56bf3e06))\n" +
        "  * add safe home-only services\n" +
        "  * extend workspace reconnect timeout\n" +
        "  * bump package version to 1.10.0\n",
    );
    expect(output).toContain(
      "  * bump package version to 1.10.0\n" + "\n" + "* **zzz:** keep next commit on its own line",
    );
    expect(output).not.toMatch(/[^\n]\* \*\*/);
    expect(output).not.toMatch(/^[ \t]+\* \*\*/m);
  });
});
