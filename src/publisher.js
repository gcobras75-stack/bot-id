/**
 * src/publisher.js
 * Programa la generación y publicación automática de imágenes de tendencias diarias.
 *
 * Horarios hora México (UTC-6):
 *   9:00am  → Internacional   (15:00 UTC)
 *   2:00pm  → Nacional        (20:00 UTC)
 *   6:00pm  → Local/Sinaloa   (00:00 UTC día siguiente)
 */

import cron from 'node-cron';
import { getTrendingTopics } from './trending.js';
import { generarImagenTendencias } from './imageGenerator.js';
import { publicarReporteTendencias } from './socialPublisher.js';

/**
 * Ejecuta el flujo completo para un tipo de reporte:
 * obtener tendencias → generar imagen → publicar en Bluesky.
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 * @param {'internacional'|'nacional'|'local'} tipo
 */
export async function generarYPublicar(blueskyClient, tipo) {
  console.log(`\n🗓️  Iniciando publicación de tendencias: ${tipo.toUpperCase()}`);

  try {
    // 1. Obtener todas las tendencias del día
    const tendencias = await getTrendingTopics(blueskyClient);
    const datosTipo = tendencias[tipo];

    if (!datosTipo || datosTipo.length === 0) {
      console.log(`⚠️  Sin datos suficientes para ${tipo}, omitiendo publicación`);
      return;
    }

    // 2. Generar imagen PNG (o SVG como fallback)
    const imagePath = await generarImagenTendencias(tipo, datosTipo);
    if (!imagePath) {
      console.log(`⚠️  No se pudo generar imagen para ${tipo}`);
      return;
    }

    // 3. Publicar en Bluesky
    await publicarReporteTendencias(blueskyClient, tipo, imagePath);

    console.log(`✅ Reporte ${tipo} completado`);
  } catch (err) {
    console.error(`❌ Error en publicación ${tipo}:`, err.message);
  }
}

/**
 * Programa las tres publicaciones automáticas diarias.
 * Usa hora UTC para compatibilidad con Railway (servidor en UTC).
 *
 * México es UTC-6 (CST) o UTC-5 (CDT en verano).
 * Se usa UTC-6 como base estándar.
 *
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 */
export function scheduleTrendingPublisher(blueskyClient) {
  // 9:00am México (UTC-6) = 15:00 UTC
  cron.schedule('0 15 * * *', async () => {
    try {
      await generarYPublicar(blueskyClient, 'internacional');
    } catch (err) {
      console.error('Error en cron internacional:', err.message);
    }
  });

  // 2:00pm México (UTC-6) = 20:00 UTC
  cron.schedule('0 20 * * *', async () => {
    try {
      await generarYPublicar(blueskyClient, 'nacional');
    } catch (err) {
      console.error('Error en cron nacional:', err.message);
    }
  });

  // 6:00pm México (UTC-6) = 00:00 UTC
  cron.schedule('0 0 * * *', async () => {
    try {
      await generarYPublicar(blueskyClient, 'local');
    } catch (err) {
      console.error('Error en cron local:', err.message);
    }
  });

  console.log('📸 Publisher de tendencias programado:');
  console.log('   → 9:00am México: Tendencias Internacionales');
  console.log('   → 2:00pm México: Tendencias Nacionales');
  console.log('   → 6:00pm México: Tendencias Sinaloa/Local');
}
