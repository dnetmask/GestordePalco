const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const config = require('../config');

let server, base;
const NM = config.partners[0].code;
const TD = config.partners[1].code;

before(async () => {
  server = createApp({ dbPath: ':memory:' }).listen(0);
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
