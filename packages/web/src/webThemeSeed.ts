type WebThemeSeed = "light" | "dark" | "mikiko-light" | "mikiko-dark" | "system";

export const WEB_DEFAULT_THEME: WebThemeSeed = "mikiko-dark";

function isWebThemeSeed(value: unknown): value is WebThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "mikiko-light" ||
    value === "mikiko-dark" ||
    value === "system"
  );
}

function normalizeWebThemeSeed(theme: WebThemeSeed): WebThemeSeed {
  if (theme === "dark") return "mikiko-dark";
  if (theme === "light") return "mikiko-light";
  return theme;
}

export function resolveWebInitialTheme({
  storedTheme,
  defaultTheme = WEB_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  defaultTheme?: WebThemeSeed;
}): WebThemeSeed {
  if (isWebThemeSeed(storedTheme)) {
    return normalizeWebThemeSeed(storedTheme);
  }

  return normalizeWebThemeSeed(defaultTheme);
}
