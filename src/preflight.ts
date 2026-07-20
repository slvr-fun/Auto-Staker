/**
 * Environment preflight — runs before anything else so users get a friendly
 * message instead of a cryptic crash.
 *
 * The app needs Node 22.13+ for the built-in `node:sqlite` module (chosen
 * deliberately: no native modules to compile, so a plain `npm install` works
 * the same on Windows, macOS, and Linux).
 */
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

if (major < 22 || (major === 22 && minor < 13)) {
  console.error('');
  console.error('════════════════════════════════════════════════════════');
  console.error(`  Your Node.js is too old (v${process.versions.node}).`);
  console.error('  SLVR Auto-Staker needs Node v22.13 or newer.');
  console.error('');
  console.error('  Download the LTS version from https://nodejs.org,');
  console.error('  install it, then start the app again.');
  console.error('════════════════════════════════════════════════════════');
  console.error('');
  process.exit(1);
}

export {};
