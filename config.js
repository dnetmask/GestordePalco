// Configuración del palco. Los códigos de acceso pueden (y deben) sobreescribirse
// con variables de entorno en producción.
module.exports = {
  palcoName: process.env.PALCO_NAME || 'Palco Movistar DaviArena',
  seats: Number(process.env.PALCO_SEATS || 12),

  partners: [
    {
      id: 'netmask',
      name: 'Netmask Technology Partners',
      short: 'Netmask',
      color: '#f4a3e8',
      code: process.env.CODE_NETMASK || 'NETMASK-2026',
    },
    {
      id: 'tdsynnex',
      name: 'TD SYNNEX',
      short: 'TD SYNNEX',
      color: '#5ec8e5',
      code: process.env.CODE_TDSYNNEX || 'TDSYNNEX-2026',
    },
  ],

  // Código de administración: puede liberar cualquier reserva y gestionar conciertos.
  adminCode: process.env.CODE_ADMIN || 'ADMIN-PALCO-2026',

  // Programación "La Primavera" (temporada 2026). Se cargan solo si la base está vacía.
  concerts: [
    { artist: 'Juanes', date: '2026-11-14' },
    { artist: 'Chayanne', date: '2026-11-19' },
    { artist: 'Kris R', date: '2026-11-20' },
    { artist: 'Rubén Blades', date: '2026-11-21' },
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
  ],
};
