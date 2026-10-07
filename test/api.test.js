const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../lib/app');
const config = require('../config');

let server, base;
const NM = config.partners[0].code;
const TD = config.partners[1].code;

before(async () => {
  server = createApp({ url: ':memory:' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (path, { code, method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Access-Code': code || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test('rechaza códigos inválidos', async () => {
  assert.equal((await call('/api/auth', { method: 'POST', body: { code: 'nope' } })).status, 401);
  assert.equal((await call('/api/concerts')).status, 401);
});

test('identifica al socio por su código', async () => {
  const { data } = await call('/api/auth', { method: 'POST', body: { code: TD } });
  assert.equal(data.partnerId, 'tdsynnex');
  assert.equal(data.partner.code, undefined);
});

test('reserva, evita dobles reservas y registra estadísticas', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  assert.equal(concerts.length, config.concerts.length);
  const id = concerts.find((c) => c.artist === 'Juanes').id;

  const r1 = await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [1, 2, 3], reservedBy: 'Sebastián' } });
  assert.equal(r1.status, 201);

  const clash = await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [3, 4], reservedBy: 'Ana' } });
  assert.equal(clash.status, 409);

  const r2 = await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [4], reservedBy: 'Ana', guestName: 'Cliente X' } });
  assert.equal(r2.status, 201);

  const { data: detail } = await call(`/api/concerts/${id}`, { code: TD });
  assert.deepEqual(detail.reservations.map((r) => [r.seat, r.partner_id]), [[1, 'netmask'], [2, 'netmask'], [3, 'netmask'], [4, 'tdsynnex']]);

  // TD SYNNEX no puede liberar sillas de Netmask
  const seat1 = detail.reservations[0];
  assert.equal((await call(`/api/reservations/${seat1.id}`, { code: TD, method: 'DELETE' })).status, 403);
  assert.equal((await call(`/api/reservations/${seat1.id}`, { code: NM, method: 'DELETE' })).status, 200);

  const { data: stats } = await call('/api/stats', { code: TD });
  assert.equal(stats.partners[0].id, 'netmask');
  assert.equal(stats.partners[0].seats, 2);
  assert.equal(stats.partners[1].seats, 1);

  const { data: log } = await call('/api/activity', { code: NM });
  assert.equal(log.length, 3);
});

test('el tercer socio puede reservar', async () => {
  const TP = config.partners[2].code;
  assert.equal(config.seats, 11);
  const { data: who } = await call('/api/auth', { method: 'POST', body: { code: TP } });
  assert.equal(who.partnerId, 'technologypartners');
  const { data: concerts } = await call('/api/concerts', { code: TP });
  const r = await call(`/api/concerts/${concerts[2].id}/reservations`, { code: TP, method: 'POST', body: { seats: [11], reservedBy: 'Luis' } });
  assert.equal(r.status, 201);
  const { data: stats } = await call('/api/stats', { code: TP });
  assert.equal(stats.partners.length, 3);
});

test('reserva parcial en conflicto no guarda ninguna silla', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const id = concerts[4].id;
  await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [6], reservedBy: 'A' } });
  const r = await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [5, 6, 7], reservedBy: 'B' } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /6/);
  const { data } = await call(`/api/concerts/${id}`, { code: NM });
  assert.deepEqual(data.reservations.map((x) => x.seat), [6]);
});

test('valida sillas fuera de rango', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const r = await call(`/api/concerts/${concerts[1].id}/reservations`, { code: NM, method: 'POST', body: { seats: [config.seats + 1], reservedBy: 'X' } });
  assert.equal(r.status, 400);
});

test('solo admin gestiona conciertos', async () => {
  const body = { artist: 'Prueba', date: '2026-12-30' };
  assert.equal((await call('/api/concerts', { code: NM, method: 'POST', body })).status, 403);
  assert.equal((await call('/api/concerts', { code: config.adminCode, method: 'POST', body })).status, 201);
});

test('la carga de conciertos es idempotente y respeta los eliminados', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-'));
  const url = 'file:' + path.join(dir, 'p.db');
  const start = async () => {
    const s = createApp({ url }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/concerts`, { headers: { 'X-Access-Code': config.adminCode } });
    return { s, list: await res.json(), port: s.address().port };
  };
  const a = await start();
  assert.equal(a.list.length, config.concerts.length);
  const victim = a.list.find((c) => c.artist === 'Carlos Vives');
  await fetch(`http://127.0.0.1:${a.port}/api/concerts/${victim.id}`, { method: 'DELETE', headers: { 'X-Access-Code': config.adminCode } });
  a.s.close();
  const b = await start();
  assert.equal(b.list.length, config.concerts.length - 1);
  assert.ok(!b.list.some((c) => c.artist === 'Carlos Vives'));
  b.s.close();
});
