// Enumerates the live Coral webpack module registry (after loading every console route)
// and reports which modules contain the Virtual POS "Payment demo" vocabulary, and whether
// any of them is an actual component wired to the advance/decline controls.
//
// Usage: node scripts/coral/probe-modules.mjs
import { loadChromium, CORAL } from './lib/pw.mjs';

const ROUTES = ['/', '/pos', '/pos/virtual', '/orders', '/networks', '/wallets', '/tokens',
  '/environments', '/security', '/sdk', '/docs'];
const NEEDLES = ['Simulate next step', 'demoPay', 'CHAIN_CONFIRMING', 'Awaiting customer scan',
  'pay.example.invalid', 'advance', 'decline'];

const chromium = await loadChromium();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newContext().then((c) => c.newPage());

await page.goto(`${CORAL}/login`, { waitUntil: 'networkidle' });
await page.getByText('Continue as Guest', { exact: false }).first().click();
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => {});

for (const r of ROUTES) {
  await page.goto(CORAL + r, { waitUntil: 'networkidle' }).catch(() => {});
}

const res = await page.evaluate((needles) => {
  const reg = {};
  for (const c of self.webpackChunk_N_E || []) {
    if (Array.isArray(c) && c[1] && typeof c[1] === 'object') Object.assign(reg, c[1]);
  }
  const hits = [];
  for (const [id, fn] of Object.entries(reg)) {
    let src = '';
    try { src = fn.toString(); } catch { continue; }
    const found = needles.filter((n) => src.includes(n));
    if (!found.length) continue;
    hits.push({
      id,
      found,
      isComponent: /useState|\.createElement|jsxs?\(|onClick/.test(src),
      usesAdvanceHandler: /onClick[^}]{0,40}(advance|decline|next)/i.test(src),
    });
  }
  return { total: Object.keys(reg).length, hits };
}, NEEDLES);

console.log('modules in registry:', res.total);
for (const h of res.hits) {
  console.log(`module ${h.id}: [${h.found}] component=${h.isComponent} advanceHandler=${h.usesAdvanceHandler}`);
}
await browser.close();
