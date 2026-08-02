declare module "gamedig" {
  export type GameDigQueryOptions = {
    type: string;
    host: string;
    port?: number;
    givenPortOnly?: boolean;
    socketTimeout?: number;
    attemptTimeout?: number;
    maxRetries?: number;
    requestPlayers?: boolean;
    requestRules?: boolean;
  };

  export type GameDigPlayer = {
    name?: string;
    raw?: Record<string, unknown>;
    [key: string]: unknown;
  };

  export type GameDigResult = {
    name?: string;
    map?: string;
    password?: boolean;
    numplayers?: number;
    maxplayers?: number;
    players?: GameDigPlayer[];
    version?: string;
    raw?: Record<string, unknown>;
    [key: string]: unknown;
  };

  export class GameDig {
    static query(options: GameDigQueryOptions): Promise<GameDigResult>;
  }

  export const games: Record<string, unknown>;
  export const protocols: Record<string, unknown>;
}
