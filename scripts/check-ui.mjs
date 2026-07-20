// Parses public/index.html's inline script and verifies every element id
// referenced via $('...') exists in the markup. Catches the two easiest ways
// to silently kill the dashboard: a syntax error, or a handler wired to a
// removed element. Run with: npm run check:ui
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</' + 'script>'));

try {
  new Function(script);
} catch (e) {
  console.error('❌ UI script has a syntax error:', e.message);
  process.exit(1);
}

const idsInHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([...script.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
const missing = [...refs].filter((r) => !idsInHtml.has(r)).sort();
if (missing.length) {
  console.error('❌ UI script references missing element ids:', missing.join(', '));
  process.exit(1);
}
console.log(`✅ UI ok — script parses, all ${refs.size} element references exist`);
