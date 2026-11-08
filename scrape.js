/**
 * Relay CryptoRank Drop Hunting → data/cryptorank.json
 *
 * Kenapa lewat GitHub Actions: cryptorank.io memakai Cloudflare managed
 * challenge yang menuntut eksekusi JS + fingerprint TLS browser asli. Termux
 * tidak punya browser, dan proxy teks (r.jina.ai) juga ditolak. Runner GitHub
 * punya Chromium asli, jadi scraping dilakukan di sini lalu hasilnya dibaca
 * mintwatch lewat raw.githubusercontent.com.
 *
 * Halaman /drophunting adalah Next.js: daftar drop ada di
 * props.pageProps.fallbackTableData.data, dan pemuatan berikutnya lewat
 * api.cryptorank.io (JSON). Keduanya ditangkap, digabung, lalu dinormalisasi.
 */
const fs = require('fs');
const path = require('path');

const LIST_URL = process.env.CRYPTORANK_URL || 'https://cryptorank.io/drophunting';
const OUT = process.env.OUTPUT || path.join(__dirname, 'data', 'cryptorank.json');
const SCROLLS = Number(process.env.SCROLLS || 60); // batas atas putaran gulir
const STAGNANT_STOP = 3; // berhenti setelah 3 putaran tanpa drop baru
const PAGE_URL = 'https://cryptorank.io/drophunting';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Status yang berarti drop sudah tidak bisa dikerjakan.
const DONE_RE = /^(ended|expired|finished|closed|inactive|canceled|cancelled)$/i;

function num(v) {
  return Number.isFinite(v) ? v : null;
}

/** Satu entri mentah CryptoRank → bentuk yang dipakai mintwatch. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !raw.key) return null;
  // Baris drop selalu punya status. Objek lain di payload (ringkasan koin di
  // widgetsData, mis. hotEvents) hanya punya key + coin dan harus dibuang.
  if (typeof raw.status !== 'string' || !raw.status.trim()) return null;
  const coin = raw.coin || {};
  const title = String(coin.name || coin.key || raw.key).trim();
  if (!title) return null;

  const status = String(raw.status || '').toUpperCase();
  if (DONE_RE.test(status)) return null;

  return {
    id: `cryptorank:${raw.key}`,
    key: String(raw.key),
    title,
    url: `${PAGE_URL}/${raw.key}`,
    symbol: coin.symbol || null,
    rating: num(raw.rating),
    status,
    costUsd: num(raw.cost),
    minutes: num(raw.time),
    activityTypes: Array.isArray(raw.activityTypes) ? raw.activityTypes.map(String) : [],
    rewardType: raw.rewardType ? String(raw.rewardType) : '',
    createdAt: raw.createdAt || null,
    statusUpdatedAt: raw.statusUpdatedAt || null,
  };
}

/**
 * Telusuri payload JSON apa pun dan kumpulkan objek yang berbentuk drop.
 * Dipakai untuk __NEXT_DATA__ maupun respons api.cryptorank.io, yang
 * bentuk pembungkusnya bisa berbeda-beda.
 */
function harvest(node, out = new Map(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;

  if (Array.isArray(node)) {
    for (const child of node) harvest(child, out, depth + 1);
    return out;
  }

  if (node.key && typeof node.status === 'string' && node.status) {
    const item = normalizeItem(node);
    if (item && !out.has(item.id)) out.set(item.id, item);
  }

  for (const value of Object.values(node)) harvest(value, out, depth + 1);
  return out;
}

function sortItems(items) {
  return [...items].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)
    || String(a.title).localeCompare(String(b.title)));
}

function write(items) {
  const list = sortItems(items);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'cryptorank',
    listUrl: LIST_URL,
    count: list.length,
    items: list,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  return list.length;
}

async function main() {
  // Diperlukan hanya saat scraping; test bisa jalan tanpa playwright terpasang.
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);
  // Headless terdeteksi Cloudflare (managed challenge tidak pernah selesai),
  // jadi jalankan headed di dalam xvfb (lihat workflow) + samarkan penanda
  // otomasi yang paling sering dipakai challenge.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
    timezoneId: 'Asia/Makassar',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await context.newPage();

  // Respons JSON dari halaman (termasuk api.cryptorank.io) ikut dipanen.
  // Disimpan per URL supaya tidak di-parse ulang tiap putaran gulir.
  const payloads = new Map();
  const apiUrls = new Set();
  page.on('response', async (res) => {
    const url = res.url();
    if (!/cryptorank\.io/i.test(url)) return;
    if (!/drophunting|airdrop|activity/i.test(url)) return;
    const type = res.headers()['content-type'] || '';
    if (!type.includes('json')) return;
    if (payloads.has(url)) return;
    try {
      payloads.set(url, await res.json());
      apiUrls.add(url);
    } catch { /* bukan JSON valid */ }
  });

  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Challenge Cloudflare selesai saat judul halaman tidak lagi "Just a moment".
  // Beri waktu lebih lama: mode headed kadang butuh >60 detik di runner lambat.
  await page.waitForFunction(
    () => !/just a moment|performing security verification/i.test(document.title),
    null,
    { timeout: 120000 },
  ).catch(() => console.warn('peringatan: challenge Cloudflare belum selesai'));
  // Setelah challenge lewat, tunggu tabel drop benar-benar ter-render.
  await page.waitForFunction(
    () => !!document.getElementById('__NEXT_DATA__'),
    null,
    { timeout: 60000 },
  ).catch(() => console.warn('peringatan: __NEXT_DATA__ tidak muncul'));
  await page.waitForTimeout(2000);

  const items = new Map();
  for (const payload of payloads.values()) harvest(payload, items);

  // Total yang diklaim halaman (kalau ada) — dipakai untuk memastikan daftar
  // benar-benar habis, bukan cuma berhenti karena lazy-load macet.
  const expected = await page.evaluate(() => {
    try {
      const raw = document.getElementById('__NEXT_DATA__')?.textContent || '';
      const j = raw ? JSON.parse(raw) : null;
      const t = j?.props?.pageProps?.fallbackTableData;
      return Number(t?.count) || null;
    } catch { return null; }
  }).catch(() => null);

  // Gulir sampai tidak ada drop baru selama STAGNANT_STOP putaran. Setiap
  // putaran memicu lazy-load halaman berikutnya; semua respons JSON dipanen.
  let stagnant = 0;
  for (let i = 0; i < SCROLLS && stagnant < STAGNANT_STOP; i++) {
    const before = items.size;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);
    for (const payload of payloads.values()) harvest(payload, items);
    if (items.size === before) stagnant++;
    else stagnant = 0;
  }

  const nextData = await page.evaluate(
    () => document.getElementById('__NEXT_DATA__')?.textContent || '',
  ).catch(() => '');
  if (nextData) {
    try { harvest(JSON.parse(nextData), items); } catch { /* biarkan kosong */ }
  }

  await browser.close();

  if (!items.size) {
    console.error('tidak ada drop terbaca — halaman kemungkinan masih di challenge');
    process.exit(1);
  }

  if (apiUrls.size) {
    console.log(`endpoint JSON tertangkap: ${apiUrls.size}`);
    for (const u of [...apiUrls].slice(0, 5)) console.log(`  ${u}`);
  }

  const total = write([...items.values()]);
  console.log(`tulis ${total} drop → ${OUT}`);
  if (expected && total < expected) {
    console.warn(`peringatan: halaman menyebut ${expected} drop, baru terbaca ${total}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { normalizeItem, harvest, sortItems, DONE_RE };
