// Uji normalisasi payload CryptoRank memakai bentuk asli dari halaman
// /drophunting (props.pageProps.fallbackTableData.data).
const test = require('node:test');
const assert = require('node:assert');
const { normalizeItem, harvest, sortItems } = require('../scrape');

const RAW = {
  key: 'risex-activity1043',
  rating: 69,
  linkToClaim: null,
  coin: { key: 'risex', symbol: null, name: 'RISEx', icon: 'x.png' },
  activityTypes: ['Trading', 'Getting a role', 'Social'],
  status: 'CONFIRMED',
  statusUpdatedAt: '2026-09-03T21:30:00.189Z',
  createdAt: '2025-12-24T18:15:04.466Z',
  rewardType: 'Airdrop',
  cost: 30,
  time: 35,
};

test('normalizeItem memetakan field CryptoRank', () => {
  const it = normalizeItem(RAW);
  assert.strictEqual(it.id, 'cryptorank:risex-activity1043');
  assert.strictEqual(it.title, 'RISEx');
  assert.strictEqual(it.url, 'https://cryptorank.io/drophunting/risex-activity1043');
  assert.strictEqual(it.rating, 69);
  assert.strictEqual(it.costUsd, 30);
  assert.strictEqual(it.minutes, 35);
  assert.deepStrictEqual(it.activityTypes, ['Trading', 'Getting a role', 'Social']);
  assert.strictEqual(it.status, 'CONFIRMED');
});

test('normalizeItem membuang drop yang sudah selesai', () => {
  for (const status of ['ENDED', 'expired', 'Finished', 'CLOSED', 'inactive']) {
    assert.strictEqual(normalizeItem({ ...RAW, status }), null, status);
  }
});

test('normalizeItem menolak entri tanpa key atau judul', () => {
  assert.strictEqual(normalizeItem(null), null);
  assert.strictEqual(normalizeItem({ rating: 10 }), null);
  assert.strictEqual(normalizeItem({ key: 'x', coin: { name: '   ' } }), null);
});

test('normalizeItem memakai key coin kalau nama kosong', () => {
  const it = normalizeItem({ key: 'abc', coin: { key: 'abc-coin' }, status: 'ACTIVE' });
  assert.strictEqual(it.title, 'abc-coin');
});

test('harvest menelusuri payload bersarang dan membuang duplikat', () => {
  const payload = {
    props: {
      pageProps: {
        fallbackTableData: { count: 2, data: [RAW, { ...RAW }] },
        widgetsData: { hotEvents: [{ ...RAW, key: 'hot-activity1', coin: { name: 'Hot' } }] },
      },
    },
  };
  const out = harvest(payload);
  assert.strictEqual(out.size, 2);
  assert.ok(out.has('cryptorank:risex-activity1043'));
  assert.ok(out.has('cryptorank:hot-activity1'));
});

test('harvest tidak tersandung struktur dalam atau kosong', () => {
  assert.strictEqual(harvest(null).size, 0);
  assert.strictEqual(harvest({ a: [1, 'x', null] }).size, 0);
  assert.strictEqual(harvest({ items: [{ key: 'k', status: 'ENDED' }] }).size, 0);
});

test('sortItems mengurutkan rating tertinggi lebih dulu', () => {
  const list = sortItems([
    { title: 'b', rating: 10 },
    { title: 'a', rating: 90 },
    { title: 'c', rating: null },
  ]);
  assert.deepStrictEqual(list.map((x) => x.title), ['a', 'b', 'c']);
});
