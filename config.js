// Configuración del palco. Los códigos de acceso pueden (y deben) sobreescribirse
// con variables de entorno en producción.
const config = {
  palcoName: process.env.PALCO_NAME || 'Box 7 · DaviArena',

  // Distribución del Box 7 según el mapa 3D del DaviArena. La Fila A es la de adelante (junto a la
  // baranda) y está corrida a la derecha; las sillas se numeran de izquierda a derecha.
  // Internamente cada silla tiene un número 1..11: A1-A5 = 1-5, B1-B6 = 6-11.
  rows: [
    { row: 'A', seats: 5 },
    { row: 'B', seats: 6 },
  ],

  partners: [
    {
      id: 'netmask',
      name: 'Netmask',
      short: 'Netmask',
      color: '#f4a3e8',
      // Logo por defecto (public/logos). Un logo subido desde la web por el administrador lo reemplaza.
      logo: '/logos/netmask.svg',
      code: process.env.CODE_NETMASK || 'NETMASK-2026',
    },
    {
      id: 'tdsynnex',
      name: 'TD SYNNEX',
      short: 'TD SYNNEX',
      color: '#5ec8e5',
      code: process.env.CODE_TDSYNNEX || 'TDSYNNEX-2026',
    },
    {
      id: 'technologypartners',
      name: 'Technology Partners',
      short: 'Tech Partners',
      color: '#9be36b',
      code: process.env.CODE_TECHPARTNERS || 'TECHPARTNERS-2026',
    },
  ],

  // Código de administración: puede liberar cualquier reserva y gestionar conciertos.
  adminCode: process.env.CODE_ADMIN || 'ADMIN-PALCO-2026',

  // Programación. Cada concierto se carga una vez por base de datos (los nuevos se agregan al desplegar).
  concerts: [
    { artist: 'Juanes', date: '2026-11-14' },
    { artist: 'Chayanne', date: '2026-11-19' },
    { artist: 'Kris R', date: '2026-11-20' },
    { artist: 'Rubén Blades', date: '2026-11-21' },
    { artist: 'Anuel AA', date: '2026-11-22' },
    { artist: 'Marco Antonio Solís', date: '2026-11-26' },
    { artist: 'Beéle', date: '2026-11-29' },
    { artist: 'Ozuna', date: '2026-12-03' },
    // El afiche dice 04.11, pero por el orden de la programación corresponde al 04.12.
    { artist: 'KI/KI', date: '2026-12-04' },
    { artist: 'Martin Garrix', date: '2026-12-05' },
    { artist: 'Alcolirykoz', date: '2026-12-11' },
    { artist: 'Rawayana', date: '2026-12-12' },
    { artist: 'Juan Luis Guerra', date: '2026-12-13' },
    { artist: 'La Verbena', date: '2026-12-19' },
    { artist: 'Laura Pausini', date: '2027-03-07' },
    { artist: 'Carlos Vives', date: '2027-04-17' },
  ],
};

config.seats = config.rows.reduce((n, r) => n + r.seats, 0);

// Rangos de cada fila: { row, seats, start } donde start es el número interno de su primera silla.
config.layout = config.rows.reduce((acc, r) => {
  const start = acc.length ? acc[acc.length - 1].start + acc[acc.length - 1].seats : 1;
  return [...acc, { ...r, start }];
}, []);

config.seatLabel = (n) => {
  const r = config.layout.find((x) => n >= x.start && n < x.start + x.seats);
  return r ? `${r.row}${n - r.start + 1}` : String(n);
};

module.exports = config;
