'use strict';
/* =============================================================================
   Admin account recovery CLI (docs/archive/admin-account-recovery-roadmap.md,
   once every item there is done — kept in docs/ until then).

   For the case nothing else in this app covers: a forgotten admin password, or
   an admin account stuck in its login lockout, with no other admin able to log
   in to fix it and no email/SMS to fall back on. Run directly against the same
   SQLite file the server uses (node:sqlite's WAL mode allows a brief,
   infrequent write from a second short-lived process while the server keeps
   running — no need to stop the container first).

   Deliberately a local script, not an HTTP endpoint: the security boundary is
   "can this person exec into the box," the same boundary every other sensitive
   operation here already assumes (editing docker-compose.yml, reading the raw
   darts.db file, backend/backup.js). No confirmation prompt beyond running the
   command itself, for the same reason.

   Usage:
     node backend/admin-recovery.js list
     echo -n 'newpassword' | node backend/admin-recovery.js reset-password <username>
     node backend/admin-recovery.js reset-password <username>   (interactive prompt if no pipe)
     node backend/admin-recovery.js clear-lockout <username>

   Or via Docker, without a bare `node` process on the host:
     docker exec -it oche node backend/admin-recovery.js list

   Env vars: DARTS_DB (same var the server and backend/backup.js both use).

   Reading the new password from a CLI argument would leak it into shell
   history and `ps` output for the life of the process — read it from stdin
   instead (piped, or an interactive masked prompt if stdin is a TTY), the same
   shape `htpasswd`/`openssl passwd -stdin` use for exactly this reason. Piping
   still leaves the echoed value in the *invoking* shell's own history unless
   the operator is careful — this script's design reduces that risk, not
   eliminates it. The interactive prompt asks twice (a typo has no visual
   feedback to catch it, unlike a normal text field) since it's the case the
   doc's own open question about double confirmation actually earns its keep;
   a piped value is trusted as-is, matching openssl's own convention.
   ============================================================================= */
const fs = require('fs');
const db = require('./db.js');

function usageAndExit() {
  console.error([
    'Usage:',
    '  node backend/admin-recovery.js list',
    '  node backend/admin-recovery.js reset-password <username>',
    '  node backend/admin-recovery.js clear-lockout <username>',
    '',
    'Env: DARTS_DB must point at the live database (same var the server uses).',
  ].join('\n'));
  process.exit(1);
}

function findAdminByUsername(username) {
  const needle = String(username || '').toLowerCase();
  return db.listAdmins().find(a => a.username.toLowerCase() === needle);
}

function fmtLockStatus(admin) {
  const now = Date.now();
  const n = admin.loginFailCount;
  const attempts = `${n} failed attempt${n === 1 ? '' : 's'}`;
  if (admin.loginLockedUntil && admin.loginLockedUntil > now) {
    const remainingSec = Math.ceil((admin.loginLockedUntil - now) / 1000);
    return `LOCKED for ${remainingSec}s more (${attempts})`;
  }
  return n > 0 ? `ok (${attempts}, not locked)` : 'ok';
}

function cmdList() {
  const admins = db.listAdmins();
  if (admins.length === 0) { console.log('No admin accounts exist yet.'); return; }
  console.log('Admins:');
  for (const a of admins) {
    console.log(`  ${a.username}  (created ${a.createdAt})  ${fmtLockStatus(a)}`);
  }
}

// Reads the whole of stdin synchronously as a raw byte buffer, then strips at
// most one trailing newline (LF, or CRLF) — the exact shape `echo -n 'pw' | ...`
// (no trailing newline) and `echo 'pw' | ...` (one trailing newline) both
// produce, without silently eating a trailing character the operator actually
// intended as part of the password.
function readPipedPassword() {
  const raw = fs.readFileSync(0);
  let text = raw.toString('utf8');
  if (text.slice(-2) === '\r\n') text = text.slice(0, -2);
  else if (text.slice(-1) === '\n') text = text.slice(0, -1);
  return text;
}

// Named ASCII control-character codes used by the masked prompt below —
// compared via charCodeAt() rather than embedding the raw control bytes as
// string literals, which are invisible and easy to corrupt silently in an
// editor or a tool pipeline.
const KEY_ENTER_CR = 13, KEY_ENTER_LF = 10, KEY_CTRL_D = 4, KEY_CTRL_C = 3,
      KEY_BACKSPACE = 127, KEY_BACKSPACE_ALT = 8;

// Masked interactive prompt (stdin is a TTY, nothing piped in) — echoes '*'
// per character instead of the real one, since a terminal has no other way to
// hide typed input without pulling in a dependency.
function promptMasked(promptText) {
  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== 'function') { reject(new Error('stdin does not support raw mode')); return; }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); };
    function onData(char) {
      const code = char.charCodeAt(0);
      if (code === KEY_ENTER_CR || code === KEY_ENTER_LF || code === KEY_CTRL_D) {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (code === KEY_CTRL_C) {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      if (code === KEY_BACKSPACE || code === KEY_BACKSPACE_ALT) {
        if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
        return;
      }
      input += char;
      process.stdout.write('*');
    }
    stdin.on('data', onData);
  });
}

// Piped stdin is trusted as-is (single read, no confirmation — matches
// `openssl passwd -stdin`'s own convention). An interactive TTY prompt asks
// twice, since a masked prompt gives no visual feedback to catch a typo.
async function readNewPassword() {
  if (!process.stdin.isTTY) return readPipedPassword();
  const first = await promptMasked('New password: ');
  const second = await promptMasked('Confirm new password: ');
  if (first !== second) throw new Error('Passwords did not match.');
  return first;
}

async function cmdResetPassword(username) {
  if (!username) usageAndExit();
  const admin = findAdminByUsername(username);
  if (!admin) { console.error(`No admin account named "${username}".`); process.exit(1); }
  const password = await readNewPassword();
  await db.changeAdminPassword(admin.id, password);
  console.log(`Password reset for admin "${admin.username}"; lockout cleared.`);
}

async function cmdClearLockout(username) {
  if (!username) usageAndExit();
  const admin = findAdminByUsername(username);
  if (!admin) { console.error(`No admin account named "${username}".`); process.exit(1); }
  db.clearAdminLockout(admin.id);
  console.log(`Lockout cleared for admin "${admin.username}". Password unchanged.`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'list': return cmdList();
    case 'reset-password': return await cmdResetPassword(arg);
    case 'clear-lockout': return await cmdClearLockout(arg);
    default: usageAndExit();
  }
}

main().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
