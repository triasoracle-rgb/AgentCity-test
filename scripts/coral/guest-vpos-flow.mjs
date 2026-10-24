// Drives the live Coral Virtual POS as a guest: native "Continue as Guest" login,
// /pos/virtual session creation, and a capture of every console-API request.
// Finding this reproduces: creating a session fires no backend call (client-side stub).
//
// Usage: node scripts/coral/guest-vpos-flow.mjs
// Output: runs/coral/vp_*.png, runs/coral/vp_netlog.json (JWTs redacted)
import { writeFileSync } from 'fs';
import path from 'path';
import { loadChromium, OUT, CORAL, redact } from './lib/pw.mjs';

const log = (...a) => console.log('[vpos]', ...a);
const netlog = [];

const chromium = await loadChromium();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newContext({ viewport: { width: 1280, height: 1600 } }).then((c) => c.newPage());

page.on('response', async (r) => {
  const u = r.url();
  const isApi = u.includes('/api/console/v1/');
  const isPost = r.request().method() === 'POST' && u.startsWith(CORAL);
  if (!isApi && !isPost) return;
  let body = '';
  try { body = (await r.text()).slice(0, 800); } catch {}
  netlog.push({ method: r.request().method(), status: r.status(), url: u.replace(CORAL, ''), body: redact(body) });
});

const shot = (name) => page.screenshot({ path: path.join(OUT, `vp_${name}.png`), fullPage: true });
const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');

await page.goto(`${CORAL}/login`, { waitUntil: 'networkidle' });
await page.getByText('Continue as Guest', { exact: false }).first().click();
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => {});
await page.waitForLoadState('networkidle').catch(() => {});
log('logged in as guest, url =', page.url());
await shot('01_home');

await page.goto(`${CORAL}/pos/virtual`, { waitUntil: 'networkidle' });
const before = netlog.length;
await page.locator('input[type="number"]').first().fill('12.50');
await page.getByRole('button', { name: /Create payment session/i }).click();
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2500);
await shot('02_session_created');

const session = (await text()).match(/VPS-[0-9A-F]{8}/)?.[0];
log('session id:', session);
log('requests fired by "Create payment session":', netlog.length - before);
log('advance control present:', (await page.getByRole('button', { name: /Simulate next step/i }).count()) > 0);

writeFileSync(path.join(OUT, 'vp_netlog.json'), JSON.stringify(netlog, null, 2));
log('netlog entries:', netlog.length, '->', path.join(OUT, 'vp_netlog.json'));
await browser.close();
