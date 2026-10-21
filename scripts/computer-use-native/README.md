# Mikiko native preview build inputs

Run from the repository root:

```sh
mise exec -- node scripts/build-mikiko-computer-use.mjs
```

The builder fetches only upstream commit
`43eb4b53de7a15b3f99ec2c9922bedeb95602266`. An existing clean checkout of that
commit with the canonical upstream origin can be reused with
`--source-dir /path/to/open-computer-use`. This option never copies untracked
files. `--configuration debug|release`, `--arch arm64|x86_64` and `--jobs 1..32`
control the local build. Cross-compiled output is explicitly not runtime tested.

All generated source, Swift caches, logs and output stay in the ignored
`.cache/mikiko-computer-use/` directory. The default app is
`arm64/release/Mikiko Computer Use Dev.app` on an Apple Silicon host; its executable
is `Contents/MacOS/mikiko-computer-use`. `provenance.json` next to the app records
the source/dependency revisions, patch and notice hashes, compiler, source tree,
signed executable hash and non-interactive diagnostic results. This records
rebuild inputs; it does not promise identical binary bytes across toolchains or
machines. A modified generated source cache fails explicitly. Concurrent builders
are rejected; after an interrupted build, verify its PID before removing only its
generated `builder.lock` directory.

`mikiko-preview.patch` applies only to the pinned source. It coordinates the
Mikiko app identity, process-facing strings, environment prefix, configuration,
socket names and self-bundle discovery. The native preview compiles visual
cursor and global fallback off, rejects sky input/non-keep placement before
target lookup, and disables Locked Use management/private RPC. No upstream
reference images or documentation assets are exported into the build tree or
distributed. The cursor glyph renderer contains no image/resource/source fallback.

The bundle is ad-hoc signed using its development identifier,
`dev.mikiko.computer-use.development`. The builder only executes help, JSON
permission diagnostics and MCP discovery with the app-agent proxy disabled; it
does not open permission onboarding, invoke actions or install settings/services.
Diagnostic permission booleans are not proof of authorization of the
LaunchServices app-agent, nor proof that a native action works.

The gateway must use `MIKIKO_COMPUTER_USE_*` environment names. The default config
is `~/.mikiko/computer-use/config.json`; an absolute
`MIKIKO_COMPUTER_USE_CONFIG_FILE` overrides it. Use a unique
`MIKIKO_COMPUTER_USE_AGENT_SOCKET_NAMESPACE` for a preview connection. The socket
is `mikiko-computer-use-agent-<first-16-hex-of-SHA256(namespace)>.sock` in the native
caller's temporary directory. The proxy only discovers its own recognized app
bundle, rather than borrowing another installation or a source-directory bundle.

For an app-agent explicitly started by a test, send newline-delimited
`{"kind":"agentInfo"}` to its exact socket, verify `bundleURL` and
`buildIdentifier` against this app and provenance, then send
`{"kind":"terminate"}` to close that owned process. Closing an MCP client only
cleans its session; the upstream app-agent listener otherwise remains reusable.
Do not terminate agents by process name. Production control ownership and permission/upgrade lifecycle use the native
owner contract described below; the preview keeps its isolated socket namespace.

The app includes the upstream MIT license, MIT notices for Cua Driver/yabai, the
actual pinned libwebp license and Mikiko's modification notice. Preserve these
when packaging. This builder neither reads signing identities nor changes the
Keychain, TCC, authorization policy, user MCP configuration or global tools.

## Production packaging

Use `--production --arch arm64|x64` for the stable `dev.mikiko.computer-use`
identity. The result is under `production/<native-arch>/release/` with the
`Mikiko Computer Use.app` display name, preserving the development output.
The reviewed compiler for production is Swift 6.2.x; x64 is compiled as x86_64.
Use `--sign-identity <Developer ID identity>` or
`MIKIKO_COMPUTER_USE_SIGN_IDENTITY` to sign with hardened runtime and secure
Apple timestamp before first activation. The builder never launches a production
App-agent, so an ad-hoc staging build cannot create an ambiguous TCC entry.
`--compile-only` checks native compilation without replacing an App;
`--candidate <slug>` produces an isolated acceptance candidate under
`production/candidates/<slug>/<arch>/release/`. Neither touches the frozen baseline.

Electron's bundle chain stages the App and a standalone SDK2
`production-server.mjs` from `packages/computer-use-open` into
`bundled-tools/darwin-<arch>/mikiko-computer-use` and packages it at
`Resources/computer-use`. Both architectures fail closed on source/identity/hash,
architecture, dependency closure and Developer ID signature mismatches. The
nested App is signed before the parent App is sealed and follows the existing
parent notarization archive/recovery workflow. macOS release CI selects Xcode
26.0 / Swift 6.2, and refuses missing Developer ID credentials.

Production ignores socket-namespace and proxy-disable overrides; a fixed per-uid
socket plus kernel-held listener lock gives one native lease owner across Hosts.
Observation/actions acquire a connection UUID lease; doctor/list/discovery do not.
Only that owner can release, and disconnect waits for synchronous native work to
finish before cleanup and handoff. `restart-agent --json` verifies peer uid and
running code signature against the same production bundle/team; active control
returns busy. A trusted idle stale helper may be replaced during app upgrades.

After final signing, run `doctor --json` from the exact App executable; verify
`appAgent:true`, `grantOwnerBundleId`, `appPath` and `buildIdentifier`. Use
`test-production-agent.mjs <exact App>` for the read-only/lease protocol suite and
`test-packaged-gateway.mjs <standalone server> <native binary>` for SDK2 discovery
from a temporary directory with no node_modules. These do not validate actual
AX/capture/input; release acceptance must separately run the controlled Cocoa fixture.
