import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildDesktopContextSection(): ContextSection {
  return createDesktopSection(
    "Mikiko Desktop Context",
    "desktop_context",
    [
      "# Mikiko Desktop Context",
      "",
      "### Files & URLs",
      "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
      "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).",
      "",
      "### Inline Code Comments",
      "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
      "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
      "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
      "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
      "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Keep line ranges tight; end defaults to start.",
      '- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
      "",
      "### Browser automation",
      "- Browser tasks run through the `control-browser` skill via the node REPL `js` tool; `await agent.browsers.list()` is the single availability source.",
      "- Besides the in-app browser (`iab`), this desktop app can attach to the user's own Chromium started with a CDP debug port: a default instance `cdp:external:default` at `http://127.0.0.1:9333` is always configured, and more instances can be added in Settings (hot-reloaded, no restart).",
      "- If the user wants to use their own browser (reusing their logins) and the discovery list shows no `cdp:external:*` descriptor, the debug port is not listening: ask the user to (re)start their browser with `--remote-debugging-port=9333` and then re-run `agent.browsers.list()` — do not conclude the capability is unsupported.",
      "- Select an external instance only by its exact id: `await agent.browsers.get(\"cdp:external:<id>\")`. It only drives tabs the session created; the user's existing tabs and login state stay untouched.",
    ].join("\n"),
  );
}

function createDesktopSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
