# Mikiko Computer Use

The built-in `computer-use` plugin is disabled by default. When enabled on a local macOS 14+ desktop with the bundled native runtime, it exposes a separate MCP server and the `computer-use` skill.

Mikiko's MCP adapter supplies trusted session, workspace, main-agent, and turn context and applies the existing tool approval flow. The native Mikiko application owns OS permissions and the global control lease. Remote workspaces, phone replay, and subagents cannot take local desktop control.

The server provides app discovery, AX and screenshot observation, targeted queries, observed element actions, keyboard actions, dragging, and `stop`. Every action requires fresh complete observation in the current turn. Query alone does not grant action admission. Cancelling or ending a turn releases the owned lease; uncertain side effects are never replayed automatically.

Grant Accessibility and Screen Recording to the exact Mikiko Computer Use application shown in Settings. Permission status comes from that application's app-agent. Restart is idle-only and refuses while a control session is active. A permission preflight is not a functional screenshot or AX test.

This plugin does not implement the former private producer or its NodeRepl SDK. Legacy SDK files retained for source compatibility are not part of this plugin's model-visible instructions or production execution path. User data remains under the existing Mikiko profile.
