# computer-use-open

Independent opt-in local MCP preview, not an official CUA producer.

The controller owns one session/workspace binding, turn observation and the serial native queue. It accepts only host metadata (`com.zcode/request-context`), main scope and local desktop delivery. Preview identities must be absolute local workspace paths; an optional identity/key must equal that path. Arguments cannot grant scope. Targets are exact explicitly configured bundle IDs; default empty. New turns require fresh full state; retired turns are rejected. Query alone does not authorize actions. AX actions require AX and drag requires a returned screenshot. Cancelling an in-flight native call or timing out invalidates and closes this controller without replaying side effects. Cancelling a queued call does not enter native code.

The native port owns its transport, never OS-wide permission or global desktop ownership. Session isolation is not a global desktop lease. Production app control requires the Host owner/lease and turn-complete lifecycle described in the spec. This preview neither changes the original SDK placeholder nor writes user MCP settings. Existing MCP adapter metadata, approvals and image rendering are the only integration hooks.
