/**
 * SLVR Auto-Staker — entry point.
 *
 *   npm start        launch the local web UI (the normal way to use the app)
 *   npm run status   terminal view of wallet + position + automation state
 *   npm run once     run a single automation cycle in the terminal, then exit
 *   npm run check    no-wallet connectivity check
 *   npm run config   read/update config.json from the terminal (see below)
 */
import './preflight'; // must stay first — friendly Node-version check
import 'dotenv/config';
import { hasConfig, loadConfig, DEFAULTS } from './config';
import { walletCtx } from './chain';
import { runCycle } from './cycle';
import { startServer } from './server';
import { updateConfig } from './app';
import { showCheck, showStatus } from './status';

async function runOnce(): Promise<void> {
  if (!hasConfig()) {
    console.log('Not set up yet — run "npm start" and finish setup in the browser first.');
    process.exit(1);
  }
  const cfg = loadConfig();
  const ctx = walletCtx();
  console.log(`▶ one cycle — ${cfg.live ? 'LIVE' : 'DRY-RUN'} · wallet ${ctx.account.address} · veNFT #${cfg.tokenId}`);
  await runCycle(ctx, cfg);
}

/**
 * Read or update the saved config from the terminal — so it can be changed
 * outside the app (e.g. by Claude) and PERSISTS. Writes config.json
 * atomically after validating, and a running app picks the change up on its
 * next cycle (no restart needed).
 *
 *   config                          print the current config as JSON
 *   config get <key>                print one value
 *   config set key=value [k2=v2 …]  set fields (numbers/bools/strings coerced
 *                                   per field; nested: strategyParams.opp.highEdge=8)
 *   config set-json '{"buybackDipPct":3}'   merge a JSON patch (most flexible)
 */
function configCommand(): void {
  const sub = process.argv[3];
  const current = hasConfig() ? loadConfig() : ({ ...DEFAULTS, tokenId: '' } as any);

  if (!sub || sub === 'show') {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  if (sub === 'get') {
    const key = process.argv[4];
    if (!key) throw new Error('usage: config get <key>');
    console.log(JSON.stringify(current[key] ?? null, null, 2));
    return;
  }
  let patch: Record<string, unknown>;
  if (sub === 'set-json') {
    patch = JSON.parse(process.argv[4] || '{}');
  } else if (sub === 'set') {
    patch = {};
    for (const arg of process.argv.slice(4)) {
      const eq = arg.indexOf('=');
      if (eq < 0) throw new Error(`bad argument "${arg}" — use key=value`);
      const key = arg.slice(0, eq);
      const val = arg.slice(eq + 1);
      if (key.startsWith('strategyParams.')) {
        patch.strategyParams = (patch.strategyParams as Record<string, number>) ?? {};
        (patch.strategyParams as Record<string, number>)[key.slice('strategyParams.'.length)] = Number(val);
      } else {
        // Coerce "true"/"false" to real booleans — updateConfig uses Boolean(),
        // and Boolean("false") is true, so a string would flip the flag the
        // wrong way. Numeric/string fields coerce correctly downstream (Number/
        // String), so only the boolean case needs handling here.
        patch[key] = val === 'true' ? true : val === 'false' ? false : val;
      }
    }
  } else {
    console.log('usage: config [show] | config get <key> | config set key=value … | config set-json \'{…}\'');
    return;
  }
  const next = updateConfig(patch); // validates + saves atomically; throws on bad input
  console.log('✅ saved config.json (a running app applies it on the next cycle):');
  console.log(JSON.stringify(next, null, 2));
}

const command = process.argv[2] ?? 'ui';
const commands: Record<string, () => Promise<void> | void> = {
  ui: startServer,
  once: runOnce,
  status: showStatus,
  check: showCheck,
  config: configCommand,
};

const fn = commands[command];
if (!fn) {
  console.log(`Unknown command "${command}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
Promise.resolve(fn())
  .then(() => {
    if (command !== 'ui') process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
