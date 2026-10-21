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
Do not terminate agents by process name. Production control ownership and
permission/upgrade lifecycle still require the Host design described in the spec.

The app includes the upstream MIT license, MIT notices for Cua Driver/yabai, the
actual pinned libwebp license and Mikiko's modification notice. Preserve these
when packaging. This builder neither reads signing identities nor changes the
Keychain, TCC, authorization policy, user MCP configuration or global tools.
