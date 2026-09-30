/**
 * Reversible default copy for the in-app "make a mod that…" path (#996).
 * The host fills the ellipsis; send still goes through the normal composer
 * so confirm gates on mods_scaffold / mods_deploy stay in the agent loop.
 */
export const MAKE_A_MOD_DRAFT =
  "Make a mod that … for this server. Follow the AI modding loop: mods_scaffold under mods-src, edit the sources, mods_lua_check if this is Project Zomboid, mods_deploy (I will confirm; snapshot first), restart, then mods_errors and fix in mods-src until the Mods panel is clean.";
