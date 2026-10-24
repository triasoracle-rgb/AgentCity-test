// End-to-end check of the Virtual POS reconstruction, local file or deployed URL:
// EVM and Solana sessions, QR decode (must be an informational https URL carrying the
// real sandbox `to` address, never a payable wallet URI), the full state machine,
// the wallet-rejection branch, and the Japanese locale.
//
// Usage: node scripts/coral/verify-demo.mjs [path-or-url]
//        (default: coral/vpos-demo-reconstruction.html)
import path from 'path';
import { loadChromium, OUT, toTarget, decodeQr } from './lib/pw.mjs';

const target = toTarget(process.argv[2], 'coral/vpos-demo-reconstruction.html');
const EXPECT = {
  evm: '0x292A83a4363062916815EBbe2eF137d7B791d32d',
  sol: '7VcPhKXedtnce6iWGGvbGLkoEaSMTN4yyUcrGQuBA6zQ',
};

const chromium = await loadChromium();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newContext({ viewport: { width: 900, height: 1180 } }).then((c) => c.newPage());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };
const status = () => page.locator('#badge span:last-child').innerText();

console.log('target:', target);
await page.goto(target, { waitUntil: 'networkidle' });

for (const [net, cur] of [['evm', 'USDC'], ['sol', 'USDT']]) {
  await page.selectOption('#currency', cur);
  await page.selectOption('#network', net);
  await page.click('#t-create');
  await page.waitForTimeout(400);
  check((await page.textContent('#recv-addr')) === EXPECT[net], `${net}: receiving address shown`);
  const qr = await decodeQr(page);
  check(!!qr && qr.startsWith('https://') && qr.includes(`to=${EXPECT[net]}`), `${net}: QR decodes to informational URL (${qr})`);
  check(!!qr && !/^(ethereum|solana):/i.test(qr), `${net}: QR is not a payable wallet URI`);
  await page.screenshot({ path: path.join(OUT, `verify_${net}.png`), fullPage: true });
  await page.click('#t-end');
}

await page.click('#t-create');
const seen = [await status()];
for (let i = 0; i < 3; i++) { await page.click('#t-advance'); await page.waitForTimeout(150); seen.push(await status()); }
check(seen.join(' > ') === 'Awaiting customer scan > Paying > Chain confirming > Completed', `state machine: ${seen.join(' > ')}`);

await page.click('#t-restart');
await page.click('#t-decline');
await page.waitForTimeout(150);
check((await status()) === 'Failed', 'wallet rejection branch -> Failed');

await page.click('#t-restart');
await page.click('button[data-l="ja"]');
await page.waitForTimeout(150);
check((await status()) === '顧客の読み取りを待機中', 'Japanese locale');

check(errors.length === 0, `no console errors (${errors.length})`);
await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
