# Project Zomboid query fixture

Used in automated tests. Not for hosting a real game.

Live stats use the built-in `project_zomboid` dialect: Steam `A2S_INFO` on the game UDP port for player counts, plus RakNet unconnected ping (empty identifier) for liveness.
