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

// Conciertos de prueba con fecha lejana, para que las pruebas no dependan de la agenda real ni del día.
let testDay = 0;
const newConcert = async (artist) => {
  testDay += 1;
  const date = `2099-01-${String(testDay).padStart(2, '0')}`;
  const { data } = await call('/api/concerts', { code: config.adminCode, method: 'POST', body: { artist, date } });
  return data.id;
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
  const id = await newConcert('Prueba reservas');

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
  assert.equal(log.filter((a) => ['reserva', 'liberación'].includes(a.action)).length, 3);
});

test('el tercer socio puede reservar', async () => {
  const TP = config.partners[2].code;
  assert.equal(config.seats, 11);
  const { data: who } = await call('/api/auth', { method: 'POST', body: { code: TP } });
  assert.equal(who.partnerId, 'technologypartners');
  const { data: concerts } = await call('/api/concerts', { code: TP });
  const r = await call(`/api/concerts/${await newConcert('Prueba tercer socio')}/reservations`, { code: TP, method: 'POST', body: { seats: [11], reservedBy: 'Luis' } });
  assert.equal(r.status, 201);
  const { data: stats } = await call('/api/stats', { code: TP });
  assert.equal(stats.partners.length, 3);
});

test('reserva parcial en conflicto no guarda ninguna silla', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const id = await newConcert('Prueba conflicto');
  await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [6], reservedBy: 'A' } });
  const r = await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [5, 6, 7], reservedBy: 'B' } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /B1/);
  const { data } = await call(`/api/concerts/${id}`, { code: NM });
  assert.deepEqual(data.reservations.map((x) => x.seat), [6]);
});

test('valida sillas fuera de rango', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const r = await call(`/api/concerts/${await newConcert('Prueba validación')}/reservations`, { code: NM, method: 'POST', body: { seats: [config.seats + 1], reservedBy: 'X' } });
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

test('invitaciones y logos', async () => {
  const { data: concerts } = await call('/api/concerts', { code: TD });
  const id = await newConcert('Prueba invitaciones');
  await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [7], reservedBy: 'Ana', guestName: 'Cliente Y' } });
  const { data: mine } = await call('/api/invitations', { code: TD });
  const inv = mine.find((r) => r.artist === 'Prueba invitaciones');
  assert.equal(inv.seatLabel, 'B2');
  assert.equal(inv.guest_name, 'Cliente Y');
  assert.ok(mine.every((r) => r.partner_id === 'tdsynnex'));

  const { data: logos } = await call('/api/logos', { code: TD });
  assert.deepEqual(logos.netmask, { url: '/logos/netmask.svg', bg: 'light' });
  assert.equal(logos.tdsynnex, null);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call('/api/logos/tdsynnex', { code: TD, method: 'PUT', body: { dataUrl: png } })).status, 403);
  assert.equal((await call('/api/logos/tdsynnex', { code: config.adminCode, method: 'PUT', body: { dataUrl: png, bg: 'dark' } })).status, 200);
  const { data: after } = await call('/api/logos', { code: TD });
  assert.match(after.tdsynnex.url, /^\/api\/logos\/tdsynnex\?v=/);
  assert.equal(after.tdsynnex.bg, 'dark');
  const img = await fetch(base + '/api/logos/tdsynnex');
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('una corrección de fecha mueve el concierto existente sin duplicarlo', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-fix-'));
  const url = 'file:' + path.join(dir, 'p.db');
  // Base "antigua": Beéle cargado el 29 con una reserva
  const db = createClient({ url });
  await db.batch([
    'CREATE TABLE concerts (id INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL, date TEXT NOT NULL, notes TEXT)',
    'CREATE TABLE meta (key TEXT PRIMARY KEY)',
    "INSERT INTO concerts (artist, date) VALUES ('Beéle', '2026-11-29')",
    "INSERT INTO meta (key) VALUES ('concert:Beéle|2026-11-29')",
  ], 'write');
  db.close();
  const s = createApp({ url }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/concerts`, { headers: { 'X-Access-Code': config.adminCode } });
  const list = await res.json();
  s.close();
  const beele = list.filter((c) => c.artist === 'Beéle');
  assert.equal(beele.length, 1);
  assert.equal(beele[0].date, '2026-11-28');
  assert.equal(beele[0].id, 1);
  assert.ok(list.some((c) => c.artist === 'Ana Gabriel' && c.date === '2027-05-20'));
});

test('un concierto retirado se elimina de una base existente', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-rm-'));
  const url = 'file:' + path.join(dir, 'p.db');
  const db = createClient({ url });
  await db.batch([
    'CREATE TABLE concerts (id INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL, date TEXT NOT NULL, notes TEXT)',
    'CREATE TABLE meta (key TEXT PRIMARY KEY)',
    "INSERT INTO concerts (artist, date) VALUES ('KI/KI', '2026-12-04')",
    "INSERT INTO meta (key) VALUES ('concert:KI/KI|2026-12-04')",
  ], 'write');
  db.close();
  const s = createApp({ url }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/concerts`, { headers: { 'X-Access-Code': config.adminCode } });
  const list = await res.json();
  s.close();
  assert.ok(!list.some((c) => c.artist === 'KI/KI'));
  assert.ok(list.some((c) => c.artist === 'Hebert Vargas'));
});

test('la cartelera pública no requiere código ni revela quién reservó', async () => {
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const target = { id: await newConcert('Prueba cartelera') };
  await call(`/api/concerts/${target.id}/reservations`, { code: NM, method: 'POST', body: { seats: [1, 7], reservedBy: 'Secreto Interno', guestName: 'Cliente Confidencial' } });
  const res = await fetch(base + '/api/public/agenda');
  assert.equal(res.status, 200);
  const raw = await res.text();
  for (const leak of ['Secreto Interno', 'Cliente Confidencial', 'netmask', 'partner', 'reserved_by', 'guest']) {
    assert.ok(!raw.includes(leak), `la respuesta pública no debe incluir "${leak}"`);
  }
  const data = JSON.parse(raw);
  const f = data.concerts.find((c) => c.artist === 'Prueba cartelera');
  assert.deepEqual(f.occupied, [1, 7]);
  assert.equal(f.free, config.seats - 2);
  // Sin código no se puede reservar
  const r = await call(`/api/concerts/${target.id}/reservations`, { method: 'POST', body: { seats: [2], reservedBy: 'X' } });
  assert.equal(r.status, 401);
});

test('un retiro con force elimina el concierto y sus reservas, y lo deja en el historial', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-force-'));
  const url = 'file:' + path.join(dir, 'p.db');
  const db = createClient({ url });
  await db.batch([
    'CREATE TABLE concerts (id INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL, date TEXT NOT NULL, notes TEXT)',
    `CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, concert_id INTEGER NOT NULL, seat INTEGER NOT NULL,
      partner_id TEXT NOT NULL, reserved_by TEXT NOT NULL, guest_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (concert_id, seat))`,
    'CREATE TABLE meta (key TEXT PRIMARY KEY)',
    "INSERT INTO concerts (artist, date) VALUES ('Ozuna', '2026-12-03')",
    "INSERT INTO meta (key) VALUES ('concert:Ozuna|2026-12-03')",
    "INSERT INTO meta (key) VALUES ('removed:Ozuna|2026-12-03')",
    "INSERT INTO reservations (concert_id, seat, partner_id, reserved_by) VALUES (1, 1, 'netmask', 'Carlos'), (1, 2, 'netmask', 'Carlos')",
  ], 'write');
  db.close();
  const s = createApp({ url }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const port = s.address().port;
  const list = await (await fetch(`http://127.0.0.1:${port}/api/concerts`, { headers: { 'X-Access-Code': config.adminCode } })).json();
  const log = await (await fetch(`http://127.0.0.1:${port}/api/activity`, { headers: { 'X-Access-Code': config.adminCode } })).json();
  s.close();
  assert.ok(!list.some((c) => c.artist === 'Ozuna'));
  const entry = log.find((a) => a.action === 'concierto retirado');
  assert.match(entry.detail, /Ozuna · 2026-12-03: se liberaron 2 silla\(s\) \(A1 de Carlos, A2 de Carlos\)/);
  const check = createClient({ url });
  const { rows } = await check.execute('SELECT COUNT(*) AS n FROM reservations');
  check.close();
  assert.equal(rows[0].n, 0);
});

test('límite de 4 sillas por socio: el excedente queda en pre-reserva y otro socio lo aprueba', async () => {
  const TP = config.partners[2].code;
  const { data: concerts } = await call('/api/concerts', { code: NM });
  const id = await newConcert('Prueba límite');

  // Netmask pide 6: se confirman 4 y 2 quedan en pre-reserva
  const r = await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [1, 2, 3, 4, 5, 6], reservedBy: 'Carlos', guestName: 'Cliente ACME' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.confirmed, ['A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(r.data.pending, ['A5', 'B1']);

  // Las sillas en pre-reserva quedan apartadas para los demás
  const clash = await call(`/api/concerts/${id}/reservations`, { code: TD, method: 'POST', body: { seats: [5], reservedBy: 'Ana' } });
  assert.equal(clash.status, 409);

  // Las pre-reservas no cuentan en invitaciones
  const { data: inv } = await call('/api/invitations', { code: NM });
  assert.equal(inv.filter((x) => x.artist === 'Prueba límite').length, 4);

  // Netmask ve su solicitud pero no puede aprobarla; TD SYNNEX sí
  const { data: reqNm } = await call('/api/requests', { code: NM });
  const mine = reqNm.find((x) => x.artist === 'Prueba límite');
  assert.equal(mine.mine, true);
  assert.equal(mine.canDecide, false);
  assert.equal((await call(`/api/requests/${mine.requestId}/approve`, { code: NM, method: 'POST' })).status, 403);
  const { data: reqTd } = await call('/api/requests', { code: TD });
  assert.equal(reqTd.find((x) => x.requestId === mine.requestId).canDecide, true);

  // Basta con que Technology Partners apruebe
  assert.equal((await call(`/api/requests/${mine.requestId}/approve`, { code: TP, method: 'POST', body: { decidedBy: 'Luis' } })).status, 200);
  const { data: detail } = await call(`/api/concerts/${id}`, { code: NM });
  assert.ok(detail.reservations.every((x) => x.status === 'confirmed'));
  assert.equal(detail.reservations.length, 6);
  // Ya no está pendiente
  assert.equal((await call(`/api/requests/${mine.requestId}/approve`, { code: TD, method: 'POST' })).status, 404);

  // Ya con 6 confirmadas, una silla más vuelve a quedar en pre-reserva; TD SYNNEX la rechaza y se libera
  const r2 = await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [7], reservedBy: 'Carlos' } });
  assert.deepEqual(r2.data.pending, ['B2']);
  assert.equal((await call(`/api/requests/${r2.data.requestId}/reject`, { code: TD, method: 'POST' })).status, 200);
  const { data: after } = await call(`/api/concerts/${id}`, { code: NM });
  assert.ok(!after.reservations.some((x) => x.seat === 7));

  // El mismo socio puede cancelar su pre-reserva
  const r3 = await call(`/api/concerts/${id}/reservations`, { code: NM, method: 'POST', body: { seats: [8], reservedBy: 'Carlos' } });
  assert.equal((await call(`/api/requests/${r3.data.requestId}/reject`, { code: NM, method: 'POST' })).status, 200);

  // El historial registra la pre-reserva y la aprobación
  const { data: log } = await call('/api/activity?limit=200', { code: NM });
  assert.ok(log.some((a) => a.action === 'pre-reserva'));
  assert.ok(log.some((a) => a.action === 'aprobación' && /Technology Partners \(Luis\) aprobó/.test(a.detail)));
  assert.ok(log.some((a) => a.action === 'rechazo'));
  assert.ok(log.some((a) => a.action === 'pre-reserva cancelada'));
});

test('una base existente sin columnas de pre-reserva se actualiza sola', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createClient } = require('@libsql/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-cols-'));
  const url = 'file:' + path.join(dir, 'p.db');
  const db = createClient({ url });
  await db.batch([
    'CREATE TABLE concerts (id INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT NOT NULL, date TEXT NOT NULL, notes TEXT)',
    `CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, concert_id INTEGER NOT NULL, seat INTEGER NOT NULL,
      partner_id TEXT NOT NULL, reserved_by TEXT NOT NULL, guest_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (concert_id, seat))`,
    "INSERT INTO concerts (artist, date) VALUES ('Juanes', '2026-11-14')",
    "INSERT INTO reservations (concert_id, seat, partner_id, reserved_by) VALUES (1, 1, 'netmask', 'Carlos')",
  ], 'write');
  db.close();
  const s = createApp({ url }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const d = await (await fetch(`http://127.0.0.1:${s.address().port}/api/concerts/1`, { headers: { 'X-Access-Code': config.adminCode } })).json();
  s.close();
  assert.equal(d.reservations[0].status, 'confirmed');
});
