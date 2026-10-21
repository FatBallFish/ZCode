# computer-use-open

Independent opt-in local MCP preview, not an official CUA producer.

The controller owns one session/workspace binding, turn observation and the serial native queue. It accepts only host metadata (`com.zcode/request-context`), main scope and local desktop delivery. Preview identities must be absolute local workspace paths; an optional identity/key must equal that path. Arguments cannot grant scope. Targets are exact explicitly configured bundle IDs; default empty. New turns require fresh full state; retired turns are rejected. Query alone does not authorize actions. AX actions require AX and drag requires a returned screenshot. Cancelling an in-flight native call or timing out invalidates and closes this controller without replaying side effects. Cancelling a queued call does not enter native code.

The native port owns its transport, never OS-wide permission or global desktop ownership. Session isolation is not a global desktop lease. Production app control requires the Host owner/lease and turn-complete lifecycle described in the spec. This preview neither changes the original SDK placeholder nor writes user MCP settings. Existing MCP adapter metadata, approvals and image rendering are the only integration hooks.

## Production entry

`createProductionComputerUseController(factory)` creates a session-isolated controller for the bundled macOS backend. It exposes native list_apps plus the ten narrowed tools and stop; explicit plugin enablement and existing MCP approvals authorize access, not a preview allowlist. Only exact bundle IDs are accepted for targets. Local identities use the shared remote-workspace parser; optional keys must match identity-or-path. Discovery never grants action authority. stop and turn changes end/close only this native connection, clear observations, and create the next native connection lazily. Retired turns and cross-identity calls remain rejected even after stop. Global mutual exclusion belongs exclusively to the native app-agent. Cancellation, timeout or uncertain transport failure invalidates the gateway; no action retries. The production stdio entry never enables the preview by environment fallback.

The production entry exports `main()` for the official CLI plugin host. Import alone must not start a server; the host invokes main explicitly. Direct stdio execution invokes the same main only when the module is the process entry. Both modes share the same signal/EOF cleanup. Startup discovery alone is insufficient acceptance: the real plugin-host command must stay alive through a contextual tool call.

Trusted `notifications/mikiko/turn-ended` carries the same `_meta["com.zcode/request-context"]` as tool calls, from the runtime finally boundary. The gateway serializes completion after admitted IO, retires the matching turn and closes its native connection. Late completion for an older turn is a no-op; foreign sessions are rejected. Only production registers this private notification.

Production tool discovery and list_apps use short-lived owned native connections, closed immediately after the read. They never retain an idle native client that an explicit permission restart could invalidate. The action connection opens lazily on observation and remains protected by the native lease. Controller disposal closes all owned read/action transports; no user-side action is replayed.

Production drag's narrowed catalog must explicitly say it moves the real system mouse, may change foreground focus, needs a fresh screenshot, and rejects stale/occluded window targets. Gateway-owned descriptions sanitize native text without erasing these product semantics.
