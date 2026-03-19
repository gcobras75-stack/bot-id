/**
 * src/scanner.js
 * Escáner proactivo de hashtags — ejecuta cada 6 horas con node-cron
 */

import cron from 'node-cron';
import { analyzeAccount } from './analyzer.js';
import { saveAccount, saveWeeklyScan } from './database.js';

// Hashtags a monitorear (política y temas sensibles en México)
const HASHTAGS_MONITOREADOS = [
  'México',
  'Sinaloa',
  'Culiacán',
  'Elecciones',
  'Política',
  'Morena',
  'AMLO',
  'Sheinbaum',
  'México2026',
  'Elecciones2026',
  'Seguridad',
  'Narco',
];

// Umbral para considerar un cluster de bots
const CLUSTER_THRESHOLD = 5;
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

    // Analizar cada handle (con pausa para no sobrecargar la API)
    for (const handle of handlesUnicos) {
      try {
        const profileData = await blueskyClient.getProfile(handle);
        if (!profileData) continue;

        const postHistory = await blueskyClient.getPostHistory(profileData.did, 50);
        const analysis = analyzeAccount(profileData, postHistory);

        if (analysis.score >= BOT_SCORE_THRESHOLD) {
          botsDetected++;
          botHandles.push({ handle, score: analysis.score, nivel: analysis.nivel });

          // Guardar en BD
          saveAccount({
            handle,
            did: profileData.did,
            score: analysis.score,
            nivel: analysis.nivel,
            señales: analysis.señales,
            requestedBy: 'scanner',
          });
        }

        // Pausa para no saturar la API de Bluesky
        await sleep(500);
      } catch (err) {
        console.error(`    Error analizando @${handle}:`, err.message);
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
 * Genera y publica alerta de cluster de bots
 * @param {string} hashtag
 * @param {Array}  botHandles
 * @param {BlueskyClient} blueskyClient
 */
async function publicarAlertaCluster(hashtag, botHandles, blueskyClient) {
  const topBots = botHandles.slice(0, 3).map((b) => `@${b.handle} (${b.score}%)`).join(', ');

  const alerta = `🚨 ALERTA BOT-ID
━━━━━━━━━━━━━━━
📌 #${hashtag}
🤖 Cluster de ${botHandles.length} bots detectados operando juntos

Top sospechosos:
${topBots}

¿Coordinación artificial del debate? Los datos sugieren que sí.

Sin partido. Sin patrocinador. — Bot-ID`;

  console.log(`\n🚨 ALERTA: Cluster de ${botHandles.length} bots en #${hashtag}`);
  const result = await blueskyClient.post(alerta);
  return result;
}

/**
 * Ejecuta el ciclo completo de escaneo
 * @param {BlueskyClient} blueskyClient
 */
export async function runScan(blueskyClient) {
  console.log('\n🔍 Iniciando escaneo proactivo...');
  const { weekStart, weekEnd } = getWeekRange();
  const resultados = [];

  for (const hashtag of HASHTAGS_MONITOREADOS) {
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
      await publicarAlertaCluster(resultado.hashtag, resultado.botHandles, blueskyClient);
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
 * Inicia el scanner programado cada 6 horas
 * @param {BlueskyClient} blueskyClient
 */
export function startScanner(blueskyClient) {
  // Ejecutar cada 6 horas: 0:00, 6:00, 12:00, 18:00 hora México (UTC-6)
  // En cron: '0 6,12,18,0 * * *'  (UTC)
  cron.schedule('0 0,6,12,18 * * *', async () => {
    try {
      await runScan(blueskyClient);
    } catch (err) {
      console.error('Error en ciclo de scanner:', err.message);
    }
  });

  console.log('🔍 Scanner proactivo activo (cada 6 horas: 0:00, 6:00, 12:00, 18:00 UTC)');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
