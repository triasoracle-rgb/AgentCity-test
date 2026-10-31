#!/usr/bin/env node
// Descarga los PDFs de todos los resultados de una búsqueda en la
// Biblioteca Virtual de Prensa Histórica (https://prensahistorica.mcu.es).
//
// Uso:
//   node scripts/prensahistorica/scrape.mjs                       # busca "Lozano Sidro"
//   node scripts/prensahistorica/scrape.mjs --query "Lozano Sidro" --out ./pdfs
//   node scripts/prensahistorica/scrape.mjs --dry-run             # solo lista, no descarga
//   node scripts/prensahistorica/scrape.mjs --debug               # guarda el HTML recibido en <out>/_debug
//
// Nombre de los ficheros:  AAAAMMDD_titulo-del-periodico_pN.pdf
//   p.ej. 18970524_la-correspondencia-de-espana_p1.pdf
//
// El script es deliberadamente lento (--delay, por defecto 3 s entre peticiones)
// y respeta las respuestas 429 / Retry-After del servidor.

import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const BASE = 'https://prensahistorica.mcu.es';
const QUERY = opt('query', 'Lozano Sidro');
const EXACT = !flag('no-exact'); // por defecto busca la frase exacta "Lozano Sidro"
const OUT = path.resolve(opt('out', './pdfs-lozano-sidro'));
const DELAY_MS = Number(opt('delay', '3')) * 1000;
const MAX_PAGES = Number(opt('max-pages', '1000'));
const DRY = flag('dry-run');
const DEBUG = flag('debug');
const UA = opt('user-agent', 'prensahistorica-pdf-downloader/1.0 (descarga para investigacion)');

// ---------------------------------------------------------------- utilidades
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export function slugify(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes: España -> Espana
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Devuelve "AAAAMMDD" a partir de textos tipo "24/05/1897", "1897-05-24",
// "24 de mayo de 1897" o "24-mayo-1897". null si no encuentra fecha.
export function parseDate(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const pad = (n) => String(n).padStart(2, '0');
  let m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/);
  if (m) return `${m[3]}${pad(m[2])}${pad(m[1])}`;
  m = t.match(/\b(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
  if (m) return `${m[1]}${pad(m[2])}${pad(m[3])}`;
  m = t.match(/\b(\d{1,2})(?:\s+de\s+|[\s-]+)([a-záéíóú]+)(?:\s+de\s+|[\s-]+)(\d{4})\b/);
  if (m && MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')]) {
    return `${m[3]}${pad(MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')])}${pad(m[1])}`;
  }
  return null;
}

export function buildFilename({ date, title, page }) {
  return `${date || '00000000'}_${slugify(title || 'sin-titulo')}_p${page || 0}.pdf`;
}

// ---------------------------------------------------------------- cliente HTTP con cookies
const cookies = new Map();
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

let lastRequest = 0;
async function request(url, { method = 'GET', body, referer, binary = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequest + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();

    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'es-ES,es;q=0.9',
        Cookie: cookieHeader(),
        ...(referer ? { Referer: referer } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    storeCookies(res);

    if (res.status === 429 || res.status === 503) {
      // El servidor pide que bajemos el ritmo: esperamos lo que diga o con backoff.
      const ra = Number(res.headers.get('retry-after'));
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000 * 2 ** attempt;
      console.warn(`  ${res.status} del servidor; esperando ${Math.round(ms / 1000)} s…`);
      await sleep(ms);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    if (binary) return { res, buf: Buffer.from(await res.arrayBuffer()) };
    const buf = Buffer.from(await res.arrayBuffer());
    // La web declara iso-8859-1 en muchas páginas
    const ct = res.headers.get('content-type') || '';
    const charset = /charset=([^;]+)/i.exec(ct)?.[1]?.trim().toLowerCase() || 'utf-8';
    const html = new TextDecoder(charset === 'iso-8859-1' ? 'latin1' : charset).decode(buf);
    return { res, html, url: res.url };
  }
  throw new Error(`Demasiados 429 seguidos en ${url}; prueba con --delay mayor`);
}

let debugN = 0;
async function dumpDebug(name, html) {
  if (!DEBUG) return;
  const dir = path.join(OUT, '_debug');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${String(++debugN).padStart(4, '0')}_${name}.html`), html);
}

const abs = (href, from) => new URL(href, from).toString();

// ---------------------------------------------------------------- búsqueda
// Envía el formulario de búsqueda de busqueda.do rellenando el campo de texto general.
async function submitSearch() {
  const startUrl = `${BASE}/es/consulta/busqueda.do`;
  const { html, url } = await request(startUrl);
  await dumpDebug('busqueda', html);
  const $ = cheerio.load(html);

  // Elegimos el formulario que tiene un input de texto (el buscador general).
  const form = $('form').filter((_, f) => $(f).find('input[type=text], input:not([type])').length > 0).first();
  if (!form.length) throw new Error('No se encontró el formulario de búsqueda (usa --debug y revisa _debug/)');

  const params = new URLSearchParams();
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name) return;
    const type = ($el.attr('type') || 'text').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && !$el.is('[checked]')) return;
    if (el.tagName === 'select') {
      params.append(name, $el.find('option[selected]').attr('value') ?? $el.find('option').first().attr('value') ?? '');
    } else {
      params.append(name, $el.attr('value') ?? $el.text() ?? '');
    }
  });

  // Campo de texto principal: el primero de texto (normalmente busq_general / texto libre)
  const textInput = form.find('input[type=text], input:not([type])').first().attr('name');
  const q = EXACT ? `"${QUERY}"` : QUERY;
  params.set(textInput, q);
  console.log(`Buscando ${q} (campo "${textInput}")`);

  const action = abs(form.attr('action') || url, url);
  const method = (form.attr('method') || 'get').toUpperCase();
  return method === 'POST'
    ? request(action, { method: 'POST', body: params.toString(), referer: url })
    : request(`${action}${action.includes('?') ? '&' : '?'}${params}`, { referer: url });
}

// Del listado de resultados saca: enlaces a cada resultado y enlace a la página siguiente.
function parseResults(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Cada resultado de prensa enlaza al visor de imágenes (catalogo_imagenes) o a la ficha OCR.
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!/catalogo_imagenes|resultados_ocr|grupo\.(do|cmd)|registro\.(do|cmd)/i.test(href)) return;
    const u = abs(href, pageUrl);
    if (seen.has(u)) return;
    seen.add(u);
    // Contexto textual del resultado (título, fecha, página) para nombrar el fichero
    const ctx = $(a).closest('li, tr, .resultado, .result, div').first().text().replace(/\s+/g, ' ').trim();
    items.push({ url: u, linkText: $(a).text().replace(/\s+/g, ' ').trim(), context: ctx });
  });

  let next = null;
  $('a[href]').each((_, a) => {
    const t = $(a).text().trim().toLowerCase();
    const title = ($(a).attr('title') || '').toLowerCase();
    if (!next && (/^siguiente|^sig\.?$|^>$|^»$/.test(t) || /siguiente/.test(title))) next = abs($(a).attr('href'), pageUrl);
  });
  return { items, next };
}

// ---------------------------------------------------------------- resultado -> PDF
// Abre la página de un resultado, deduce título/fecha/página y localiza el enlace al PDF.
async function resolveItem(item, referer) {
  const { html, url } = await request(item.url, { referer });
  await dumpDebug('item', html);
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');

  // Título del periódico
  let title =
    $('meta[name="DC.title"], meta[property="og:title"]').attr('content') ||
    $('h1, h2, .titulo, .title').first().text().trim() ||
    item.linkText;
  title = title.replace(/\s*[\(,].*$/, '').replace(/\.\s*$/, '').trim();

  // Fecha y nº de página: primero la ficha, luego el contexto del listado y la URL
  const date = parseDate($('meta[name="DC.date"]').attr('content')) || parseDate(text) || parseDate(item.context);
  const pageMatch =
    /[?&]posicion=(\d+)/i.exec(url) ||
    /[?&]posicion=(\d+)/i.exec(item.url) ||
    /p[áa]gina\s*:?\s*(\d+)/i.exec(item.context) ||
    /p[áa]gina\s*:?\s*(\d+)/i.exec(text);
  const page = pageMatch ? Number(pageMatch[1]) : 1;

  // Enlace al PDF: preferimos el de la página concreta; si no, cualquiera que mencione pdf.
  const pdfLinks = [];
  $('a[href], iframe[src], embed[src], object[data]').each((_, el) => {
    const href = $(el).attr('href') || $(el).attr('src') || $(el).attr('data');
    const label = `${$(el).text()} ${$(el).attr('title') || ''}`.toLowerCase();
    if (/\.pdf\b|formato=pdf|pdf/i.test(href) || /pdf/.test(label)) pdfLinks.push({ href: abs(href, url), label });
  });
  const pdf =
    pdfLinks.find((l) => /p[áa]gina/.test(l.label)) ||
    pdfLinks.find((l) => /posicion=/.test(l.href)) ||
    pdfLinks[0];

  return { title, date, page, pdfUrl: pdf?.href ?? null, viewer: url };
}

// ---------------------------------------------------------------- main
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const index = [];
  const done = new Set(await fs.readdir(OUT));

  let { html, url } = await submitSearch();
  for (let p = 1; p <= MAX_PAGES; p++) {
    await dumpDebug(`resultados_p${p}`, html);
    const { items, next } = parseResults(html, url);
    console.log(`Página de resultados ${p}: ${items.length} resultados`);
    if (!items.length && p === 1) {
      console.error('No se detectaron resultados. Ejecuta con --debug y revisa los HTML en _debug/.');
    }

    for (const item of items) {
      try {
        const info = await resolveItem(item, url);
        const file = buildFilename(info);
        const row = { file, ...info, resultUrl: item.url };
        index.push(row);
        if (!info.pdfUrl) { console.warn(`  sin PDF: ${item.url}`); continue; }
        if (done.has(file)) { console.log(`  ya existe ${file}`); continue; }
        if (DRY) { console.log(`  [dry-run] ${file}  <- ${info.pdfUrl}`); continue; }

        const { res, buf } = await request(info.pdfUrl, { referer: info.viewer, binary: true });
        if (!buf.subarray(0, 5).toString().startsWith('%PDF')) {
          console.warn(`  la respuesta no es un PDF (${res.headers.get('content-type')}): ${info.pdfUrl}`);
          continue;
        }
        await fs.writeFile(path.join(OUT, file), buf);
        done.add(file);
        console.log(`  ✓ ${file} (${Math.round(buf.length / 1024)} KB)`);
      } catch (e) {
        console.warn(`  error en ${item.url}: ${e.message}`);
      }
    }

    if (!next) break;
    ({ html, url } = await request(next, { referer: url }));
  }

  await fs.writeFile(path.join(OUT, 'indice.json'), JSON.stringify(index, null, 2));
  const csv = ['file,date,title,page,pdfUrl,resultUrl',
    ...index.map((r) => [r.file, r.date, r.title, r.page, r.pdfUrl, r.resultUrl]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  await fs.writeFile(path.join(OUT, 'indice.csv'), csv);
  console.log(`\nHecho: ${index.length} resultados, índice en ${path.join(OUT, 'indice.csv')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
