/**
 * src/scanner.js
 * Escáner proactivo de hashtags — ejecuta cada 6 horas con node-cron
 */

import cron from 'node-cron';
import { analyzeAccountsBatch } from './analyzer.js';
import { saveAccount, saveWeeklyScan } from './database.js';
import { generarTarjetaReporte } from './imageGenerator.js';
import { publishImagePost } from './socialPublisher.js';

// Hashtags agrupados por frecuencia de monitoreo
const GRUPOS_HASHTAGS = {
  min15: ['Trump', 'Iran', 'Noticias'],
  min20: ['Mexico', 'Politica'],
  min30: ['Finanzas', 'IA', 'AI', 'ArtificialIntelligence'],
  min60: ['Sinaloa', 'EleccionesMX', 'Sheinbaum', 'Narco', 'Guerra', 'Corrupcion'],
};

// Umbral para considerar un cluster de bots
const CLUSTER_THRESHOLD = 30;
const BOT_SCORE_THRESHOLD = parseInt(process.env.BOT_ALERT_THRESHOLD || '75', 10);

/**
 * Obtiene el inicio y fin de la semana actual (lunes-domingo)
 */
function getWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = domingo
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysSinceMonday);
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);

  return {
    weekStart: weekStart.toISOString().split('T')[0],
    weekEnd: weekEnd.toISOString().split('T')[0],
  };
}

/**
 * Escanea un hashtag específico
 * @param {string} hashtag
 * @param {BlueskyClient} blueskyClient
 */
async function scanHashtag(hashtag, blueskyClient) {
  console.log(`  🔎 Escaneando #${hashtag}...`);

  try {
    const posts = await blueskyClient.searchHashtag(hashtag, 100);

    if (posts.length === 0) {
      console.log(`  → Sin posts para #${hashtag}`);
      return { hashtag, accountsFound: 0, botsDetected: 0, percentage: 0, botHandles: [] };
    }

    // Extraer handles únicos de autores
    const handlesUnicos = [...new Set(
      posts
        .map((p) => p.author?.handle)
        .filter(Boolean)
    )];

    console.log(`  → ${posts.length} posts, ${handlesUnicos.length} autores únicos`);

    let botsDetected = 0;
    const botHandles = [];

    // Analizar en paralelo — lotes de 10 con pausa de 500ms entre lotes
    const batchResults = await analyzeAccountsBatch(handlesUnicos, blueskyClient);

    for (const { handle, profileData, analysis } of batchResults) {
      if (analysis.score >= BOT_SCORE_THRESHOLD) {
        botsDetected++;
        botHandles.push({ handle, score: analysis.score, nivel: analysis.nivel });
        saveAccount({
          handle,
          did: profileData.did,
          score: analysis.score,
          nivel: analysis.nivel,
          señales: analysis.señales,
          requestedBy: 'scanner',
        });
      }
    }

    const percentage = handlesUnicos.length > 0
      ? Math.round((botsDetected / handlesUnicos.length) * 100)
      : 0;

    console.log(`  → #${hashtag}: ${botsDetected}/${handlesUnicos.length} bots (${percentage}%)`);

    return { hashtag, accountsFound: handlesUnicos.length, botsDetected, percentage, botHandles };
  } catch (err) {
    console.error(`Error escaneando #${hashtag}:`, err.message);
    return { hashtag, accountsFound: 0, botsDetected: 0, percentage: 0, botHandles: [] };
  }
}

/**
 * Genera y publica alerta de cluster de bots con tarjeta visual PNG.
 * @param {object} resultado - objeto completo del escaneo
 * @param {BlueskyClient} blueskyClient
 */
async function publicarAlertaCluster(resultado, blueskyClient) {
  const { hashtag, botsDetected, percentage, accountsFound } = resultado;

  const hora = new Date().toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City',
  });
  const fecha = new Date().toLocaleDateString('es-MX', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'America/Mexico_City',
  });
  const nivel = percentage >= 30 ? 'ALTO' : percentage >= 15 ? 'MEDIO' : 'BAJO';
  const link = `https://bsky.app/search?q=%23${encodeURIComponent(hashtag)}`;

  const alerta = `🚨 ALERTA BOT-ID — #${hashtag}
━━━━━━━━━━━━━━━
🤖 ${botsDetected} bots detectados (${percentage}% del debate)
🕐 ${hora} · ${fecha}
🔍 ${link}

¿Coordinación artificial? Los datos sugieren que sí.
Sin partido. Sin patrocinador. — Bot-ID`;

  const imagePath = await generarTarjetaReporte({
    fuente:     `#${hashtag}`,
    bots:       botsDetected,
    total:      accountsFound,
    porcentaje: percentage,
    nivel,
    fecha,
  }).catch(() => null);

  console.log(`\n🚨 ALERTA: ${botsDetected} bots (${percentage}%) en #${hashtag}`);
  return publishImagePost(
    blueskyClient,
    imagePath,
    alerta,
    `Alerta Bot-ID: ${botsDetected} bots en #${hashtag}`
  );
}

/**
 * Ejecuta el ciclo completo de escaneo
 * @param {BlueskyClient} blueskyClient
 */
export async function runScan(blueskyClient) {
  console.log('\n🔍 Iniciando escaneo proactivo...');
  const { weekStart, weekEnd } = getWeekRange();
  const resultados = [];

  const todosHashtags = Object.values(GRUPOS_HASHTAGS).flat();
  for (const hashtag of todosHashtags) {
    const resultado = await scanHashtag(hashtag, blueskyClient);
    resultados.push(resultado);

    // Guardar en BD
    if (resultado.accountsFound > 0) {
      saveWeeklyScan({
        hashtag: resultado.hashtag,
        accountsFound: resultado.accountsFound,
        botsDetected: resultado.botsDetected,
        percentage: resultado.percentage,
        weekStart,
        weekEnd,
      });
    }

    // Detectar cluster de bots
    if (resultado.botsDetected >= CLUSTER_THRESHOLD) {
      await publicarAlertaCluster(resultado, blueskyClient);
    }

    // Pausa entre hashtags
    await sleep(3000);
  }

  // Resumen del escaneo
  const totalBots = resultados.reduce((sum, r) => sum + r.botsDetected, 0);
  const totalAnalizados = resultados.reduce((sum, r) => sum + r.accountsFound, 0);
  const topHashtag = [...resultados].sort((a, b) => b.percentage - a.percentage)[0];

  console.log(`\n📊 Escaneo completado:`);
  console.log(`   Total analizados: ${totalAnalizados}`);
  console.log(`   Bots detectados:  ${totalBots}`);
  if (topHashtag?.accountsFound > 0) {
    console.log(`   Hashtag más manipulado: #${topHashtag.hashtag} (${topHashtag.percentage}%)`);
  }

  return { resultados, totalBots, totalAnalizados, topHashtag };
}

/**
 * Inicia el monitor de hashtags con frecuencias diferenciadas.
 * @param {BlueskyClient} blueskyClient
 */
export function startScanner(blueskyClient) {

  // Escanea todos los hashtags de un grupo y publica alertas si corresponde
  const escanearGrupo = async (grupo) => {
    const { weekStart, weekEnd } = getWeekRange();
    for (const hashtag of GRUPOS_HASHTAGS[grupo]) {
      const resultado = await scanHashtag(hashtag, blueskyClient);
      if (resultado.accountsFound > 0) {
        saveWeeklyScan({
          hashtag: resultado.hashtag,
          accountsFound: resultado.accountsFound,
          botsDetected: resultado.botsDetected,
          percentage: resultado.percentage,
          weekStart,
          weekEnd,
        });
      }
      if (resultado.botsDetected >= CLUSTER_THRESHOLD) {
        await publicarAlertaCluster(resultado, blueskyClient);
      }
      await sleep(3000);
    }
  };

  // Cada 15 min: Trump, Iran, Noticias
  cron.schedule('*/15 * * * *', async () => {
    try { await escanearGrupo('min15'); }
    catch (err) { console.error('Error scanner 15min:', err.message); }
  });

  // Cada 20 min: Mexico, Politica
  cron.schedule('*/20 * * * *', async () => {
    try { await escanearGrupo('min20'); }
    catch (err) { console.error('Error scanner 20min:', err.message); }
  });

  // Cada 30 min: Finanzas, IA, AI, ArtificialIntelligence
  cron.schedule('*/30 * * * *', async () => {
    try { await escanearGrupo('min30'); }
    catch (err) { console.error('Error scanner 30min:', err.message); }
  });

  // Cada 60 min: Sinaloa, EleccionesMX, Sheinbaum, Narco, Guerra, Corrupcion
  cron.schedule('0 * * * *', async () => {
    try { await escanearGrupo('min60'); }
    catch (err) { console.error('Error scanner 60min:', err.message); }
  });

  console.log('🔍 Monitor de hashtags activo:');
  console.log('   → Cada 15 min: Trump, Iran, Noticias');
  console.log('   → Cada 20 min: Mexico, Politica');
  console.log('   → Cada 30 min: Finanzas, IA, AI, ArtificialIntelligence');
  console.log('   → Cada 60 min: Sinaloa, EleccionesMX, Sheinbaum, Narco, Guerra, Corrupcion');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
