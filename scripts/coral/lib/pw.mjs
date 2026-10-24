// Shared helpers for the Coral scripts: Playwright resolution, output dir, QR decoding.
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = path.join(ROOT, 'runs', 'coral');
mkdirSync(OUT, { recursive: true });

export const CORAL = 'https://coral.netx.world';
export const JSQR_URL = 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js';

// Prefer a project-installed playwright; fall back to the copy preinstalled in the cloud image.
export async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    const require = createRequire('/opt/node-tools/node_modules/');
    return require('playwright').chromium;
  }
}

// Turns a local path or URL argument into something page.goto() accepts.
export function toTarget(arg, fallback) {
  const t = arg || fallback;
  if (/^https?:\/\//.test(t)) return t;
  return 'file://' + path.resolve(ROOT, t);
}

// Masks JWTs so logs and saved network captures never carry a live session token.
export const redact = (s) => String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt-redacted>');

// Renders the page's QR SVG to a canvas and decodes it with jsQR; returns the payload or null.
export async function decodeQr(page) {
  if (!(await page.evaluate(() => typeof window.jsQR === 'function'))) {
    await page.addScriptTag({ url: JSQR_URL });
  }
  return page.evaluate(async () => {
    const svg = document.querySelector('.qrbox svg');
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const SZ = 420;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    });
    const c = document.createElement('canvas');
    c.width = SZ;
    c.height = SZ;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SZ, SZ);
    ctx.drawImage(img, 24, 24, SZ - 48, SZ - 48);
    const r = window.jsQR(ctx.getImageData(0, 0, SZ, SZ).data, SZ, SZ);
    return r ? r.data : null;
  });
}
