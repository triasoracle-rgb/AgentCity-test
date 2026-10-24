// Packs the public reconstruction into a single-file Cloudflare Worker module: the HTML is
// gzipped + base64-embedded and decompressed at request time with DecompressionStream.
//
// Usage: node scripts/coral/build-worker.mjs [html]   (default: coral/vpos-demo-public.html)
// Output: runs/coral/worker.js — upload as a module worker (main_module "worker.js").
import { readFileSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import path from 'path';
import { ROOT, OUT } from './lib/pw.mjs';

const src = path.resolve(ROOT, process.argv[2] || 'coral/vpos-demo-public.html');
const html = readFileSync(src);
const b64 = gzipSync(html, { level: 9 }).toString('base64');

const worker = `const H=${JSON.stringify(b64)};
export default {
  async fetch() {
    const bytes = Uint8Array.from(atob(H), (c) => c.charCodeAt(0));
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(await new Response(stream).arrayBuffer(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
};
`;

const out = path.join(OUT, 'worker.js');
writeFileSync(out, worker);
console.log(`html ${html.length} B -> gzip+b64 ${b64.length} B -> ${out}`);
