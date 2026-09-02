/* app/gate.js — front-of-site password gate (soft access control).
 *
 * A lightweight entry screen so only people with the shared password reach the
 * app. It is a DETERRENT, not real security: this is a public static site, so
 * the code and the data/*.json feeds are readable by anyone technical — the
 * gate keeps casual/search visitors out, nothing more. (For real protection,
 * put the site behind Netlify password protection at the HTTP layer.)
 *
 * The password is never stored in plaintext here — only the SHA-256 of it. On a
 * correct entry we persist an unlock flag in localStorage so returning visitors
 * on the same browser skip the screen. Dependency-free; SubtleCrypto is
 * available in every secure context (HTTPS + localhost).
 */

const UNLOCK_KEY = 'nfl2026.unlock.v1';
// SHA-256 of the shared password. Hash, not plaintext, so the literal is not
// greppable in the repo. (Rotate by updating this digest.)
const PASS_HASH = '385d13f26064845ecdc2c60df40747c03e5c534a461dbc00bcccc3e376e6aa8f';

/** True once this browser has unlocked (persisted). */
function isUnlocked() {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch (_) {
    return false; // storage blocked (private mode edge) — gate each load
  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * If already unlocked, resolve immediately. Otherwise render a full-screen
 * overlay and resolve only after a correct password is entered. Rejects never —
 * the promise simply stays pending until the user unlocks.
 */
export function ensureUnlocked() {
  if (isUnlocked()) return Promise.resolve();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Enter password to continue');
    overlay.innerHTML =
      '<form class="gate-card" autocomplete="off">' +
        '<div class="gate-brand">NFL<span>2026</span></div>' +
        '<label class="gate-label" for="gate-pw">Enter password</label>' +
        '<input class="gate-input" id="gate-pw" type="password" ' +
          'autocomplete="off" autocapitalize="off" autocorrect="off" ' +
          'spellcheck="false" aria-describedby="gate-msg" />' +
        '<button class="gate-btn" type="submit">ENTER</button>' +
        '<div class="gate-msg" id="gate-msg" role="alert" aria-live="polite"></div>' +
      '</form>';
    document.body.appendChild(overlay);
    document.body.classList.add('gate-locked');

    const form = overlay.querySelector('.gate-card');
    const input = overlay.querySelector('.gate-input');
    const msg = overlay.querySelector('.gate-msg');
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      let hex = '';
      try {
        hex = await sha256Hex(input.value || '');
      } catch (_) {
        msg.textContent = 'This browser blocked the check. Try a modern browser over HTTPS.';
        return;
      }
      if (hex === PASS_HASH) {
        try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (_) { /* session-only */ }
        overlay.remove();
        document.body.classList.remove('gate-locked');
        resolve();
      } else {
        msg.textContent = 'Incorrect password.';
        input.value = '';
        input.focus();
      }
    });
  });
}
