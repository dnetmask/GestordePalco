# Gestor de Palco · DaviArena

Web para administrar el palco que comparten **Netmask**, **TD SYNNEX** y **Technology Partners** en el Movistar DaviArena (programación *La Primavera* 2026).

## Funcionalidades

- **Acceso por código de socio**: cada empresa entra con su código. Así toda reserva queda asociada al socio que la hizo.
- **Reservas por silla**: eliges el concierto, marcas las sillas libres y reservas indicando quién reserva y, si quieres, a nombre de quién (invitado/cliente).
- **Mapa del palco**: cada silla muestra con el color del socio quién la tiene. Un socio solo puede liberar sus propias sillas.
- **Estadísticas**: quién reserva más (sillas y conciertos por socio), personas que más reservan, ocupación por concierto y de toda la temporada.
- **Historial**: registro de cada reserva y liberación (quién, cuándo y qué).
- **Administrador**: con el código de admin se pueden agregar, editar o eliminar conciertos y liberar cualquier silla.

## Ejecutar

Requiere Node.js 20 o superior. En local los datos se guardan en un archivo SQLite (`data/palco.db`).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

## Configuración

Por variables de entorno (ver `config.js`):

| Variable | Por defecto | Descripción |
|---|---|---|
| `PALCO_SEATS` | `11` | Número de sillas del palco |
| `PALCO_NAME` | `Palco Movistar DaviArena` | Nombre que se muestra |
| `CODE_NETMASK` | `NETMASK-2026` | Código de acceso de Netmask |
| `CODE_TDSYNNEX` | `TDSYNNEX-2026` | Código de acceso de TD SYNNEX |
| `CODE_TECHPARTNERS` | `TECHPARTNERS-2026` | Código de acceso de Technology Partners |
| `CODE_ADMIN` | `ADMIN-PALCO-2026` | Código de administrador |
| `TURSO_DATABASE_URL` | — | URL de la base Turso (obligatoria en Vercel) |
| `TURSO_AUTH_TOKEN` | — | Token de la base Turso |
| `DB_PATH` | `data/palco.db` | Archivo SQLite local (solo si no hay Turso) |
| `PORT` | `3000` | Puerto HTTP |

**Cambia los códigos por defecto antes de publicarla.**

Los conciertos de `config.js` se cargan solo la primera vez (base vacía); después se gestionan desde la pestaña *Conciertos* del administrador.
Nota: el afiche indica KI/KI el 04.11, pero por el orden de la programación se cargó como 04.12; se puede corregir desde la vista de administrador.

## Despliegue en Vercel

Vercel no tiene disco persistente, así que en producción los datos van a **Turso** (SQLite en la nube, plan gratuito suficiente para este uso).

1. **Base de datos**: en Vercel → *Storage* → *Marketplace* → **Turso**, crea una base y conéctala al proyecto. Eso agrega `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`.
   (Alternativa: crea la base en turso.tech y agrega esas dos variables a mano en *Settings → Environment Variables*.)
2. **Códigos de acceso**: en *Settings → Environment Variables* define `CODE_NETMASK`, `CODE_TDSYNNEX`, `CODE_TECHPARTNERS` y `CODE_ADMIN` con valores propios.
3. **Importar el repositorio** en Vercel (Framework Preset: *Express*, sin comando de build) y desplegar.

Las tablas y la programación inicial se crean solas en la primera petición.

Estructura:
- `public/` → la interfaz, servida por el CDN de Vercel.
- `lib/app.js` → la aplicación Express.
- `server.js` → punto de entrada: con `npm start` corre como servidor normal en local; en Vercel (preset Express) exporta la app.
