# Cross-Platform Icon Assets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Mikiko icon assets with real transparency, no baked outer shadow, and platform-appropriate visual sizing on macOS, Windows, Linux, and Web.

**Architecture:** A single deterministic Node build script owns source extraction, platform masters, size ladders, ICNS/ICO assembly, and repository target synchronization. Asset tests inspect PNG pixels and ICO entries, while desktop runtime selects the explicit macOS PNG instead of probing for an undeployed sibling file.

**Tech Stack:** Node.js ESM, `node:test`, `pngjs`, macOS `qlmanage`/`sips`/`iconutil`, Electron/electron-builder.

---

### Task 1: Add failing asset-contract tests

**Files:**

- Create: `brand/mikiko/tools/icon-assets.test.mjs`
- Reference: `specs/brand/icon-assets.md`

**Step 1:** Test that portable and macOS masters have transparent corners, expected alpha bounds, and no opaque pixels outside the rounded subject.

**Step 2:** Parse every embedded PNG in `icon.ico` and `favicon.ico`; require RGBA alpha at the corners and the expected frame sizes.

**Step 3:** Test that brand outputs match their desktop, Web, and public synchronized targets, including the Web inline favicon.

**Step 4:** Run `node --test brand/mikiko/tools/icon-assets.test.mjs` and confirm it fails on the current baked checkerboard / missing macOS master / opaque favicon state.

### Task 2: Rebuild the deterministic asset pipeline

**Files:**

- Modify: `brand/mikiko/tools/build-new-icon.mjs`
- Modify: `brand/mikiko/README.md`

**Step 1:** Add explicit source crop geometry and render two transparent masters: 824px macOS subject and 896px portable subject.

**Step 2:** Generate the portable PNG ladder, macOS ICNS, Windows ICO, alpha-preserving favicon ICO, installer assets, and Linux hicolor assets.

**Step 3:** Synchronize all generated files to `packages/desktop/build`, `packages/web/public`, `public/logo/icons`, and `public/icon_512@2x.png` in the same run.

**Step 4:** Update `packages/web/index.html` from the generated favicon bytes instead of maintaining an independent base64 value.

**Step 5:** Run the asset build and inspect the 1024, 32, and 16px results on transparent, light, and dark backgrounds.

**Step 6:** Run the asset test again and confirm it passes.

### Task 3: Make macOS runtime loading explicit

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/desktopWindowChrome.ts`
- Modify: `packages/desktop/electron-builder.config.js`

**Step 1:** Add a failing focused test if an existing desktop main test seam can validate icon path selection; otherwise rely on the asset/build configuration contract test because this is packaging configuration.

**Step 2:** Resolve Darwin runtime icon paths to `icon_macos.png`, keep Windows on `icon_windows.png`, and keep Linux on the portable PNG.

**Step 3:** Package `icon_macos.png` only for Darwin and remove the ineffective sibling `dock-icon.png` probe.

**Step 4:** Run the focused asset/config test and desktop typecheck.

### Task 4: Cross-platform verification

**Files:**

- Verify all files named in Tasks 1-3.

**Step 1:** Run `node --test brand/mikiko/tools/icon-assets.test.mjs`.

**Step 2:** Run `pnpm typecheck`.

**Step 3:** Run `pnpm lint`.

**Step 4:** Run `pnpm fmt:check`.

**Step 5:** Run `pnpm architecture:check --changed` and separate new violations from baseline output.

**Step 6:** Report exact platform assets, verification results, and any environment-limited packaging checks.
