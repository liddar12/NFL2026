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
import { readFileSync, writeFileSync } from 'node:fs';
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

// Cache-bust the stylesheet: /app/* ships with stale-while-revalidate, so right
// after a deploy a fresh index.html (max-age=0) could pair with a stale cached
// theme.css — new markup, old styles. Stamping the commit SHA into the ?v= tag
// makes the CSS URL unique per deploy. Netlify-only (COMMIT_REF): local runs
// never touch index.html, so the working tree stays clean in dev.
const sha = String(process.env.COMMIT_REF || '').trim().slice(0, 12);
if (sha) {
  const indexPath = join(repoRoot, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const stamped = html.replace(/\/app\/theme\.css\?v=[^"']*/, `/app/theme.css?v=${sha}`);
  if (stamped === html) {
    console.warn('WARNING: theme.css ?v= tag not found in index.html - CSS not cache-busted');
  } else {
    writeFileSync(indexPath, stamped, 'utf8');
    console.log(`Stamped index.html theme.css ?v=${sha}`);
  }
}
