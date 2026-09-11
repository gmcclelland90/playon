import assert from "node:assert/strict";
import { assertJailGone, jailListLooksGone, onlineNodeIds } from "./lab-matrix-jail-gc.mjs";

assert.equal(jailListLooksGone({ error: "not_found: servers/abc" }), true);
assert.equal(jailListLooksGone({ result: { entries: [] } }), true);
assert.equal(jailListLooksGone({ entries: [] }), true);
assert.equal(jailListLooksGone({ result: { entries: [{ name: "game", type: "dir" }] } }), false);
assert.equal(jailListLooksGone({}), false);

assert.doesNotThrow(() => assertJailGone({ error: "not_found: servers/x" }, "x"));
assert.throws(() => assertJailGone({ entries: [{ name: "game" }] }, "x"), /jail_not_removed: x/);

assert.deepEqual(
  onlineNodeIds({
    nodes: [
      { id: "playon-win-1", status: "online" },
      { id: "local", status: "offline" },
      { id: "stale", status: "stale" },
    ],
  }),
  ["playon-win-1"],
);

console.log("lab-matrix-jail-gc.test.mjs: ok");
