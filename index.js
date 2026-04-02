/**
 * index.js — Punto de entrada principal de Bot-ID
 *
 * Sistema activista de detección y exposición de bots en redes sociales.
 * Sin partido. Sin patrocinador. Datos abiertos.
 */

import 'dotenv/config';
import { createServer } from 'http';
import { BlueskyClient } from './src/bluesky.js';
import { initDatabase } from './src/database.js';
import { startMentionsListener } from './src/mentions.js';
import { startScanner, runScan } from './src/scanner.js';
import { scheduleWeeklyReport } from './src/reporter.js';
import { scheduleTrendingPublisher } from './src/publisher.js';
import { initCostMonitor } from './src/costMonitor.js';
import { startPatrol } from './src/patrol.js';
import { startDMListener, sendAdminStartupReport } from './src/dm.js';
import { scheduleDailyPosts } from './src/dailyPosts.js';

// ─── Validación de variables de entorno ─────────────────────────────────────

function validateEnv() {
  const requeridas = ['BLUESKY_USERNAME', 'BLUESKY_PASSWORD', 'ANTHROPIC_API_KEY'];
  const faltantes = requeridas.filter((k) => !process.env[k]);

  if (faltantes.length > 0) {
    console.error('❌ Faltan variables de entorno:');
    faltantes.forEach((k) => console.error(`   → ${k}`));
    console.error('\n💡 Copia .env.example como .env y completa tus credenciales.');
    process.exit(1);
  }
}

// ─── Banner de inicio ────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🤖  B O T - I D                                   ║
║   Sistema de transparencia digital                   ║
║   Detección y exposición de bots en Bluesky          ║
║                                                      ║
║   Sin partido. Sin patrocinador. Datos abiertos.     ║
╚══════════════════════════════════════════════════════╝
`);
}

// ─── Manejo de errores no capturados ────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err.message);
  console.error(err.stack);
  // No salimos del proceso — el sistema debe seguir corriendo
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

// Señal de apagado limpio
process.on('SIGINT', () => {
  console.log('\n\n👋 Bot-ID detenido manualmente. ¡Hasta pronto!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Bot-ID recibió señal de terminación.');
  process.exit(0);
});

// ─── Main ────────────────────────────────────────────────────────────────────

function startHealthServer() {
  const port = process.env.PORT || 3000;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => {
    console.log(`🩺 Health server escuchando en puerto ${port}`);
  });
}

async function main() {
  printBanner();
  validateEnv();
  startHealthServer();

  // 1. Inicializar base de datos
  console.log('🗄️  Iniciando base de datos...');
  initDatabase();

  // 2. Conectar a Bluesky
  console.log('🌐 Conectando a Bluesky...');
  const bluesky = new BlueskyClient();
  await bluesky.login();

  // 3. Iniciar listener de menciones (polling cada 60s)
  startMentionsListener(bluesky);

  // 4. Iniciar patrulla proactiva de hilos (Modo 1, cada 10 min)
  startPatrol(bluesky);

  // 5. Iniciar listener de DMs privados (Modo 3, cada 2 min)
  startDMListener(bluesky);

  // 6. Iniciar scanner proactivo (cada 6 horas)
  startScanner(bluesky);

  // 7. Programar reporte semanal (lunes 8am México)
  const proximoReporte = scheduleWeeklyReport(bluesky);

  // 8. Programar publicación diaria de imágenes de tendencias
  scheduleTrendingPublisher(bluesky);

  // 10. Programar posts diarios automáticos (9am, 3pm, 8pm México)
  scheduleDailyPosts(bluesky);

  // 11. Iniciar monitor de costos API
  initCostMonitor(bluesky);

  // Status en consola
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot-ID activo
📡 Modo 1 — Patrulla proactiva (cada 10 min)
💬 Modo 2 — Comandos: !bots, !scan, !verificar
📨 Modo 3 — DMs privados (cada 2 min)
🔍 Scanner hashtags (cada 6h)
📅 Posts diarios: 9am, 3pm, 8pm (hora México)
📊 Próximo reporte semanal: ${proximoReporte}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Para detección discreta: envía DM a @${process.env.BLUESKY_USERNAME}

Presiona Ctrl+C para detener.
`);

  // 12. Enviar reporte de prueba al admin por DM (en background)
  sendAdminStartupReport(bluesky).catch((err) => {
    console.error('Error enviando reporte admin:', err.message);
  });

  // 13. Ejecutar un primer escaneo al iniciar (en background)
  console.log('🔄 Ejecutando escaneo inicial en segundo plano...');
  runScan(bluesky).catch((err) => {
    console.error('Error en escaneo inicial:', err.message);
  });
}

main().catch((err) => {
  console.error('❌ Error fatal al iniciar Bot-ID:', err.message);
  console.error(err.stack);
  process.exit(1);
});
