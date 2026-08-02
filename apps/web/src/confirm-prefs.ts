const ALWAYS_ALL_KEY = "playon.confirm.alwaysAll";
const ALWAYS_TOOLS_KEY = "playon.confirm.alwaysTools";

export type ConfirmPrefs = {
  alwaysAll: boolean;
  alwaysTools: string[];
};

function readTools(): string[] {
  try {
    const raw = localStorage.getItem(ALWAYS_TOOLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch {
    return [];
  }
}

export function getConfirmPrefs(): ConfirmPrefs {
  try {
    return {
      alwaysAll: localStorage.getItem(ALWAYS_ALL_KEY) === "1",
      alwaysTools: readTools(),
    };
  } catch {
    return { alwaysAll: false, alwaysTools: [] };
  }
}

export function shouldAutoApprove(toolName: string): boolean {
  const prefs = getConfirmPrefs();
  if (prefs.alwaysAll) return true;
  return prefs.alwaysTools.includes(toolName);
}

export function setAlwaysApproveAll(): void {
  try {
    localStorage.setItem(ALWAYS_ALL_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function setAlwaysApproveTool(toolName: string): void {
  try {
    const tools = new Set(readTools());
    tools.add(toolName);
    localStorage.setItem(ALWAYS_TOOLS_KEY, JSON.stringify([...tools]));
  } catch {
    /* ignore */
  }
}

export function clearConfirmPrefs(): void {
  try {
    localStorage.removeItem(ALWAYS_ALL_KEY);
    localStorage.removeItem(ALWAYS_TOOLS_KEY);
  } catch {
    /* ignore */
  }
}

export function hasConfirmPrefs(): boolean {
  const prefs = getConfirmPrefs();
  return prefs.alwaysAll || prefs.alwaysTools.length > 0;
}
