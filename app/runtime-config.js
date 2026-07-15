/* Runtime config — COMMITTED PLACEHOLDER.
 *
 * This file is regenerated at build time by scripts/write-runtime-config.mjs from
 * (non-secret) environment variables. The committed version below is the safe
 * default so the app boots identically in local dev with no build step run.
 *
 * INVARIANT: no secrets, keys, or tokens ever live here. `liveApi` is a public
 * endpoint URL; `env` is a plain label. Anything sensitive stays server-side.
 */
export const RUNTIME_CONFIG = { liveApi: "", env: "dev" };
