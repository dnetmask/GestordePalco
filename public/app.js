const $ = (sel) => document.querySelector(sel);
const state = {
  code: null,
  who: null,          // { role, partnerId, partner }
  info: null,         // { palcoName, seats, partners, today }
  concerts: [],
  selectedConcertId: null,
  detail: null,
  selectedSeats: new Set(),
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const partner = (id) => state.info.partners.find((p) => p.id === id) || { short: id, name: id, color: '#999' };
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTs = (ts) => new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
const isPast = (c) => c.date < state.info.today;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Access-Code': state.code || '', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.who) logout();
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- Acceso ----------

async function login(code) {
  const who = await api('/api/auth', { method: 'POST', body: { code } });
  state.code = code;
  state.who = who;
  store.set('palco.code', code);
  $('#login').hidden = true;
  $('#app').hidden = false;
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = who.role !== 'admin'));
  $('#whoami').innerHTML = who.role === 'admin'
    ? 'Administrador'
    : `<span class="dot" style="background:${who.partner.color}"></span>${esc(who.partner.name)}`;
  await loadConcerts();
  const first = state.concerts.find((c) => !isPast(c)) || state.concerts[0];
  if (first) selectConcert(first.id);
}

function logout() {
  state.code = null;
  state.who = null;
  store.set('palco.code', null);
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#code').value = '';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    await login($('#code').value.trim());
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});
$('#logout').addEventListener('click', logout);

// ---------- Navegación ----------

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

function showView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  if (view === 'stats') loadStats();
  if (view === 'historial') loadActivity();
  if (view === 'admin') renderAdmin();
}

// ---------- Conciertos y palco ----------

async function loadConcerts() {
  state.concerts = await api('/api/concerts');
  renderConcertList();
}

function occupancyBar(c) {
  const seats = state.info.seats;
  return '<div class="bar">' + state.info.partners
    .map((p) => `<span style="width:${((c.byPartner[p.id] || 0) / seats) * 100}%;background:${p.color}"></span>`)
    .join('') + '</div>';
}

function renderConcertList() {
  const showPast = $('#show-past').checked;
  $('#concert-list').innerHTML = state.concerts
    .filter((c) => showPast || !isPast(c) || c.id === state.selectedConcertId)
    .map((c) => `
      <li><button class="concert-item ${c.id === state.selectedConcertId ? 'selected' : ''} ${isPast(c) ? 'past' : ''}" data-id="${c.id}">
        <span class="artist">${esc(c.artist)}</span>
        <span class="date">${fmtDate(c.date)}</span>
        <span class="bar">${occupancyBar(c)}</span>
        <span class="date">${c.free} de ${state.info.seats} libres</span>
      </button></li>`)
    .join('') || '<li class="empty">No hay conciertos próximos.</li>';
  document.querySelector('.concert-item.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.querySelectorAll('.concert-item').forEach((b) => b.addEventListener('click', () => selectConcert(Number(b.dataset.id))));
}
$('#show-past').addEventListener('change', renderConcertList);

async function selectConcert(id) {
  state.selectedConcertId = id;
  state.selectedSeats.clear();
  renderConcertList();
  state.detail = await api('/api/concerts/' + id);
  renderPalco();
}

function renderPalco() {
  const c = state.detail;
  const past = isPast(c);
  const bySeat = Object.fromEntries(c.reservations.map((r) => [r.seat, r]));
  const isAdmin = state.who.role === 'admin';

  const seats = [];
  for (let n = 1; n <= state.info.seats; n++) {
    const r = bySeat[n];
    if (r) {
      const p = partner(r.partner_id);
      const mine = isAdmin || r.partner_id === state.who.partnerId;
      seats.push(`<button class="seat taken ${mine && !past ? 'mine' : ''}" data-res="${r.id}" style="background:${p.color};border-color:${p.color}"
        title="${esc(`${p.short} · reservó ${r.reserved_by}${r.guest_name ? ' · asiste ' + r.guest_name : ''}`)}${mine && !past ? ' — clic para liberar' : ''}">
        <span class="num">${n}</span><span class="tag">${esc(p.short)}</span><span class="guest">${esc(r.guest_name || r.reserved_by)}</span></button>`);
    } else {
      const sel = state.selectedSeats.has(n);
      seats.push(`<button class="seat free ${sel ? 'selected' : ''}" data-seat="${n}" ${past ? 'disabled' : ''}>
        <span class="num">${n}</span><span>${sel ? 'Seleccionada' : 'Libre'}</span></button>`);
    }
  }

  const savedName = store.get('palco.reservedBy') || '';
  const partnerSelect = isAdmin
    ? `<label>Socio<select id="rf-partner">${state.info.partners.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`
    : '';

  $('#palco').innerHTML = `
    <div class="palco-head">
      <h2>${esc(c.artist)}</h2>
      <span class="date">${new Date(c.date + 'T12:00:00').toLocaleDateString('es-CO', { dateStyle: 'full' })}</span>
    </div>
    ${c.notes ? `<p>${esc(c.notes)}</p>` : ''}
    <div class="stage">ESCENARIO</div>
    <div class="seats">${seats.join('')}</div>
    <div class="legend">
      ${state.info.partners.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')}
      <span><i style="border:2px dashed var(--muted)"></i>Libre</span>
    </div>
    ${past ? '<p class="empty">Este concierto ya pasó; las reservas quedan como registro.</p>' : `
    <form class="reserve-form" id="reserve-form">
      <p class="reserve-summary" id="rf-summary"></p>
      ${partnerSelect}
      <label>Quién reserva<input id="rf-by" required maxlength="80" placeholder="Tu nombre" value="${esc(savedName)}"></label>
      <label>A nombre de / invitado (opcional)<input id="rf-guest" maxlength="120" placeholder="Ej. Cliente ACME"></label>
      <button class="btn" id="rf-submit" type="submit">Reservar</button>
    </form>`}
  `;

  document.querySelectorAll('.seat.free').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.seat);
    state.selectedSeats.has(n) ? state.selectedSeats.delete(n) : state.selectedSeats.add(n);
    const keep = { by: $('#rf-by')?.value, guest: $('#rf-guest')?.value, partner: $('#rf-partner')?.value };
    renderPalco();
    if (keep.by != null) $('#rf-by').value = keep.by;
    if (keep.guest != null) $('#rf-guest').value = keep.guest;
    if (keep.partner && $('#rf-partner')) $('#rf-partner').value = keep.partner;
  }));
  document.querySelectorAll('.seat.taken.mine').forEach((b) => b.addEventListener('click', () => release(Number(b.dataset.res))));

  const form = $('#reserve-form');
  if (form) {
    updateSummary();
    form.addEventListener('submit', reserve);
  }
}

function updateSummary() {
  const n = state.selectedSeats.size;
  $('#rf-summary').textContent = n
    ? `Sillas seleccionadas: ${[...state.selectedSeats].sort((a, b) => a - b).join(', ')}`
    : 'Haz clic en las sillas libres que necesitas.';
  $('#rf-submit').disabled = n === 0;
  $('#rf-submit').textContent = n ? `Reservar ${n} silla${n > 1 ? 's' : ''}` : 'Reservar';
}

async function reserve(e) {
  e.preventDefault();
  const reservedBy = $('#rf-by').value.trim();
  try {
    await api(`/api/concerts/${state.selectedConcertId}/reservations`, {
      method: 'POST',
      body: {
        seats: [...state.selectedSeats],
        reservedBy,
        guestName: $('#rf-guest').value.trim(),
        partnerId: $('#rf-partner')?.value,
      },
    });
    store.set('palco.reservedBy', reservedBy);
    toast('¡Reserva confirmada!');
  } catch (err) {
    toast(err.message, true);
  }
  await refresh();
}

async function release(resId) {
  const r = state.detail.reservations.find((x) => x.id === resId);
  if (!confirm(`¿Liberar la silla ${r.seat} reservada por ${r.reserved_by}?`)) return;
  try {
    await api('/api/reservations/' + resId, { method: 'DELETE' });
    toast('Silla liberada');
  } catch (err) {
    toast(err.message, true);
  }
  await refresh();
}

async function refresh() {
  await loadConcerts();
  if (state.selectedConcertId) await selectConcert(state.selectedConcertId);
}

// ---------- Estadísticas ----------

async function loadStats() {
  const s = await api('/api/stats');
  const max = Math.max(1, ...s.partners.map((p) => p.seats));
  const leader = s.partners[0]?.seats > 0 && s.partners[0].seats !== s.partners[1]?.seats ? s.partners[0].id : null;
  const nextConcerts = state.concerts.filter((c) => !isPast(c));
  const upcomingFree = nextConcerts.reduce((a, c) => a + c.free, 0);

  $('#view-stats').innerHTML = `
    <div class="card kpi"><div class="value">${s.reserved}</div><div class="label">sillas reservadas en la temporada (de ${s.capacity})</div></div>
    <div class="card kpi"><div class="value">${Math.round(s.occupancy * 100)}%</div><div class="label">ocupación del palco</div></div>
    <div class="card kpi"><div class="value">${upcomingFree}</div><div class="label">sillas libres en ${nextConcerts.length} conciertos próximos</div></div>

    <div class="card span-2">
      <h2>¿Quién reserva más?</h2>
      <div class="rank">
        ${s.partners.map((p) => `
          <div class="rank-row">
            <div class="top"><span>${p.id === leader ? '<span class="crown">♛</span> ' : ''}${esc(p.name)}</span><span>${p.seats} silla${p.seats === 1 ? '' : 's'} · ${s.reserved ? Math.round((p.seats / s.reserved) * 100) : 0}%</span></div>
            <div class="meter"><span style="width:${(p.seats / max) * 100}%;background:${p.color}"></span></div>
            <div class="sub">${p.concerts} concierto${p.concerts === 1 ? '' : 's'} · ${p.usedSeats} sillas ya usadas · ${p.upcomingSeats} por venir</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Personas que más reservan</h2>
      <table class="table"><tbody>
        ${s.topBookers.map((b) => `<tr><td><span class="dot" style="background:${partner(b.partner_id).color}"></span> ${esc(b.reserved_by)}</td><td>${esc(partner(b.partner_id).short)}</td><td>${b.seats}</td></tr>`).join('') || '<tr><td>Aún no hay reservas.</td></tr>'}
      </tbody></table>
    </div>

    <div class="card span-2-lg">
      <h2>Por concierto</h2>
      <table class="table"><tbody>
        ${state.concerts.map((c) => `<tr><td>${esc(c.artist)}</td><td style="min-width:110px">${occupancyBar(c)}</td><td>${c.taken}/${state.info.seats}</td></tr>`).join('')}
      </tbody></table>
    </div>
  `;
}

// ---------- Historial ----------

async function loadActivity() {
  const rows = await api('/api/activity?limit=100');
  $('#activity').innerHTML = rows.map((a) => {
    const p = a.partner_id ? partner(a.partner_id) : null;
    return `<tr>
      <td>${fmtTs(a.ts)}</td>
      <td>${p ? `<span class="dot" style="background:${p.color}"></span> ${esc(p.short)}` : '—'}${a.actor === 'admin' ? ' <small>(admin)</small>' : ''}</td>
      <td>${esc(a.action)}</td>
      <td>${a.artist ? esc(a.artist) : '—'}</td>
      <td>${esc(a.detail)}</td></tr>`;
  }).join('') || '<tr><td colspan="5">Sin movimientos todavía.</td></tr>';
}

// ---------- Administración ----------

function renderAdmin() {
  $('#admin-concerts').innerHTML = state.concerts.map((c) => `
    <tr>
      <td>${c.date}</td><td>${esc(c.artist)}</td><td>${esc(c.notes || '')}</td><td>${c.taken}/${state.info.seats}</td>
      <td><button class="link" data-edit="${c.id}">Editar</button><button class="link" data-del="${c.id}">Eliminar</button></td>
    </tr>`).join('');
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const c = state.concerts.find((x) => x.id === Number(b.dataset.edit));
    $('#cf-id').value = c.id;
    $('#cf-artist').value = c.artist;
    $('#cf-date').value = c.date;
    $('#cf-notes').value = c.notes || '';
    $('#cf-submit').textContent = 'Guardar';
    $('#cf-cancel').hidden = false;
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Eliminar este concierto?')) return;
    try {
      await api('/api/concerts/' + b.dataset.del, { method: 'DELETE' });
      toast('Concierto eliminado');
      if (state.selectedConcertId === Number(b.dataset.del)) state.selectedConcertId = null;
      await loadConcerts();
      renderAdmin();
    } catch (err) { toast(err.message, true); }
  }));
}

function resetConcertForm() {
  $('#concert-form').reset();
  $('#cf-id').value = '';
  $('#cf-submit').textContent = 'Agregar';
  $('#cf-cancel').hidden = true;
}
$('#cf-cancel').addEventListener('click', resetConcertForm);

$('#concert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#cf-id').value;
  const body = { artist: $('#cf-artist').value, date: $('#cf-date').value, notes: $('#cf-notes').value };
  try {
    await api(id ? '/api/concerts/' + id : '/api/concerts', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Concierto actualizado' : 'Concierto agregado');
    resetConcertForm();
    await loadConcerts();
    renderAdmin();
  } catch (err) { toast(err.message, true); }
});

// ---------- Arranque ----------

(async function init() {
  state.info = await api('/api/info');
  $('#palco-name').textContent = state.info.palcoName;
  const saved = store.get('palco.code');
  if (saved) {
    try { await login(saved); } catch { logout(); }
  }
})();
