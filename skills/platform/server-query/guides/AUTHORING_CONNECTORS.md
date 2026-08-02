# Authoring query connectors

PlayOn normalizes live stats into `LiveServerState` (`online`, `players`, `maxPlayers`, `map`, `mode`, `playerList`, …). Prefer a **built-in** `queryDialect` (`minecraft_status`, `a2s`, `valheim`, `unreal`, `terraria`, `factorio`) when it matches the game.

## When to use `skill_module`

If `skill_list` has no usable dialect for the game:

1. Research the query protocol; write `guides/QUERY.md`.
2. Add `query/connector.mjs` (default export `async function query(ctx)`).
3. Set `queryDialect: skill_module` in `metadata.yaml`.
4. Call `servers_query_test` against host:port until `online: true`.
5. Promote the draft skill when solid.

## Module contract

```js
// query/connector.mjs
export default async function query(ctx) {
  // ctx.host, ctx.port, ctx.queryPort, ctx.gamePort, ctx.timeoutMs
  // ctx.udp.request(buf), ctx.tcp.request(buf), ctx.http.get(path)
  // Network helpers only reach ctx.host on allowed ports.
  return {
    online: true,
    players: 0,
    maxPlayers: 8,
    map: "unknown",
  };
}
```

Rules:

- Return a plain object matching `LiveServerState`. Omit unknown fields.
- Do not invent player counts or maps.
- No filesystem, child_process, or outbound hosts other than the target.
- Keep secrets off the player panel.

## Tools

- `servers_query` — live state for a managed `serverId`
- `servers_query_test` — exercise a draft connector / skill against host:port
- `skill_draft_save` — optional `queryConnectorSource` + `queryGuide` writes the module and sets `skill_module`
