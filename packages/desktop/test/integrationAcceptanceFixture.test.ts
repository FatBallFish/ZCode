import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedIntegrationAcceptanceFixture } from "#e2e/helpers/integration-acceptance-fixture";

it("只在隔离integration profile中写远控停用配置，不改变普通套件或其他profile", async () => {
  const root = await mkdtemp(join(tmpdir(), ".e2e-home-integration-seeder-"));
  const config = join(root, ".mikiko", "remote-control.json");
  const accepted = "conversation-session-integration-skin-remote-entry.test.ts";
  try {
    await seedIntegrationAcceptanceFixture({
      homeDir: root,
      specs: ["conversation-session-v4-send.test.ts"],
    });
    await expect(access(config)).rejects.toThrow();
    const untrusted = join(root, "ordinary-profile");
    await expect(
      seedIntegrationAcceptanceFixture({ homeDir: untrusted, specs: [accepted] }),
    ).rejects.toThrow("refuses a shared/personal profile");
    await expect(access(join(untrusted, ".mikiko", "remote-control.json"))).rejects.toThrow();
    await seedIntegrationAcceptanceFixture({ homeDir: root, specs: [accepted] });
    const data = JSON.parse(await readFile(config, "utf8"));
    expect(data.enabled).toBe(false);
    expect(new URL(data.relayWsUrl).hostname).toBe("127.0.0.1");
    expect(new URL(data.relayHttpUrl).hostname).toBe("127.0.0.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
