/** Fixture connector — returns static online state (no network). */
export default async function query(ctx) {
  return {
    online: true,
    name: "query-fixture",
    game: "Query Fixture",
    map: "testmap",
    players: 0,
    maxPlayers: 4,
    extras: { host: ctx.host, port: ctx.port },
  };
}
