/* scripts/write-runtime-config.mjs — build-time runtime config emitter.
 *
 * Netlify build command (see netlify.toml). Reads a few NON-SECRET env vars and
 * writes app/runtime-config.js. Safe to run with an empty environment: it then
 * emits the same committed defaults, so a build with no env set is a no-op-shaped
 * write rather than a failure.
 *
 * Node built-ins ONLY (node:fs, node:path, node:url) — nothing to install, so
 * this runs on a clean box. NO secrets are ever read or written here: `liveApi`
 * is a public endpoint URL and `env` is a plain label. Anything sensitive stays
 * in server-side function env, never shipped to the client.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve repo root relative to THIS file (scripts/…) so the script works no
// matter what cwd Netlify invokes it from.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outPath = join(repoRoot, 'app', 'runtime-config.js');

// Non-secret inputs. Both have safe empty-string defaults.
const liveApi = String(process.env.NFL2026_LIVE_API || '').trim();
const env = String(process.env.NFL2026_ENV || 'dev').trim();

const config = { liveApi, env };

const banner =
  '/* Auto-generated at build time by scripts/write-runtime-config.mjs.\n' +
  ' * Do not edit by hand. No secrets — public values only. */\n';

// Emit the same shape the committed placeholder uses, so the module contract
// (export const RUNTIME_CONFIG = {...}) is identical whether built or not.
const body = `${banner}export const RUNTIME_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

writeFileSync(outPath, body, 'utf8');
console.log(`Wrote app/runtime-config.js (env=${env || 'dev'}, liveApi=${liveApi ? 'set' : 'empty'})`);
