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

Requiere Node.js 22.13 o superior (usa SQLite integrado en Node, sin dependencias nativas).

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
| `DB_PATH` | `data/palco.db` | Archivo de base de datos SQLite |
| `PORT` | `3000` | Puerto HTTP |

**Cambia los códigos por defecto antes de publicarla.**

Los conciertos de `config.js` se cargan solo la primera vez (base vacía); después se gestionan desde la pestaña *Conciertos* del administrador.
Nota: el afiche indica KI/KI el 04.11, pero por el orden de la programación se cargó como 04.12; se puede corregir desde la vista de administrador.

## Despliegue

Necesita un servidor con disco persistente para el archivo SQLite (por ejemplo una VM, Render/Railway con volumen, o un contenedor con volumen montado en `data/`).
