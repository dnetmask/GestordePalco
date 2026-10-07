// Función serverless de Vercel: atiende todas las rutas /api/*.
// Los archivos de public/ los sirve directamente el CDN de Vercel.
const { createApp } = require('../server');

module.exports = createApp();
