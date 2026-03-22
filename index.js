/**
 * index.js — Punto de entrada principal de Bot-ID
 *
 * Sistema activista de detección y exposición de bots en redes sociales.
 * Sin partido. Sin patrocinador. Datos abiertos.
 */

import 'dotenv/config';
import { BlueskyClient } from './src/bluesky.js';
import { initDatabase } from './src/database.js';
import { startMentionsListener } from './src/mentions.js';
import { startScanner, runScan } from './src/scanner.js';
import { scheduleWeeklyReport } from './src/reporter.js';
import { scheduleTrendingPublisher } from './src/publisher.js';

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

async function main() {
  printBanner();
  validateEnv();

  // 1. Inicializar base de datos
  console.log('🗄️  Iniciando base de datos...');
  initDatabase();

  // 2. Conectar a Bluesky
  console.log('🌐 Conectando a Bluesky...');
  const bluesky = new BlueskyClient();
  await bluesky.login();

  // 3. Iniciar listener de menciones (polling cada 60s)
  startMentionsListener(bluesky);

  // 4. Iniciar scanner proactivo (cada 6 horas)
  startScanner(bluesky);

  // 5. Programar reporte semanal (lunes 8am México)
  const proximoReporte = scheduleWeeklyReport(bluesky);

  // 6. Programar publicación diaria de imágenes de tendencias
  scheduleTrendingPublisher(bluesky);

  // 7. Status en consola
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot-ID activo
📡 Escuchando menciones... (cada 60s)
🔍 Scanner proactivo: activo (cada 6h)
📊 Próximo reporte: ${proximoReporte}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Para analizar una cuenta: menciona @${process.env.BLUESKY_USERNAME}
indicando el @handle a revisar en Bluesky.

Presiona Ctrl+C para detener.
`);

  // 8. Ejecutar un primer escaneo al iniciar (en background)
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
