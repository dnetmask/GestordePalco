const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const config = require('./config');

function todayInBogota() {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS concerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concert_id INTEGER NOT NULL REFERENCES concerts(id) ON DELETE CASCADE,
      seat INTEGER NOT NULL,
      partner_id TEXT NOT NULL,
      reserved_by TEXT NOT NULL,
      guest_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (concert_id, seat)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL,
      partner_id TEXT,
      action TEXT NOT NULL,
      concert_id INTEGER,
      detail TEXT
    );
  `);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM concerts').get();
  if (n === 0) {
    const insert = db.prepare('INSERT INTO concerts (artist, date) VALUES (?, ?)');
    for (const c of config.concerts) insert.run(c.artist, c.date);
  }
  return db;
}

function createApp({ dbPath = path.join(__dirname, 'data', 'palco.db') } = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const partnersById = Object.fromEntries(config.partners.map((p) => [p.id, p]));
  const publicPartners = config.partners.map(({ code, ...p }) => p);

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

  function log(who, action, concertId, detail, partnerId = who.partnerId) {
    db.prepare('INSERT INTO activity (actor, partner_id, action, concert_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(who.role, partnerId ?? null, action, concertId ?? null, detail ?? null);
  }

  function getConcert(id) {
    return db.prepare('SELECT * FROM concerts WHERE id = ?').get(Number(id));
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

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

  app.get('/api/concerts', requireAuth, (req, res) => {
    const concerts = db.prepare('SELECT * FROM concerts ORDER BY date, id').all();
    const counts = db.prepare(
      'SELECT concert_id, partner_id, COUNT(*) AS n FROM reservations GROUP BY concert_id, partner_id'
    ).all();
    const byConcert = {};
    for (const r of counts) (byConcert[r.concert_id] ??= {})[r.partner_id] = r.n;
    res.json(concerts.map((c) => {
      const byPartner = byConcert[c.id] || {};
      const taken = Object.values(byPartner).reduce((a, b) => a + b, 0);
      return { ...c, byPartner, taken, free: config.seats - taken };
    }));
  });

  app.get('/api/concerts/:id', requireAuth, (req, res) => {
    const concert = getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const reservations = db.prepare(
      'SELECT id, seat, partner_id, reserved_by, guest_name, created_at FROM reservations WHERE concert_id = ? ORDER BY seat'
    ).all(concert.id);
    res.json({ ...concert, reservations });
  });

  app.post('/api/concerts/:id/reservations', requireAuth, (req, res) => {
    const concert = getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    if (concert.date < todayInBogota()) return res.status(400).json({ error: 'Este concierto ya pasó.' });

    const partnerId = req.who.role === 'admin' ? req.body?.partnerId : req.who.partnerId;
    if (!partnersById[partnerId]) return res.status(400).json({ error: 'Debes indicar a qué socio corresponde la reserva.' });

    const reservedBy = String(req.body?.reservedBy || '').trim().slice(0, 80);
    const guestName = String(req.body?.guestName || '').trim().slice(0, 120) || null;
    if (!reservedBy) return res.status(400).json({ error: 'Indica quién hace la reserva.' });

    const seats = [...new Set(Array.isArray(req.body?.seats) ? req.body.seats.map(Number) : [])];
    if (seats.length === 0) return res.status(400).json({ error: 'Selecciona al menos una silla.' });
    if (seats.some((s) => !Number.isInteger(s) || s < 1 || s > config.seats)) {
      return res.status(400).json({ error: `Las sillas van de 1 a ${config.seats}.` });
    }

    try {
      const created = transaction(() => {
        const placeholders = seats.map(() => '?').join(',');
        const clash = db.prepare(
          `SELECT seat FROM reservations WHERE concert_id = ? AND seat IN (${placeholders})`
        ).all(concert.id, ...seats);
        if (clash.length) {
          const err = new Error(`Las sillas ${clash.map((r) => r.seat).join(', ')} ya están reservadas.`);
          err.status = 409;
          throw err;
        }
        const insert = db.prepare(
          'INSERT INTO reservations (concert_id, seat, partner_id, reserved_by, guest_name) VALUES (?, ?, ?, ?, ?)'
        );
        for (const s of seats) insert.run(concert.id, s, partnerId, reservedBy, guestName);
        log(req.who, 'reserva', concert.id,
          `${reservedBy} reservó silla(s) ${seats.sort((a, b) => a - b).join(', ')}${guestName ? ` para ${guestName}` : ''}`,
          partnerId);
        return seats.length;
      });
      res.status(201).json({ ok: true, created });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'No se pudo guardar la reserva.' });
    }
  });

  app.delete('/api/reservations/:id', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (req.who.role !== 'admin' && r.partner_id !== req.who.partnerId) {
      return res.status(403).json({ error: 'Solo puedes liberar sillas reservadas por tu empresa.' });
    }
    db.prepare('DELETE FROM reservations WHERE id = ?').run(r.id);
    log(req.who, 'liberación', r.concert_id, `Silla ${r.seat} (reservada por ${r.reserved_by}) liberada`, r.partner_id);
    res.json({ ok: true });
  });

  app.get('/api/stats', requireAuth, (req, res) => {
    const today = todayInBogota();
    const rows = db.prepare(`
      SELECT r.partner_id, c.date < ? AS past, COUNT(*) AS seats, COUNT(DISTINCT r.concert_id) AS concerts
      FROM reservations r JOIN concerts c ON c.id = r.concert_id
      GROUP BY r.partner_id, past
    `).all(today);
    const totals = db.prepare(`
      SELECT partner_id, COUNT(*) AS seats, COUNT(DISTINCT concert_id) AS concerts
      FROM reservations GROUP BY partner_id
    `).all();
    const topBookers = db.prepare(`
      SELECT partner_id, reserved_by, COUNT(*) AS seats FROM reservations
      GROUP BY partner_id, reserved_by ORDER BY seats DESC LIMIT 10
    `).all();
    const { n: concertCount } = db.prepare('SELECT COUNT(*) AS n FROM concerts').get();

    const partners = publicPartners.map((p) => {
      const t = totals.find((x) => x.partner_id === p.id) || { seats: 0, concerts: 0 };
      const past = rows.find((x) => x.partner_id === p.id && x.past) || { seats: 0 };
      return { ...p, seats: t.seats, concerts: t.concerts, usedSeats: past.seats, upcomingSeats: t.seats - past.seats };
    }).sort((a, b) => b.seats - a.seats);

    const capacity = concertCount * config.seats;
    const reserved = partners.reduce((a, p) => a + p.seats, 0);
    res.json({ partners, topBookers, capacity, reserved, occupancy: capacity ? reserved / capacity : 0 });
  });

  app.get('/api/activity', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(db.prepare(`
      SELECT a.*, c.artist, c.date FROM activity a LEFT JOIN concerts c ON c.id = a.concert_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit));
  });

  // ---------- Administración de conciertos ----------

  function validConcert(body) {
    const artist = String(body?.artist || '').trim().slice(0, 120);
    const date = String(body?.date || '').trim();
    if (!artist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { artist, date, notes: String(body?.notes || '').trim().slice(0, 300) || null };
  }

  app.post('/api/concerts', requireAuth, requireAdmin, (req, res) => {
    const c = validConcert(req.body);
    if (!c) return res.status(400).json({ error: 'Artista y fecha (AAAA-MM-DD) son obligatorios.' });
    const { lastInsertRowid } = db.prepare('INSERT INTO concerts (artist, date, notes) VALUES (?, ?, ?)')
      .run(c.artist, c.date, c.notes);
    log(req.who, 'concierto creado', Number(lastInsertRowid), `${c.artist} · ${c.date}`);
    res.status(201).json({ id: Number(lastInsertRowid), ...c });
  });

  app.put('/api/concerts/:id', requireAuth, requireAdmin, (req, res) => {
    const existing = getConcert(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const c = validConcert(req.body);
    if (!c) return res.status(400).json({ error: 'Artista y fecha (AAAA-MM-DD) son obligatorios.' });
    db.prepare('UPDATE concerts SET artist = ?, date = ?, notes = ? WHERE id = ?').run(c.artist, c.date, c.notes, existing.id);
    log(req.who, 'concierto editado', existing.id, `${c.artist} · ${c.date}`);
    res.json({ id: existing.id, ...c });
  });

  app.delete('/api/concerts/:id', requireAuth, requireAdmin, (req, res) => {
    const existing = getConcert(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE concert_id = ?').get(existing.id);
    if (n > 0) return res.status(409).json({ error: 'Libera primero las sillas reservadas de este concierto.' });
    db.prepare('DELETE FROM concerts WHERE id = ?').run(existing.id);
    log(req.who, 'concierto eliminado', null, `${existing.artist} · ${existing.date}`);
    res.json({ ok: true });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp({ dbPath: process.env.DB_PATH }).listen(port, () => {
    console.log(`Gestor de Palco escuchando en http://localhost:${port}`);
  });
}

module.exports = { createApp };
