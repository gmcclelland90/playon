#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  stormworksContinueAfterSteamcmd,
  stormworksOverlayWrites,
  stormworksSteamAppId,
} from "./lab-matrix-stormworks.mjs";

assert.equal(stormworksSteamAppId(1247090), 573090);
assert.equal(stormworksSteamAppId(573090), 573090);

assert.equal(
  stormworksContinueAfterSteamcmd(
    "games.stormworks",
    "steamcmd_no_subscription: appId=573090 (anonymous login has no entitlement)",
  ),
  true,
);
assert.equal(
  stormworksContinueAfterSteamcmd("games.valheim", "steamcmd_no_subscription: appId=896660"),
  false,
);

const writes = stormworksOverlayWrites({ startBat: "server.exe\r\n", configXml: "" });
assert.deepEqual(
  writes.map((f) => f.path),
  ["game/start.bat", "game/server_data/server_config.xml"],
);
assert.match(writes[0].content, /\+server_dir/);
assert.match(writes[1].content, /port="25564"/);

console.log("lab-matrix-stormworks.test.mjs: ok");
