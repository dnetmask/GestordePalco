// Generador de invitaciones: dibuja una imagen 1080×1350 (formato vertical para WhatsApp/redes)
// con el logo de la empresa que invita, el concierto y la silla.

const INVITE_W = 1080;
const INVITE_H = 1350;
const C = { wine: '#5c0031', wine2: '#74103f', pink: '#f4a3e8', red: '#d7262b', cream: '#f6ece4', muted: '#d9b6c8' };

const imageCache = {};
function loadImage(url) {
  if (!url) return Promise.resolve(null);
  imageCache[url] ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  return imageCache[url];
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

// Ajusta el tamaño de fuente para que el texto quepa en el ancho dado.
function fitFont(ctx, text, weight, maxSize, maxWidth) {
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px Archivo, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  } while (size > 24);
  return size;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += '…';
  }
  return lines;
}

async function drawInvitation(canvas, d) {
  // d: { partner: {name, color}, logo: {url, bg} | null, guest, artist, date, row, seat, message, venue }
  await Promise.all(['900 100px Archivo', '800 40px Archivo', '600 40px Archivo', '400 40px Archivo']
    .map((f) => document.fonts.load(f).catch(() => {})));
  const logoImg = await loadImage(d.logo?.url);

  canvas.width = INVITE_W;
  canvas.height = INVITE_H;
  const ctx = canvas.getContext('2d');
  const cx = INVITE_W / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Fondo con franja del color del socio
  ctx.fillStyle = C.wine;
  ctx.fillRect(0, 0, INVITE_W, INVITE_H);
  ctx.fillStyle = d.partner.color;
  ctx.fillRect(0, 0, INVITE_W, 14);

  // Logo de la empresa que invita, sobre una placa clara u oscura
  const plateX = 90, plateY = 70, plateW = INVITE_W - 180, plateH = 230;
  roundRect(ctx, plateX, plateY, plateW, plateH, 28, d.logo?.bg === 'dark' ? '#1d0010' : '#ffffff');
  if (logoImg) {
    const iw = logoImg.naturalWidth || 600, ih = logoImg.naturalHeight || 150;
    const scale = Math.min((plateW - 120) / iw, (plateH - 70) / ih);
    const w = iw * scale, h = ih * scale;
    ctx.drawImage(logoImg, cx - w / 2, plateY + (plateH - h) / 2, w, h);
  } else {
    ctx.fillStyle = d.logo?.bg === 'dark' ? C.cream : C.wine;
    fitFont(ctx, d.partner.name, 900, 90, plateW - 100);
    ctx.textBaseline = 'middle';
    ctx.fillText(d.partner.name, cx, plateY + plateH / 2);
    ctx.textBaseline = 'alphabetic';
  }

  // "te invita"
  let y = 420;
  if (d.guest) {
    ctx.fillStyle = C.cream;
    fitFont(ctx, `${d.guest},`, 600, 52, INVITE_W - 160);
    ctx.fillText(`${d.guest},`, cx, y);
    y += 92;
  } else {
    y += 20;
  }
  ctx.fillStyle = C.pink;
  ctx.font = '900 96px Archivo, sans-serif';
  ctx.fillText(d.guest ? 'te invitamos a' : 'Te invitamos a', cx, y);

  // Artista en etiqueta roja, como el afiche
  y += 60;
  const artistSize = fitFont(ctx, d.artist, 900, 130, INVITE_W - 220);
  const artistW = ctx.measureText(d.artist).width + 80;
  const artistH = artistSize + 50;
  roundRect(ctx, cx - artistW / 2, y, artistW, artistH, 16, C.red);
  ctx.fillStyle = C.cream;
  ctx.textBaseline = 'middle';
  ctx.fillText(d.artist, cx, y + artistH / 2 + 4);
  ctx.textBaseline = 'alphabetic';
  y += artistH + 70;

  // Fecha y lugar
  ctx.fillStyle = C.cream;
  const dateText = new Date(d.date + 'T12:00:00').toLocaleDateString('es-CO', { dateStyle: 'full' });
  fitFont(ctx, dateText.charAt(0).toUpperCase() + dateText.slice(1), 800, 50, INVITE_W - 160);
  ctx.fillText(dateText.charAt(0).toUpperCase() + dateText.slice(1), cx, y);
  y += 55;
  ctx.fillStyle = C.muted;
  ctx.font = '400 38px Archivo, sans-serif';
  ctx.fillText(d.venue, cx, y);

  // Silla
  y += 60;
  const boxW = 680, boxH = 180;
  roundRect(ctx, cx - boxW / 2, y, boxW, boxH, 24, C.cream);
  const third = boxW / 3;
  const cells = [['BOX', '7'], ['FILA', d.row], ['SILLA', String(d.seat)]];
  cells.forEach(([label, value], i) => {
    const x = cx - boxW / 2 + third * i + third / 2;
    ctx.fillStyle = C.wine2;
    ctx.font = '800 30px Archivo, sans-serif';
    ctx.fillText(label, x, y + 58);
    ctx.fillStyle = C.wine;
    ctx.font = '900 92px Archivo, sans-serif';
    ctx.fillText(value, x, y + 150);
  });
  ctx.fillStyle = 'rgba(92,0,49,.25)';
  ctx.fillRect(cx - boxW / 2 + third, y + 30, 2, boxH - 60);
  ctx.fillRect(cx - boxW / 2 + third * 2, y + 30, 2, boxH - 60);
  y += boxH + 60;

  // Mensaje opcional
  if (d.message) {
    ctx.fillStyle = C.cream;
    ctx.font = '400 36px Archivo, sans-serif';
    for (const line of wrapLines(ctx, d.message, INVITE_W - 220, 2)) {
      ctx.fillText(line, cx, y);
      y += 48;
    }
  }

  // Pie
  ctx.fillStyle = C.muted;
  ctx.font = '400 24px Archivo, sans-serif';
  ctx.fillText('Invitación personal. El ingreso requiere la boleta o acceso oficial del evento.', cx, INVITE_H - 46);
  ctx.fillStyle = d.partner.color;
  ctx.fillRect(0, INVITE_H - 14, INVITE_W, 14);
}

window.drawInvitation = drawInvitation;
