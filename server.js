// Punto de entrada. En local levanta el servidor; en Vercel (preset Express) se exporta la app
// y los archivos de public/ los sirve directamente el CDN.
const express = require('express');
const { createApp } = require('./lib/app');

const app = express();
app.use(createApp());

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Gestor de Palco escuchando en http://localhost:${port}`));
}

module.exports = app;
