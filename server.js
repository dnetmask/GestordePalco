// Punto de entrada: en local levanta el servidor; en Vercel (preset Express) se exporta la app.
const { createApp } = require('./lib/app');

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Gestor de Palco escuchando en http://localhost:${port}`));
}

module.exports = app;
