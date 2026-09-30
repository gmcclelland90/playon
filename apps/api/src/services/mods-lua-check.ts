/**
 * Static pre-deploy Lua API guard for Project Zomboid B42 AI-authored mods.
 * Prior art: playon-nexus tools/b42_api_check.py + serializeInventory nil crashes.
 * Does not require a PZ jar — flags known-unsafe call patterns that fail at runtime on B42.
 */

export type LuaCheckSeverity = "error" | "warn";

export type LuaCheckFinding = {
  severity: LuaCheckSeverity;
  rule: string;
  file: string;
  line: number;
  excerpt: string;
  message: string;
};

export type LuaCheckResult = {
  ok: boolean;
  findings: LuaCheckFinding[];
  scannedFiles: number;
};

/** Rules inspired by Glenn B42 serializeInventory / inventory roundtrip footguns. */
const RULES: Array<{
  rule: string;
  severity: LuaCheckSeverity;
  re: RegExp;
  message: string;
}> = [
  {
    rule: "no_getFavoriteHeight_call",
    severity: "error",
    // Direct method call — `if item.getFavoriteHeight then` property check is OK
    re: /:getFavoriteHeight\s*\(/,
    message:
      "B42: getFavoriteHeight() is nil — crashes serializeInventory. Use guarded field access or omit.",
  },
  {
    rule: "prefer_instanceItem",
    severity: "error",
    re: /InventoryItemFactory\s*\.\s*CreateItem\s*\(/,
    message:
      "B42: prefer instanceItem(fullType) (or a createItem helper that tries instanceItem first) over InventoryItemFactory.CreateItem.",
  },
  {
    rule: "no_getSpecificPlayer_on_dedicated",
    severity: "warn",
    re: /getSpecificPlayer\s*\(\s*0\s*\)/,
    message:
      "Dedicated servers: getSpecificPlayer(0) is often wrong for multiplayer — prefer the event player arg.",
  },
];

function scanLuaSource(file: string, source: string): LuaCheckFinding[] {
  const findings: LuaCheckFinding[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      // Allow property-existence checks for getFavoriteHeight
      if (
        rule.rule === "no_getFavoriteHeight_call" &&
        /\.getFavoriteHeight\b/.test(line) &&
        !/:getFavoriteHeight\s*\(/.test(line)
      ) {
        continue;
      }
      // Soft-allow InventoryItemFactory if instanceItem appears on same line as fallback comment
      if (
        rule.rule === "prefer_instanceItem" &&
        /instanceItem/.test(line)
      ) {
        continue;
      }
      findings.push({
        severity: rule.severity,
        rule: rule.rule,
        file,
        line: i + 1,
        excerpt: trimmed.slice(0, 200),
        message: rule.message,
      });
    }
  }
  return findings;
}

/** Scan a map of relative path → file text (e.g. mods-src tree). */
export function checkPzLuaSources(
  files: Record<string, string>,
): LuaCheckResult {
  const findings: LuaCheckFinding[] = [];
  let scannedFiles = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (!rel.toLowerCase().endsWith(".lua")) continue;
    scannedFiles += 1;
    findings.push(...scanLuaSource(rel.replace(/\\/g, "/"), content));
  }
  // File-level: if any file uses InventoryItemFactory but never mentions instanceItem, error already from line rule.
  // Extra: empty scan is ok.
  const errors = findings.filter((f) => f.severity === "error");
  return { ok: errors.length === 0, findings, scannedFiles };
}

/** Classic failing fixture (pre-fix Utils). */
export const FIXTURE_SERIALIZE_BAD = `
function Utils.serializeInventory(player)
  local inventory = player:getInventory()
  local items = {}
  for i = 0, inventory:getItems():size() - 1 do
    local item = inventory:getItems():get(i)
    table.insert(items, {
      type = item:getFullType(),
      favoriteHeight = item:getFavoriteHeight() or 0
    })
  end
  return encode(items)
end

function Utils.applyInventory(player, jsonData)
  local item = InventoryItemFactory.CreateItem(itemData.type)
  inventory:AddItem(item)
end
`.trim();

/** Fixed fixture aligned with Glenn B42 Utils. */
export const FIXTURE_SERIALIZE_GOOD = `
function Utils.createItem(fullType)
  if instanceItem then
    local ok, item = pcall(instanceItem, fullType)
    if ok and item then return item end
  end
  return nil
end

function Utils.serializeInventory(player)
  local inventory = player:getInventory()
  local items = {}
  for i = 0, inventory:getItems():size() - 1 do
    local item = inventory:getItems():get(i)
    local data = { type = item:getFullType() }
    -- never call getFavoriteHeight on B42
    table.insert(items, data)
  end
  return encode(items)
end

function Utils.applyInventory(player, jsonData)
  local item = Utils.createItem(itemData.type)
  if item then inventory:AddItem(item) end
end
`.trim();
