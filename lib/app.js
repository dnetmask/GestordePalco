const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const express = require('express');
const config = require('../config');

function todayInColombia() {
  // Hora de Colombia (America/Bogota es la zona horaria IANA de todo el país, Medellín incluido).
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
      status TEXT NOT NULL DEFAULT 'confirmed',
      request_id TEXT,
      decided_by TEXT,
      decided_at TEXT,
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
    `CREATE TABLE IF NOT EXISTS partner_logos (
      partner_id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      bg TEXT NOT NULL DEFAULT 'light',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ], 'write');

  // Columnas de pre-reserva para bases creadas antes de existir el límite por socio.
  const cols = (await db.execute('PRAGMA table_info(reservations)')).rows.map((r) => r.name);
  for (const [name, def] of [['status', "TEXT NOT NULL DEFAULT 'confirmed'"], ['request_id', 'TEXT'], ['decided_by', 'TEXT'], ['decided_at', 'TEXT']]) {
    if (!cols.includes(name)) await db.execute(`ALTER TABLE reservations ADD COLUMN ${name} ${def}`);
  }

  // Correcciones de fecha: mueven un concierto ya cargado (con sus reservas) a su nueva fecha,
  // una sola vez, antes de la carga para que no se cree un duplicado.
  for (const f of config.dateFixes || []) {
    const key = `fix:${f.artist}|${f.from}>${f.to}`;
    const { rowsAffected } = await db.execute({ sql: 'INSERT OR IGNORE INTO meta (key) VALUES (?)', args: [key] });
    if (rowsAffected === 1) {
      await db.execute({ sql: 'UPDATE concerts SET date = ? WHERE artist = ? AND date = ?', args: [f.to, f.artist, f.from] });
    }
  }

  // Conciertos retirados con force: se eliminan una sola vez junto con sus reservas (acordado con los
  // socios); el historial guarda qué sillas tenía cada uno y quién las había reservado.
  for (const r of (config.removed || []).filter((x) => x.force)) {
    const key = `removed-force:${r.artist}|${r.date}`;
    const { rowsAffected } = await db.execute({ sql: 'INSERT OR IGNORE INTO meta (key) VALUES (?)', args: [key] });
    if (rowsAffected !== 1) continue;
    const concerts = (await db.execute({ sql: 'SELECT id FROM concerts WHERE artist = ? AND date = ?', args: [r.artist, r.date] })).rows;
    for (const c of concerts) {
      const res = (await db.execute({ sql: 'SELECT seat, partner_id, reserved_by FROM reservations WHERE concert_id = ? ORDER BY seat', args: [c.id] })).rows;
      const byPartner = {};
      for (const x of res) (byPartner[x.partner_id] ??= []).push(x);
      await db.batch([
        ...Object.entries(byPartner).map(([partnerId, list]) => ({
          sql: 'INSERT INTO activity (actor, partner_id, action, concert_id, detail) VALUES (?, ?, ?, ?, ?)',
          args: ['admin', partnerId, 'concierto retirado', null,
            `${r.artist} · ${r.date}: se liberaron ${list.length} silla(s) (${list.map((x) => `${config.seatLabel(x.seat)} de ${x.reserved_by}`).join(', ')})`],
        })),
        { sql: 'DELETE FROM reservations WHERE concert_id = ?', args: [c.id] },
        { sql: 'DELETE FROM concerts WHERE id = ?', args: [c.id] },
      ], 'write');
    }
  }

  // Conciertos retirados: se eliminan una sola vez, y solo si nadie tiene sillas reservadas en ellos.
  for (const r of config.removed || []) {
    const key = `removed:${r.artist}|${r.date}`;
    const { rowsAffected } = await db.execute({ sql: 'INSERT OR IGNORE INTO meta (key) VALUES (?)', args: [key] });
    if (rowsAffected === 1) {
      await db.execute({
        sql: `DELETE FROM concerts WHERE artist = ? AND date = ?
              AND NOT EXISTS (SELECT 1 FROM reservations WHERE reservations.concert_id = concerts.id)`,
        args: [r.artist, r.date],
      });
    }
  }

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
  app.use(express.json({ limit: '1mb' }));
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

  // Cartelera pública para clientes: conciertos próximos y qué sillas están libres u ocupadas.
  // No expone socios, nombres ni ids de reserva.
  app.get('/api/public/agenda', async (req, res) => {
    const today = todayInColombia();
    const [concerts, taken] = await Promise.all([
      all('SELECT id, artist, date FROM concerts WHERE date >= ? ORDER BY date, id', [today]),
      all('SELECT r.concert_id, r.seat FROM reservations r JOIN concerts c ON c.id = r.concert_id WHERE c.date >= ?', [today]),
    ]);
    const byConcert = {};
    for (const t of taken) (byConcert[t.concert_id] ??= new Set()).add(t.seat);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      palcoName: config.palcoName,
      layout: config.layout.map(({ row, seats, start }) => ({ row, seats, start })),
      concerts: concerts.map((c) => {
        const occupied = [...(byConcert[c.id] || [])].sort((a, b) => a - b);
        return { id: c.id, artist: c.artist, date: c.date, occupied, free: config.seats - occupied.length };
      }),
    });
  });

  app.get('/api/info', (req, res) => {
    res.json({ palcoName: config.palcoName, seats: config.seats, layout: config.layout, partners: publicPartners, maxSeatsPerPartner: config.maxSeatsPerPartner, today: todayInColombia() });
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
      all(`SELECT concert_id, partner_id, COUNT(*) AS n, SUM(status = 'pending') AS pending
           FROM reservations GROUP BY concert_id, partner_id`),
    ]);
    const byConcert = {};
    const pendingBy = {};
    for (const r of counts) {
      (byConcert[r.concert_id] ??= {})[r.partner_id] = r.n;
      pendingBy[r.concert_id] = (pendingBy[r.concert_id] || 0) + Number(r.pending || 0);
    }
    res.json(concerts.map((c) => {
      const byPartner = byConcert[c.id] || {};
      const taken = Object.values(byPartner).reduce((a, b) => a + b, 0);
      return { ...c, byPartner, taken, free: config.seats - taken, pending: pendingBy[c.id] || 0 };
    }));
  });

  app.get('/api/concerts/:id', requireAuth, async (req, res) => {
    const concert = await getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    const reservations = await all(
      'SELECT id, seat, partner_id, reserved_by, guest_name, created_at, status, request_id FROM reservations WHERE concert_id = ? ORDER BY seat',
      [concert.id]
    );
    res.json({ ...concert, reservations });
  });

  app.post('/api/concerts/:id/reservations', requireAuth, async (req, res) => {
    const concert = await getConcert(req.params.id);
    if (!concert) return res.status(404).json({ error: 'Concierto no encontrado.' });
    if (concert.date < todayInColombia()) return res.status(400).json({ error: 'Este concierto ya pasó.' });

    const partnerId = req.who.role === 'admin' ? req.body?.partnerId : req.who.partnerId;
    if (!partnersById[partnerId]) return res.status(400).json({ error: 'Debes indicar a qué socio corresponde la reserva.' });

    const reservedBy = String(req.body?.reservedBy || '').trim().slice(0, 80);
    const guestName = String(req.body?.guestName || '').trim().slice(0, 120) || null;
    if (!reservedBy) return res.status(400).json({ error: 'Indica quién hace la reserva.' });

    const seats = [...new Set(Array.isArray(req.body?.seats) ? req.body.seats.map(Number) : [])].sort((a, b) => a - b);
    if (seats.length === 0) return res.status(400).json({ error: 'Selecciona al menos una silla.' });
    if (seats.some((s) => !Number.isInteger(s) || s < 1 || s > config.seats)) {
      return res.status(400).json({ error: 'Silla inválida.' });
    }

    // Límite por socio: se confirman las sillas hasta completar el máximo; el resto queda en pre-reserva
    // (la silla queda apartada) hasta que otro socio la apruebe. El administrador no tiene límite.
    let confirmed = seats;
    let pending = [];
    if (req.who.role !== 'admin') {
      const { n } = await get(
        "SELECT COUNT(*) AS n FROM reservations WHERE concert_id = ? AND partner_id = ? AND status = 'confirmed'",
        [concert.id, partnerId]
      );
      const room = Math.max(0, config.maxSeatsPerPartner - Number(n));
      confirmed = seats.slice(0, room);
      pending = seats.slice(room);
    }
    const requestId = pending.length ? crypto.randomUUID() : null;
    const forWhom = guestName ? ` para ${guestName}` : '';

    // El lote es atómico: si alguna silla ya está tomada (UNIQUE), no se guarda ninguna.
    try {
      await db.batch([
        ...confirmed.map((s) => ({
          sql: 'INSERT INTO reservations (concert_id, seat, partner_id, reserved_by, guest_name) VALUES (?, ?, ?, ?, ?)',
          args: [concert.id, s, partnerId, reservedBy, guestName],
        })),
        ...pending.map((s) => ({
          sql: "INSERT INTO reservations (concert_id, seat, partner_id, reserved_by, guest_name, status, request_id) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
          args: [concert.id, s, partnerId, reservedBy, guestName, requestId],
        })),
        ...(confirmed.length ? [logStmt(req.who, 'reserva', concert.id,
          `${reservedBy} reservó silla(s) ${confirmed.map(config.seatLabel).join(', ')}${forWhom}`, partnerId)] : []),
        ...(pending.length ? [logStmt(req.who, 'pre-reserva', concert.id,
          `${reservedBy} pre-reservó silla(s) ${pending.map(config.seatLabel).join(', ')}${forWhom}; espera aprobación de otro socio`, partnerId)] : []),
      ], 'write');
    } catch (err) {
      if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
      const clash = await all(
        `SELECT seat FROM reservations WHERE concert_id = ? AND seat IN (${seats.map(() => '?').join(',')}) ORDER BY seat`,
        [concert.id, ...seats]
      );
      return res.status(409).json({ error: `Las sillas ${clash.map((r) => config.seatLabel(r.seat)).join(', ')} ya están reservadas.` });
    }
    res.status(201).json({
      ok: true,
      created: seats.length,
      confirmed: confirmed.map(config.seatLabel),
      pending: pending.map(config.seatLabel),
      requestId,
      limit: config.maxSeatsPerPartner,
    });
  });

  app.delete('/api/reservations/:id', requireAuth, async (req, res) => {
    const r = await get('SELECT * FROM reservations WHERE id = ?', [Number(req.params.id) || 0]);
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (req.who.role !== 'admin' && r.partner_id !== req.who.partnerId) {
      return res.status(403).json({ error: 'Solo puedes liberar sillas reservadas por tu empresa.' });
    }
    await db.batch([
      { sql: 'DELETE FROM reservations WHERE id = ?', args: [r.id] },
      logStmt(req.who, 'liberación', r.concert_id,
        `Silla ${config.seatLabel(r.seat)} (${r.status === 'pending' ? 'pre-reservada' : 'reservada'} por ${r.reserved_by}) liberada`, r.partner_id),
    ], 'write');
    res.json({ ok: true });
  });

  app.get('/api/stats', requireAuth, async (req, res) => {
    const today = todayInColombia();
    const [rows, totals, topBookers, countRow] = await Promise.all([
      all(`
        SELECT r.partner_id, c.date < ? AS past, COUNT(*) AS seats
        FROM reservations r JOIN concerts c ON c.id = r.concert_id
        WHERE r.status = 'confirmed'
        GROUP BY r.partner_id, past
      `, [today]),
      all(`
        SELECT partner_id, COUNT(*) AS seats, COUNT(DISTINCT concert_id) AS concerts
        FROM reservations WHERE status = 'confirmed' GROUP BY partner_id
      `),
      all(`
        SELECT partner_id, reserved_by, COUNT(*) AS seats FROM reservations
        WHERE status = 'confirmed'
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

  // ---------- Pre-reservas y aprobaciones ----------

  // Solicitudes pendientes en conciertos próximos. Cada socio ve todas: las suyas (para cancelarlas) y
  // las de los otros (para aprobarlas o rechazarlas).
  app.get('/api/requests', requireAuth, async (req, res) => {
    const rows = await all(`
      SELECT r.request_id, r.seat, r.partner_id, r.reserved_by, r.guest_name, r.created_at,
             c.id AS concert_id, c.artist, c.date
      FROM reservations r JOIN concerts c ON c.id = r.concert_id
      WHERE r.status = 'pending' AND c.date >= ?
      ORDER BY c.date, r.created_at, r.seat
    `, [todayInColombia()]);
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.request_id)) {
        groups.set(r.request_id, {
          requestId: r.request_id, concertId: r.concert_id, artist: r.artist, date: r.date,
          partnerId: r.partner_id, reservedBy: r.reserved_by, guestName: r.guest_name, createdAt: r.created_at, seats: [],
        });
      }
      groups.get(r.request_id).seats.push(config.seatLabel(r.seat));
    }
    const isAdmin = req.who.role === 'admin';
    res.json([...groups.values()].map((g) => {
      const mine = g.partnerId === req.who.partnerId;
      return { ...g, mine, canDecide: isAdmin || !mine };
    }));
  });

  async function pendingRequest(requestId) {
    return all("SELECT * FROM reservations WHERE request_id = ? AND status = 'pending' ORDER BY seat", [String(requestId)]);
  }

  // Aprobar: basta con uno de los otros dos socios (o el administrador). Quien la pidió no puede aprobarla.
  app.post('/api/requests/:rid/approve', requireAuth, async (req, res) => {
    const seats = await pendingRequest(req.params.rid);
    if (!seats.length) return res.status(404).json({ error: 'La pre-reserva ya no está pendiente.' });
    const owner = seats[0].partner_id;
    if (req.who.role !== 'admin' && req.who.partnerId === owner) {
      return res.status(403).json({ error: 'La aprobación debe darla uno de los otros socios.' });
    }
    const approver = req.who.role === 'admin' ? 'admin' : req.who.partnerId;
    const by = (req.body?.decidedBy && String(req.body.decidedBy).trim().slice(0, 80)) || null;
    await db.batch([
      {
        sql: "UPDATE reservations SET status = 'confirmed', decided_by = ?, decided_at = datetime('now') WHERE request_id = ? AND status = 'pending'",
        args: [approver, seats[0].request_id],
      },
      logStmt(req.who, 'aprobación', seats[0].concert_id,
        `${partnersById[approver]?.name || 'Administrador'}${by ? ` (${by})` : ''} aprobó la pre-reserva de ${partnersById[owner].name}: silla(s) ${seats.map((x) => config.seatLabel(x.seat)).join(', ')} de ${seats[0].reserved_by}`,
        owner),
    ], 'write');
    res.json({ ok: true });
  });

  // Rechazar (otro socio o administrador) o cancelar (el mismo socio): libera las sillas.
  app.post('/api/requests/:rid/reject', requireAuth, async (req, res) => {
    const seats = await pendingRequest(req.params.rid);
    if (!seats.length) return res.status(404).json({ error: 'La pre-reserva ya no está pendiente.' });
    const owner = seats[0].partner_id;
    const own = req.who.role !== 'admin' && req.who.partnerId === owner;
    const actor = req.who.role === 'admin' ? 'Administrador' : partnersById[req.who.partnerId].name;
    const by = (req.body?.decidedBy && String(req.body.decidedBy).trim().slice(0, 80)) || null;
    const list = seats.map((x) => config.seatLabel(x.seat)).join(', ');
    await db.batch([
      { sql: "DELETE FROM reservations WHERE request_id = ? AND status = 'pending'", args: [seats[0].request_id] },
      logStmt(req.who, own ? 'pre-reserva cancelada' : 'rechazo', seats[0].concert_id,
        own
          ? `${seats[0].reserved_by} canceló su pre-reserva: silla(s) ${list}`
          : `${actor}${by ? ` (${by})` : ''} rechazó la pre-reserva de ${partnersById[owner].name}: silla(s) ${list} de ${seats[0].reserved_by}`,
        owner),
    ], 'write');
    res.json({ ok: true });
  });

  // ---------- Invitaciones ----------

  // Sillas reservadas en conciertos próximos: las de tu empresa (o todas, si eres administrador).
  app.get('/api/invitations', requireAuth, async (req, res) => {
    const isAdmin = req.who.role === 'admin';
    const rows = await all(`
      SELECT r.id, r.seat, r.partner_id, r.reserved_by, r.guest_name, c.id AS concert_id, c.artist, c.date
      FROM reservations r JOIN concerts c ON c.id = r.concert_id
      WHERE c.date >= ? AND r.status = 'confirmed' ${isAdmin ? '' : 'AND r.partner_id = ?'}
      ORDER BY c.date, c.id, r.seat
    `, isAdmin ? [todayInColombia()] : [todayInColombia(), req.who.partnerId]);
    res.json(rows.map((r) => ({ ...r, seatLabel: config.seatLabel(r.seat) })));
  });

  // ---------- Logos de los socios ----------

  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

  app.get('/api/logos', async (req, res) => {
    // { partnerId: { url, bg } } — bg indica si el logo va sobre fondo claro u oscuro.
    const uploaded = await all('SELECT partner_id, bg, updated_at FROM partner_logos');
    res.json(Object.fromEntries(config.partners.map((p) => {
      const u = uploaded.find((x) => x.partner_id === p.id);
      if (u) return [p.id, { url: `/api/logos/${p.id}?v=${encodeURIComponent(u.updated_at)}`, bg: u.bg }];
      return [p.id, p.logo ? { url: p.logo, bg: p.logoBg || 'light' } : null];
    })));
  });

  app.get('/api/logos/:id', async (req, res) => {
    const logo = await get('SELECT mime, data FROM partner_logos WHERE partner_id = ?', [req.params.id]);
    if (!logo) return res.status(404).json({ error: 'Sin logo.' });
    // Un SVG subido no debe poder ejecutar nada si se abre directamente.
    res.set({
      'Content-Type': logo.mime,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    });
    res.send(Buffer.from(logo.data, 'base64'));
  });

  app.put('/api/logos/:id', requireAuth, requireAdmin, async (req, res) => {
    if (!partnersById[req.params.id]) return res.status(404).json({ error: 'Socio no encontrado.' });
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
    if (!m || !LOGO_TYPES.includes(m[1])) return res.status(400).json({ error: 'Sube una imagen PNG, JPG, WEBP o SVG.' });
    if (m[2].length > 700_000) return res.status(400).json({ error: 'El logo debe pesar menos de 500 KB.' });
    await db.batch([
      {
        sql: `INSERT INTO partner_logos (partner_id, mime, data, bg, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT (partner_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, bg = excluded.bg,
              updated_at = excluded.updated_at`,
        args: [req.params.id, m[1], m[2], req.body?.bg === 'dark' ? 'dark' : 'light'],
      },
      logStmt(req.who, 'logo actualizado', null, partnersById[req.params.id].name, req.params.id),
    ], 'write');
    res.json({ ok: true });
  });

  app.patch('/api/logos/:id', requireAuth, requireAdmin, async (req, res) => {
    const { rowsAffected } = await db.execute({
      sql: 'UPDATE partner_logos SET bg = ? WHERE partner_id = ?',
      args: [req.body?.bg === 'dark' ? 'dark' : 'light', req.params.id],
    });
    if (!rowsAffected) return res.status(404).json({ error: 'Sube primero el logo.' });
    res.json({ ok: true });
  });

  app.delete('/api/logos/:id', requireAuth, requireAdmin, async (req, res) => {
    await db.execute({ sql: 'DELETE FROM partner_logos WHERE partner_id = ?', args: [req.params.id] });
    res.json({ ok: true });
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
