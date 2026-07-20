/**
 * The local web UI server — a THIN presentation layer. All application logic
 * (automation, state, settings, actions) lives in `app.ts`; this file only
 * translates HTTP to core calls and serves the static UI. To build another
 * front end (Telegram bot, CLI, …), import from `./app` the same way this
 * file does — don't add logic here.
 *
 * Binds to 127.0.0.1 only — nothing is reachable from outside the machine.
 *
 *   GET  /                    the UI (public/index.html)
 *   GET  /api/state           everything the UI shows (wallet, position, config, metrics…)
 *   GET  /api/series          chart data (?series=pending&range=live|1h|1d|1w)
 *   GET  /api/presets         the risk presets (conservative|neutral|aggressive)
 *   GET  /api/estimate-buy    read-only impact + SLVR-out for a buy (?eth=0.1)
 *   GET  /api/wallet/export   download the recovery file
 *   POST /api/wallet/*        generate | import | restore | unlock | reveal
 *   POST /api/config          save settings (splits, hold wallet, thresholds, live)
 *   POST /api/start           start the automation loop
 *   POST /api/stop            stop it
 *   POST /api/run-once        run a single cycle now
 *   POST /api/max-lock        { amountSlvr: "12.5" | "all" } → max-lock wallet SLVR
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { APP_DIR, UI_PORT } from './config';
import { boot, buyAndLock, estimateBuy, getPresets, getSeries, getState, getTxStatus, maxLock, maybeResume, runOnce, startAutomation, stopAutomation, updateConfig, UserError } from './app';
import { exportWalletFile, generateWallet, importWallet, restoreWalletFile, revealKey, unlockWallet } from './keystore';

// ---- request plumbing ------------------------------------------------------

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

/** UserError → 400 with its message; anything else → 500, first line only. */
function jsonError(res: ServerResponse, err: unknown): void {
  const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  json(res, err instanceof UserError ? 400 : 500, { error: msg });
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * Drive-by protection. The server only listens on 127.0.0.1, but a malicious
 * WEBSITE the user visits could still fire cross-origin POSTs at
 * localhost:4663 from their browser (classic localhost-CSRF), or use DNS
 * rebinding to reach it under a foreign hostname. Three gates close this:
 *   1. Host allowlist — kills DNS rebinding (foreign Host header → 403).
 *   2. Origin check — browsers attach Origin to cross-site POSTs; anything
 *      that isn't this app (or a non-browser client like curl) → 403.
 *   3. JSON content-type required on POSTs — cross-origin JSON needs a CORS
 *      preflight, which we never grant.
 */
function requestAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `localhost:${UI_PORT}` && host !== `127.0.0.1:${UI_PORT}` && host !== `[::1]:${UI_PORT}`) {
    return false;
  }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${UI_PORT}` && origin !== `http://127.0.0.1:${UI_PORT}`) {
      return false;
    }
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

// ---- routes: each case is a translation, not logic -------------------------

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === 'GET' && path === '/api/state') {
    return json(res, 200, await getState());
  }

  if (req.method === 'GET' && path === '/api/series') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    try {
      return json(res, 200, getSeries(String(q.get('series') ?? 'pending'), String(q.get('range') ?? '1h')));
    } catch (err) {
      return jsonError(res, err);
    }
  }

  // The risk presets (static bundles the UI renders + prefills from).
  if (req.method === 'GET' && path === '/api/presets') {
    return json(res, 200, getPresets());
  }

  // Read-only estimate of what a Buy & Lock of ?eth= would do (impact + SLVR out).
  if (req.method === 'GET' && path === '/api/estimate-buy') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    try {
      return json(res, 200, await estimateBuy(String(q.get('eth') ?? '0')));
    } catch (err) {
      return jsonError(res, err);
    }
  }

  if (req.method === 'GET' && path === '/api/tx') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    try {
      return json(res, 200, await getTxStatus(String(q.get('hash') ?? '')));
    } catch (err) {
      return jsonError(res, err);
    }
  }

  // Download the wallet file for recovery (encrypted if a password was set).
  if (req.method === 'GET' && path === '/api/wallet/export') {
    const file = exportWalletFile();
    if (!file) return json(res, 404, { error: 'No wallet to export.' });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="slvr-autostaker-recovery-${file.address.slice(2, 10)}.json"`,
      ...SECURITY_HEADERS,
    });
    return void res.end(file.contents);
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);

  try {
    switch (path) {
      case '/api/wallet/generate': {
        const { address, privateKey } = generateWallet(body.password ? String(body.password) : undefined);
        // The key is returned ONCE so the UI can show it for backup, then never again.
        return json(res, 200, { ok: true, address, privateKey });
      }

      case '/api/wallet/import': {
        const address = importWallet(String(body.privateKey ?? '').trim(), body.password ? String(body.password) : undefined);
        return json(res, 200, { ok: true, address });
      }

      case '/api/wallet/restore': {
        const address = restoreWalletFile(String(body.contents ?? ''));
        return json(res, 200, { ok: true, address });
      }

      case '/api/wallet/unlock': {
        const address = unlockWallet(String(body.password ?? ''));
        maybeResume('wallet unlocked'); // continue where we left off before the restart
        return json(res, 200, { ok: true, address });
      }

      case '/api/wallet/reveal': {
        const privateKey = revealKey(body.password ? String(body.password) : undefined);
        return json(res, 200, { ok: true, privateKey });
      }

      case '/api/config': {
        updateConfig(body);
        return json(res, 200, { ok: true });
      }

      case '/api/start': {
        startAutomation();
        return json(res, 200, { ok: true });
      }

      case '/api/stop': {
        stopAutomation();
        return json(res, 200, { ok: true });
      }

      case '/api/run-once': {
        runOnce();
        return json(res, 200, { ok: true });
      }

      case '/api/max-lock': {
        const { tokenId } = await maxLock(String(body.amountSlvr ?? ''));
        return json(res, 200, { ok: true, tokenId });
      }

      case '/api/buy-lock': {
        const r = await buyAndLock(String(body.amountEth ?? ''));
        return json(res, 200, { ok: true, ...r });
      }

      default:
        return json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    // Wallet/keystore errors are user-facing by design → 400, like UserError.
    if (path.startsWith('/api/wallet/')) return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return jsonError(res, err);
  }
}

// ---- static files + server -------------------------------------------------

const PUBLIC_DIR = join(APP_DIR, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res: ServerResponse, path: string): void {
  const rel = path === '/' ? 'index.html' : path.slice(1);
  const resolved = normalize(join(PUBLIC_DIR, rel));
  const ok = resolved.startsWith(PUBLIC_DIR + sep) && existsSync(resolved) && statSync(resolved).isFile();
  const file = ok ? resolved : join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
  res.end(readFileSync(file));
}

export function startServer(): void {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (!requestAllowed(req)) {
      return json(res, 403, { error: 'request blocked (bad host, origin, or content-type)' });
    }
    if (path.startsWith('/api/')) {
      handleApi(req, res, path).catch((err) => {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    serveStatic(res, path);
  });

  server.listen(UI_PORT, '127.0.0.1', () => {
    const url = `http://localhost:${UI_PORT}`;
    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('  SLVR Auto-Staker is running.');
    console.log(`  Open ${url} in your browser.`);
    console.log('  Keep this window open. Press Ctrl+C to quit.');
    console.log('════════════════════════════════════════════════════════');
    console.log('');
    openBrowser(url);
    boot('app restarted');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${UI_PORT} is already in use — is the app already running? Check http://localhost:${UI_PORT}`);
      process.exit(1);
    }
    throw err;
  });
}

function openBrowser(url: string): void {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Fine — the user can open the printed URL themselves.
  }
}
