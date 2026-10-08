# Browser Use

The official built-in ZCode plugin for browser automation. It ships the browser-client bootstrap module, skills, and documentation/capability manifests; the `node_repl` MCP host that exposes the `js` tool lives in `@zcode/node-repl-host`.

## What it provides

- `js` tool — served by the shared `node_repl` MCP host and seen by the model as `mcp__node_repl__js`. The host is shared with Computer Use, so its model-facing text is scoped to both official capabilities. Every `js` call starts in a fresh kernel; imports are limited to `node:*` builtins and absolute `file://` URLs under the skill root.
- `scripts/browser-client.mjs` — explicitly bootstraps `agent.browsers` inside each fresh `js` kernel; BrowserControl tabs, not JavaScript globals, provide continuity.
- `control-browser` skill — tells the agent how to bootstrap and drive an advertised ZCode browser backend (Desktop IAB or CLI-managed headless CDP), select a browser and read `browser.documentation()` once, use the Playwright DOM snapshot→locator→act workflow, observe controlled and user tab registries together after a possible popup action, and request screenshots only for visual evidence.
- `web-gui-tester` skill — layers a pure-GUI black-box testing workflow on top of `control-browser`, requiring Browser Use semantic evidence plus inspected screenshots while respecting current console, upload, and runtime capability boundaries.

The IAB runtime is provided by the desktop host; the managed headless CDP runtime is provided only by an explicitly opted-in CLI process. The plugin assets define the model guidance and the effective runtime object graph; unsupported members are removed by the manifest interpreter instead of failing after invocation.

## External CDP specification

External CDP is opt-in: CLI uses `--browser-use=external --browser-endpoint=http://127.0.0.1:9333` (optional `--browser-name` and `--browser-identity`). Desktop Host reads the Mikiko fork's resolved configuration: settings page (`externalCdpConfig`) takes precedence, then the explicit `MIKIKO_EXTERNAL_CDP` JSON environment variable, then the built-in default instance `default` on `http://127.0.0.1:9333` (zero-config attach). Configuration changes hot-apply without restart via the settings page, for example `{"endpoint":"http://127.0.0.1:9333","name":"Local Chromium","expectedBrowserId":"browser-uuid"}`. No configuration means no network access and unchanged IAB/managed behavior. CLI flags have no environment fallback. Desktop configuration is parsed once at Host assembly, never from page contents or project files. Invalid configuration fails before attach.

The adapter is the sole owner of the connection, generation, cancellation records and session page registry:

```text
explicit configuration -> Host registry -> BrowserControlPort -> external adapter
official SDK discovery/execute -------------------------------> |
                                                               v
                           existing persistent context -> owned session pages
```

- Only literal `127.0.0.1` or `[::1]` HTTP origins with explicit ports are accepted. Credentials, query strings, fragments, non-root paths and redirects are rejected. The version handshake must identify Chromium and advertise a browser WebSocket on the same origin. Endpoint response size and connection time are bounded.
- The first explicitly configured attach pins the advertised browser UUID for that runtime; optional `expectedBrowserId` pins it from configuration. A replacement UUID is rejected, including after a disconnect. This is connection-identity validation, not authentication of a local process: another process able to impersonate the endpoint remains outside this boundary.
- Persistent-context login is reused without inspecting, exporting or copying cookies, storage or browser profiles. The context is shared: website/account state is not isolated even though page ownership is.
- Existing pages, unrelated new pages and other sessions' pages are never registered. New pages created by a session and popups emitted by its owned pages are registered only in that session. User-tab enumeration and claiming are disabled. Raw browser/context CDP, context-wide evaluation and browser shutdown are not exposed.
- Session page registries are ephemeral and scoped by the Host workspace identity plus session identity (CLI runtime session ID). A closing session rejects new commands and disposes only its own pages. Late page creation and popup arrival are cleaned by the same owner. Page IDs are unguessable but authorization depends on registry membership, not secrecy.
- Turn end cancels that turn's pending requests, not its pages. Session close cancels all its requests and cleans its pages. Host dispose cleans owned resources then detaches. It must never call persistent context close or send `Browser.close` to the attached Chromium. Playwright's connected-browser close only releases its client; integration tests verify the remote process and pre-existing page survive.
- Connection loss increments generation, invalidates page registries and rejects old wrappers. Execute never reconnects or replays writes; explicit discovery may reconnect to the same pinned UUID. An interrupted dispatched write reports uncertain side effects. Lost target IDs are not re-adopted.
- Desktop retains IAB as default and routes exact external descriptor IDs through the existing official discovery/execute protocol. Remote/cached desktop contexts cannot access a local external endpoint. Lifecycle commands share the same ownership key and cleanup path.

Acceptance tests cover origin/identity rejection, no-default attach, two-session isolation, popup ownership, user-page survival, late creation cleanup, cancellation/disconnection, stale generation, official SDK transport, desktop routing and managed headless regression. Dedicated test Chromium uses a temporary profile and local fixtures only. No real shop instance is required.

### Multiple instances and Windows flavor isolation

CLI `--browser-use=external --browser-instances=<JSON>` and Desktop `ZCODE_EXTERNAL_CDP=<JSON>` share the configuration schema `{"instances":[{"id":"work-a","endpoint":"http://127.0.0.1:9333","name":"Work A"},{"id":"work-b","endpoint":"http://127.0.0.1:9334","name":"Work B"}]}`. Each item accepts `id`, `endpoint`, optional `name` and `expectedBrowserId`. IDs are unique lowercase ASCII slugs (letters, digits, hyphens, underscore; maximum 64 characters). Duplicate endpoints are rejected to avoid duplicate ownership of the same context. Any number of entries may be configured; no shop names or port presets are built in. An empty array disables external discovery. Configuration is immutable for the runtime; adding/changing instances requires a new runtime, not source changes. Legacy single-instance CLI flags/Desktop JSON remain compatible but cannot be combined with the array CLI option.

The registry owns one adapter per configured ID. Descriptor IDs are stable `cdp:external:<id>`, display names are configured labels (fallback: ID), and each connection retains independent generation, browser-UUID pin and page ownership. Discovery returns all currently reachable instances; a failed instance is omitted without preventing healthy instances or IAB discovery. Execute routes by exact descriptor ID and never falls back to another backend. Session lifecycle broadcasts clean only that session's resources on each instance; detach settles all instance cleanups even if one fails. SDK `list()` returns names and IDs; `get('cdp')` rejects ambiguity and asks for an exact ID. Without IAB/another non-external backend, multiple external instances also require explicit selection rather than implicit default or URL-based account selection.

Windows Explorer menu keys are flavor-owned: production retains `ZCode.OpenInZCode`, Preview uses `ZCode.Preview.OpenInZCode`, development uses `ZCode.Dev.OpenInZCode`. Labels also identify the flavor. Both startup and locale refresh supply the compiled product flavor and packaged/development status. Installation updates only its own keys and never deletes or migrates another flavor's entries. Non-Windows is a no-op. Tests inject a fake registry runner; development tests must not modify the real Windows registry.
