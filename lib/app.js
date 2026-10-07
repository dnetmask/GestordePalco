const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const express = require('express');
const config = require('../config');

function todayInBogota() {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// En Vercel se usa Turso (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN); en local, un archivo SQLite.
function connect({ url, authToken } = {}) {
  url ||= process.env.TURSO_DATABASE_URL;
  authToken ||= process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    if (process.env.VERCEL) throw new Error('Falta configurar TURSO_DATABASE_URL en Vercel.');
    const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'palco.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    url = 'file:' + file;
  }
  return createClient({ url, authToken });
}

async function migrate(db) {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS concerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concert_id INTEGER NOT NULL REFERENCES concerts(id) ON DELETE CASCADE,
      seat INTEGER NOT NULL,
      partner_id TEXT NOT NULL,
      reserved_by TEXT NOT NULL,
      guest_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (concert_id, seat)
    )`,
    `CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL,
      partner_id TEXT,
      action TEXT NOT NULL,
      concert_id INTEGER,
      detail TEXT
    )`,
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY)',
  ], 'write');
  // Cada concierto de config.js se carga una sola vez por base de datos: los nuevos se agregan
  // solos al desplegar y los que el administrador elimine no vuelven a aparecer.
  for (const c of config.concerts) {
    const key = `concert:${c.artist}|${c.date}`;
    const { rowsAffected } = await db.execute({ sql: 'INSERT OR IGNORE INTO meta (key) VALUES (?)', args: [key] });
    if (rowsAffected === 1) {
      await db.execute({
        sql: 'INSERT INTO concerts (artist, date) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM concerts WHERE artist = ? AND date = ?)',
        args: [c.artist, c.date, c.artist, c.date],
      });
    }
  }
}

function createApp(dbOptions) {
  let db;
  let ready;
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', async (req, res, next) => {
    if (req.path === '/info' || req.path === '/auth') return next();
    try {
      db ||= connect(dbOptions);
      ready ||= migrate(db).catch((err) => { ready = null; throw err; });
      await ready;
    } catch (err) {
      console.error(err.message);
      return res.status(503).json({ error: 'La base de datos no está configurada o no responde. ' + err.message });
    }
    next();
  });

  const partnersById = Object.fromEntries(config.partners.map((p) => [p.id, p]));
  const publicPartners = config.partners.map(({ code, ...p }) => p);

  const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
  const get = async (sql, args = []) => (await all(sql, args))[0];

  function identify(code) {
    if (!code) return null;
    if (safeEqual(code, config.adminCode)) return { role: 'admin' };
    const partner = config.partners.find((p) => safeEqual(code, p.code));
    return partner ? { role: 'partner', partnerId: partner.id } : null;
  }

  function requireAuth(req, res, next) {
    const who = identify(req.get('x-access-code'));
    if (!who) return res.status(401).json({ error: 'Código de acceso inválido.' });
    req.who = who;
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.who.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede hacer esto.' });
    next();
  }

  function logStmt(who, action, concertId, detail, partnerId = who.partnerId) {
    return {
      sql: 'INSERT INTO activity (actor, partner_id, action, concert_id, detail) VALUES (?, ?, ?, ?, ?)',
      args: [who.role, partnerId ?? null, action, concertId ?? null, detail ?? null],
    };
  }

  const getConcert = (id) => get('SELECT * FROM concerts WHERE id = ?', [Number(id) || 0]);

  // ---------- Públicos ----------

  app.get('/api/info', (req, res) => {
    res.json({ palcoName: config.palcoName, seats: config.seats, partners: publicPartners, today: todayInBogota() });
  });

  app.post('/api/auth', (req, res) => {
    const who = identify(req.body?.code);
    if (!who) return res.status(401).json({ error: 'Código de acceso inválido.' });
    res.json({ ...who, partner: who.partnerId ? publicPartners.find((p) => p.id === who.partnerId) : null });
  });

  // ---------- Consultas (requieren código) ----------

  app.get('/api/concerts', requireAuth, async (req, res) => {
    const [concerts, counts] = await Promise.all([
      all('SELECT * FROM concerts ORDER BY date, id'),
      all('SELECT concert_id, partner_id, COUNT(*) AS n FROM reservations GROUP BY concert_id, partner_id'),
    ]);
    const byConcert = {};
    for (const r of counts) (byConcert[r.concert_id] ??= {})[r.partner_id] = r.n;
    res.json(concerts.map((c) => {
      const byPartner = byConcert[c.id] || {};
      const taken = Object.values(byPartner).reduce((a, b) => a + b, 0);
      return { ...c, byPartner, taken, free: config.seats - taken };
    }));
  });

  app.get('/api/concerts/:id', requireAuth, async (req, res) => {
    const concert = await getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const reservations = await all(
      'SELECT id, seat, partner_id, reserved_by, guest_name, created_at FROM reservations WHERE concert_id = ? ORDER BY seat',
      [concert.id]
    );
    res.json({ ...concert, reservations });
  });

  app.post('/api/concerts/:id/reservations', requireAuth, async (req, res) => {
    const concert = await getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    if (concert.date < todayInBogota()) return res.status(400).json({ error: 'Este concierto ya pasó.' });

    const partnerId = req.who.role === 'admin' ? req.body?.partnerId : req.who.partnerId;
    if (!partnersById[partnerId]) return res.status(400).json({ error: 'Debes indicar a qué socio corresponde la reserva.' });

    const reservedBy = String(req.body?.reservedBy || '').trim().slice(0, 80);
    const guestName = String(req.body?.guestName || '').trim().slice(0, 120) || null;
    if (!reservedBy) return res.status(400).json({ error: 'Indica quién hace la reserva.' });

    const seats = [...new Set(Array.isArray(req.body?.seats) ? req.body.seats.map(Number) : [])].sort((a, b) => a - b);
    if (seats.length === 0) return res.status(400).json({ error: 'Selecciona al menos una silla.' });
    if (seats.some((s) => !Number.isInteger(s) || s < 1 || s > config.seats)) {
      return res.status(400).json({ error: `Las sillas van de 1 a ${config.seats}.` });
    }

    // El lote es atómico: si alguna silla ya está tomada (UNIQUE), no se guarda ninguna.
    try {
      await db.batch([
        ...seats.map((s) => ({
          sql: 'INSERT INTO reservations (concert_id, seat, partner_id, reserved_by, guest_name) VALUES (?, ?, ?, ?, ?)',
          args: [concert.id, s, partnerId, reservedBy, guestName],
        })),
        logStmt(req.who, 'reserva', concert.id,
          `${reservedBy} reservó silla(s) ${seats.join(', ')}${guestName ? ` para ${guestName}` : ''}`, partnerId),
      ], 'write');
    } catch (err) {
      if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
      const clash = await all(
        `SELECT seat FROM reservations WHERE concert_id = ? AND seat IN (${seats.map(() => '?').join(',')}) ORDER BY seat`,
        [concert.id, ...seats]
      );
      return res.status(409).json({ error: `Las sillas ${clash.map((r) => r.seat).join(', ')} ya están reservadas.` });
    }
    res.status(201).json({ ok: true, created: seats.length });
  });

  app.delete('/api/reservations/:id', requireAuth, async (req, res) => {
    const r = await get('SELECT * FROM reservations WHERE id = ?', [Number(req.params.id) || 0]);
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (req.who.role !== 'admin' && r.partner_id !== req.who.partnerId) {
      return res.status(403).json({ error: 'Solo puedes liberar sillas reservadas por tu empresa.' });
    }
    await db.batch([
      { sql: 'DELETE FROM reservations WHERE id = ?', args: [r.id] },
      logStmt(req.who, 'liberación', r.concert_id, `Silla ${r.seat} (reservada por ${r.reserved_by}) liberada`, r.partner_id),
    ], 'write');
    res.json({ ok: true });
  });

  app.get('/api/stats', requireAuth, async (req, res) => {
    const today = todayInBogota();
    const [rows, totals, topBookers, countRow] = await Promise.all([
      all(`
        SELECT r.partner_id, c.date < ? AS past, COUNT(*) AS seats
        FROM reservations r JOIN concerts c ON c.id = r.concert_id
        GROUP BY r.partner_id, past
      `, [today]),
      all(`
        SELECT partner_id, COUNT(*) AS seats, COUNT(DISTINCT concert_id) AS concerts
        FROM reservations GROUP BY partner_id
      `),
      all(`
        SELECT partner_id, reserved_by, COUNT(*) AS seats FROM reservations
        GROUP BY partner_id, reserved_by ORDER BY seats DESC LIMIT 10
      `),
      get('SELECT COUNT(*) AS n FROM concerts'),
    ]);

    const partners = publicPartners.map((p) => {
      const t = totals.find((x) => x.partner_id === p.id) || { seats: 0, concerts: 0 };
      const past = rows.find((x) => x.partner_id === p.id && x.past) || { seats: 0 };
      return { ...p, seats: t.seats, concerts: t.concerts, usedSeats: past.seats, upcomingSeats: t.seats - past.seats };
    }).sort((a, b) => b.seats - a.seats);

    const capacity = countRow.n * config.seats;
    const reserved = partners.reduce((a, p) => a + p.seats, 0);
    res.json({ partners, topBookers, capacity, reserved, occupancy: capacity ? reserved / capacity : 0 });
  });

  app.get('/api/activity', requireAuth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await all(`
      SELECT a.*, c.artist, c.date FROM activity a LEFT JOIN concerts c ON c.id = a.concert_id
      ORDER BY a.id DESC LIMIT ?
    `, [limit]));
  });

  // ---------- Administración de conciertos ----------

  function validConcert(body) {
    const artist = String(body?.artist || '').trim().slice(0, 120);
    const date = String(body?.date || '').trim();
    if (!artist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { artist, date, notes: String(body?.notes || '').trim().slice(0, 300) || null };
  }

  app.post('/api/concerts', requireAuth, requireAdmin, async (req, res) => {
    const c = validConcert(req.body);
    if (!c) return res.status(400).json({ error: 'Artista y fecha (AAAA-MM-DD) son obligatorios.' });
    const { lastInsertRowid } = await db.execute({
      sql: 'INSERT INTO concerts (artist, date, notes) VALUES (?, ?, ?)',
      args: [c.artist, c.date, c.notes],
    });
    const id = Number(lastInsertRowid);
    await db.execute(logStmt(req.who, 'concierto creado', id, `${c.artist} · ${c.date}`));
    res.status(201).json({ id, ...c });
  });

  app.put('/api/concerts/:id', requireAuth, requireAdmin, async (req, res) => {
    const existing = await getConcert(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const c = validConcert(req.body);
    if (!c) return res.status(400).json({ error: 'Artista y fecha (AAAA-MM-DD) son obligatorios.' });
    await db.batch([
      { sql: 'UPDATE concerts SET artist = ?, date = ?, notes = ? WHERE id = ?', args: [c.artist, c.date, c.notes, existing.id] },
      logStmt(req.who, 'concierto editado', existing.id, `${c.artist} · ${c.date}`),
    ], 'write');
    res.json({ id: existing.id, ...c });
  });

  app.delete('/api/concerts/:id', requireAuth, requireAdmin, async (req, res) => {
    const existing = await getConcert(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const { n } = await get('SELECT COUNT(*) AS n FROM reservations WHERE concert_id = ?', [existing.id]);
    if (n > 0) return res.status(409).json({ error: 'Libera primero las sillas reservadas de este concierto.' });
    await db.batch([
      { sql: 'DELETE FROM concerts WHERE id = ?', args: [existing.id] },
      logStmt(req.who, 'concierto eliminado', null, `${existing.artist} · ${existing.date}`),
    ], 'write');
    res.json({ ok: true });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor. Intenta de nuevo.' });
  });

  return app;
}

module.exports = { createApp };
