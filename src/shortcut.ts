export const DEFAULT_TOGGLE_SHORTCUT = "Alt+C";
export const TOGGLE_SHORTCUT_STORAGE_KEY = "toggleShortcut";

export type ShortcutConfig = {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  label: string;
};

const MODIFIER_ALIASES = new Map<string, keyof Omit<ShortcutConfig, "key" | "label">>([
  ["alt", "altKey"],
  ["ctrl", "ctrlKey"],
  ["control", "ctrlKey"],
  ["cmd", "metaKey"],
  ["command", "metaKey"],
  ["meta", "metaKey"],
  ["shift", "shiftKey"]
]);

const DISPLAY_NAMES: Record<keyof Omit<ShortcutConfig, "key" | "label">, string> = {
  ctrlKey: "Ctrl",
  altKey: "Alt",
  shiftKey: "Shift",
  metaKey: "Cmd"
};

const MODIFIER_KEYS = new Set(["alt", "control", "ctrl", "shift", "meta", "command", "cmd"]);

function normalizeKeyToken(token: string): string {
  if (!token) {
    return "";
  }

  if (token.length === 1) {
    return token.toUpperCase();
  }

  if (/^f\d{1,2}$/i.test(token)) {
    return token.toUpperCase();
  }

  if (token.toLowerCase() === "space") {
    return "Space";
  }

  if (token.toLowerCase() === "esc" || token.toLowerCase() === "escape") {
    return "Escape";
  }

  return token.slice(0, 1).toUpperCase() + token.slice(1).toLowerCase();
}

export function normalizeShortcutInput(value: string): string | null {
  const parsed = parseShortcut(value);
  return parsed?.label ?? null;
}

export function parseShortcut(value: string): ShortcutConfig | null {
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  const config: Omit<ShortcutConfig, "label"> = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: ""
  };

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (modifier) {
      config[modifier] = true;
      continue;
    }

    if (config.key) {
      return null;
    }

    config.key = normalizeKeyToken(token);
  }

  if (!config.key || (!config.altKey && !config.ctrlKey && !config.metaKey && !config.shiftKey)) {
    return null;
  }

  const parts = (
    [
      config.ctrlKey ? DISPLAY_NAMES.ctrlKey : null,
      config.altKey ? DISPLAY_NAMES.altKey : null,
      config.shiftKey ? DISPLAY_NAMES.shiftKey : null,
      config.metaKey ? DISPLAY_NAMES.metaKey : null,
      config.key
    ] as string[]
  ).filter(Boolean);

  return {
    ...config,
    label: parts.join("+")
  };
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key">,
  shortcut: ShortcutConfig
): boolean {
  return (
    event.altKey === shortcut.altKey &&
    event.ctrlKey === shortcut.ctrlKey &&
    event.metaKey === shortcut.metaKey &&
    event.shiftKey === shortcut.shiftKey &&
    normalizeKeyToken(event.key) === shortcut.key
  );
}

export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key">
): ShortcutConfig | null {
  const key = event.key.trim();
  if (!key || MODIFIER_KEYS.has(key.toLowerCase())) {
    return null;
  }

  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return null;
  }

  return parseShortcut(
    [
      event.ctrlKey ? DISPLAY_NAMES.ctrlKey : null,
      event.altKey ? DISPLAY_NAMES.altKey : null,
      event.shiftKey ? DISPLAY_NAMES.shiftKey : null,
      event.metaKey ? DISPLAY_NAMES.metaKey : null,
      normalizeKeyToken(key)
    ]
      .filter(Boolean)
      .join("+")
  );
}
