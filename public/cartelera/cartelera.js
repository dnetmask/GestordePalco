// Cartelera pública: solo lectura, sin códigos ni datos de quién reservó.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { dateStyle: 'full' }).replace(/^./, (c) => c.toUpperCase());

function seatMap(layout, occupied) {
  const taken = new Set(occupied);
  const cols = Math.max(...layout.map((r) => r.seats));
  // Como en el mapa 3D: la Fila B (atrás) arriba y la Fila A junto a la baranda, alineada a la derecha.
  const rows = [...layout].reverse().map((r) => {
    let cells = `<div class="row-label" style="grid-column:1">Fila ${esc(r.row)}</div>`;
    for (let i = 0; i < r.seats; i++) {
      const n = r.start + i;
      const label = `${r.row}${i + 1}`;
      const busy = taken.has(n);
      cells += `<div class="pseat ${busy ? 'taken' : 'free'}" style="grid-column:${cols - r.seats + 2 + i}" title="Silla ${label}: ${busy ? 'ocupada' : 'libre'}">${label}</div>`;
    }
    return cells;
  }).join('');
  return `<div class="box" style="--cols:${cols}">${rows}</div><div class="railing"></div><div class="stage">↓ ESCENARIO ↓</div>`;
}

(async function init() {
  const list = document.getElementById('pub-list');
  try {
    const res = await fetch('/api/public/agenda');
    if (!res.ok) throw new Error();
    const data = await res.json();
    document.getElementById('pub-name').textContent = data.palcoName;
    list.innerHTML = data.concerts.map((c) => `
      <article class="pub-card">
        <h2>${esc(c.artist)}</h2>
        <div class="when">${fmtDate(c.date)}</div>
        <div class="avail ${c.free ? '' : 'none'}">${c.free ? `${c.free} silla${c.free === 1 ? '' : 's'} disponible${c.free === 1 ? '' : 's'}` : 'Sin sillas disponibles'}</div>
        ${seatMap(data.layout, c.occupied)}
      </article>`).join('') || '<p class="empty">No hay conciertos próximos.</p>';
  } catch {
    list.innerHTML = '<p class="empty">No pudimos cargar la cartelera. Intenta de nuevo en unos minutos.</p>';
  }
})();
