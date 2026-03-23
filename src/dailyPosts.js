/**
 * src/dailyPosts.js
 * 3 publicaciones automáticas diarias en el muro de Bot-ID
 *
 * POST 1 — 9am México   : hilo más viral de la mañana con bots detectados
 * POST 2 — 3pm México   : cuenta sospechosa del día
 * POST 3 — 8pm México   : resumen diario (análisis, bots, hashtag top)
 *
 * Usa Capa 1 para la mayoría de los análisis (rápido, sin costo de API).
 * El POST 2 escala a Groq si no hay sospechosos en BD.
 */

import cron from 'node-cron';
import { capa1 } from './analyzer.js';
import { analizarConGroq } from './groq.js';
import { getDb } from './database.js';
import { generarTarjetaReporte } from './imageGenerator.js';
import { publishImagePost } from './socialPublisher.js';

const TZ = 'America/Mexico_City';

// Hashtags usados en los análisis automáticos (rotarán según hora)
const HASHTAGS_MANANA  = ['Trump', 'Mexico', 'Noticias', 'Politica'];
const HASHTAGS_TARDE   = ['Sheinbaum', 'EleccionesMX', 'Corrupcion', 'Mexico'];

// ─── Utilidades ───────────────────────────────────────────────────────────────

function fechaCorta() {
  return new Date().toLocaleDateString('es-MX', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: TZ,
  });
}

function nivelDesdePct(pct) {
  if (pct >= 30) return 'ALTO';
  if (pct >= 15) return 'MEDIO';
  return 'BAJO';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Publica un post con o sin imagen (fallback a texto puro si no hay imagen).
 */
async function postear(bluesky, texto, imagePath, altText) {
  if (imagePath) {
    return publishImagePost(bluesky, imagePath, texto.slice(0, 299), altText);
  }
  return bluesky.post(texto.slice(0, 299));
}

// ─── Queries a la base de datos ───────────────────────────────────────────────

/**
 * Devuelve el ISO-string del inicio de hoy en hora México.
 */
function getTodayStartISO() {
  const now = new Date();
  // UTC-6 (CST). Acepta desfase de 1h en verano (CDT), suficiente para estadísticas.
  const MX_OFFSET_MS = 6 * 60 * 60 * 1000;
  const mxNow = new Date(now.getTime() - MX_OFFSET_MS);
  mxNow.setUTCHours(0, 0, 0, 0); // medianoche en hora México (en UTC)
  return new Date(mxNow.getTime() + MX_OFFSET_MS).toISOString();
}

function getTodayStats() {
  const db    = getDb();
  const since = getTodayStartISO();

  const total    = db.prepare('SELECT COUNT(*) as c FROM accounts_analyzed WHERE analyzed_at >= ?').get(since)?.c || 0;
  const bots     = db.prepare('SELECT COUNT(*) as c FROM accounts_analyzed WHERE score >= 75 AND analyzed_at >= ?').get(since)?.c || 0;
  const topTagRow = db.prepare(`
    SELECT hashtag, SUM(bots_detected) AS bd
    FROM weekly_scans
    WHERE created_at >= ?
    GROUP BY hashtag
    ORDER BY bd DESC
    LIMIT 1
  `).get(since);

  return {
    total,
    bots,
    topHashtag:   topTagRow?.hashtag  || null,
    topBotCount:  topTagRow?.bd       || 0,
  };
}

function getTopSuspectToday() {
  const db    = getDb();
  const since = getTodayStartISO();

  const row = db.prepare(`
    SELECT handle, score, nivel, señales
    FROM accounts_analyzed
    WHERE score >= 75 AND analyzed_at >= ?
    ORDER BY score DESC
    LIMIT 1
  `).get(since);

  if (!row) return null;
  return { ...row, señales: JSON.parse(row.señales) };
}

// ─── Análisis rápido de un grupo de handles (solo capa 1) ─────────────────────

async function profileBatch(handles, bluesky) {
  const results = [];
  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      const c1 = capa1(profile, []);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto, señales: c1.señales });
      await sleep(350);
    } catch { /* continuar */ }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST 1 — 9am México
// Hilo más viral de la mañana con mayor actividad sospechosa
// ─────────────────────────────────────────────────────────────────────────────

async function post1MorningViral(bluesky) {
  console.log('\n📰 [POST 1] Análisis matutino del hilo más viral...');

  const botHandle = (process.env.BLUESKY_USERNAME || '').replace('@', '').toLowerCase();
  let bestThread = null; // { hashtag, botCount, total, pct, botList }

  for (const hashtag of HASHTAGS_MANANA.slice(0, 3)) {
    try {
      const posts = await bluesky.searchHashtag(hashtag, 12);
      if (!posts.length) continue;

      // Agrupar en hilos únicos por rootUri
      const rootMap = new Map();
      for (const post of posts) {
        const rootUri = post.record?.reply?.root?.uri || post.uri;
        if (!rootMap.has(rootUri)) {
          const rootCid  = post.record?.reply?.root?.cid  || post.cid;
          rootMap.set(rootUri, { uri: rootUri, cid: rootCid, hashtag });
        }
      }

      for (const [rootUri, rootPost] of rootMap) {
        const { participants } = await bluesky.getThread(rootUri);
        if (participants.size < 4) continue; // hilo demasiado pequeño

        const handles = [...participants.values()]
          .filter((p) => p.handle.toLowerCase() !== botHandle)
          .slice(0, 16)
          .map((p) => p.handle);

        const results = await profileBatch(handles, bluesky);
        const bots    = results.filter((r) => r.puntos > 60);
        const pct     = results.length > 0 ? Math.round((bots.length / results.length) * 100) : 0;

        console.log(`  [M1] #${hashtag} hilo …${rootUri.slice(-6)}: ${bots.length}/${results.length} bots (${pct}%)`);

        if (!bestThread || pct > bestThread.pct) {
          bestThread = {
            hashtag,
            botCount: bots.length,
            total:    results.length,
            pct,
            botList:  bots.slice(0, 3),
          };
        }

        await sleep(1000);
      }
    } catch (err) {
      console.warn(`  ⚠️  Error en #${hashtag}: ${err.message}`);
    }

    await sleep(1500);
  }

  // ── Generar y publicar ────────────────────────────────────────────────────
  let texto, imagePath;

  if (!bestThread || bestThread.botCount === 0) {
    texto = [
      `🌅 Bot-ID — Monitoreo matutino activo`,
      `━━━━━━━━━━━━━━━`,
      `Sin actividad bot significativa detectada esta mañana.`,
      `La conversación parece orgánica — por ahora.`,
      ``,
      `Seguimos monitoreando en tiempo real.`,
      `━━━━━━━━━━━━━━━`,
      `🔍 Bot-ID | Transparencia digital`,
      `#BotID #Bots`,
    ].join('\n');
    imagePath = null;
  } else {
    const { hashtag, botCount, total, pct, botList } = bestThread;
    const topBots = botList.map((b) => `@${b.handle}`).join(', ');

    texto = [
      `🚨 Bot-ID — ANÁLISIS MATUTINO`,
      `━━━━━━━━━━━━━━━`,
      `Hilo más manipulado esta mañana en #${hashtag}:`,
      ``,
      `🤖 ${botCount} de ${total} participantes son bots (${pct}%)`,
      botList.length > 0 ? `🔴 Sospechosos: ${topBots}` : '',
      ``,
      `Los patrones automáticos son claros.`,
      `━━━━━━━━━━━━━━━`,
      `🔍 Bot-ID | Transparencia digital`,
      `#BotID #Bots #ManipulaciónDigital`,
    ].filter(Boolean).join('\n');

    imagePath = await generarTarjetaReporte({
      fuente:     `#${hashtag}`,
      bots:       botCount,
      total,
      porcentaje: pct,
      nivel:      nivelDesdePct(pct),
      fecha:      fechaCorta(),
      labelBots:  'BOTS EN HILO',
    }).catch(() => null);
  }

  await postear(bluesky, texto, imagePath, 'Análisis matutino Bot-ID: bots detectados en hilo viral');
  console.log(`  ✅ POST 1 publicado`);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST 2 — 3pm México
// Cuenta sospechosa del día
// ─────────────────────────────────────────────────────────────────────────────

async function post2SuspiciousAccount(bluesky) {
  console.log('\n🔍 [POST 2] Cuenta sospechosa del día...');

  // 1. Buscar en BD si ya hay un sospechoso de hoy
  let suspect = getTopSuspectToday();

  // 2. Si no hay en BD, escanear un hashtag en tiempo real
  if (!suspect) {
    console.log('  Sin sospechosos en BD hoy → escaneando en tiempo real...');
    const hashtag = HASHTAGS_TARDE[Math.floor(Math.random() * HASHTAGS_TARDE.length)];
    const posts   = await bluesky.searchHashtag(hashtag, 50);

    let topScore   = 0;
    let topHandle  = null;
    let topSeñales = [];

    const seen = new Set();
    for (const post of posts.slice(0, 30)) {
      const handle = post.author?.handle;
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);

      try {
        const profile = await bluesky.getProfile(handle);
        if (!profile) continue;
        const c1 = capa1(profile, []);

        if (c1.veredicto === 'BOT' && c1.puntos > topScore) {
          // Intentar confirmar con Groq si hay clave disponible
          let score   = c1.puntos;
          let señales = c1.señales.map((s) => ({ señal: s }));

          if (process.env.GROQ_API_KEY) {
            try {
              const posts50 = await bluesky.getPostHistory(profile.did, 50);
              const g = await analizarConGroq(profile, posts50, c1);
              if (g.veredicto === 'BOT') {
                score   = g.confianza;
                señales = g.razones.map((r) => ({ señal: r }));
              }
            } catch { /* usar datos de capa 1 */ }
          }

          topScore   = score;
          topHandle  = handle;
          topSeñales = señales;
        }
      } catch { /* continuar */ }

      await sleep(400);
    }

    if (topHandle) {
      suspect = { handle: topHandle, score: topScore, señales: topSeñales };
    }
  }

  if (!suspect) {
    console.log('  ⚠️  Sin cuenta sospechosa para publicar hoy');
    return;
  }

  // ── Generar post — solo señales técnicas, sin datos privados ──────────────
  const señalesVisibles = (suspect.señales || [])
    .slice(0, 4)
    .map((s) => `• ${typeof s === 'string' ? s : (s?.señal || '')}`)
    .filter(Boolean);

  const texto = [
    `🔴 Bot-ID — CUENTA SOSPECHOSA DEL DÍA`,
    `━━━━━━━━━━━━━━━`,
    `@${suspect.handle}`,
    ``,
    `⚠️ Señales técnicas detectadas:`,
    ...señalesVisibles,
    ``,
    `Puntuación de riesgo: ${suspect.score}/130`,
    `━━━━━━━━━━━━━━━`,
    `🔍 Bot-ID | Transparencia digital`,
    `#BotID #Bots`,
  ].join('\n');

  const imagePath = await generarTarjetaReporte({
    fuente:     `@${suspect.handle}`,
    bots:       suspect.score,
    total:      130,
    porcentaje: Math.min(100, Math.round((suspect.score / 130) * 100)),
    nivel:      'ALTO',
    fecha:      fechaCorta(),
    labelBots:  'PUNTOS SOSPECHA',
  }).catch(() => null);

  await postear(bluesky, texto, imagePath, `Cuenta sospechosa del día detectada por Bot-ID`);
  console.log(`  ✅ POST 2 publicado (@${suspect.handle}, ${suspect.score}pts)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST 3 — 8pm México
// Resumen diario
// ─────────────────────────────────────────────────────────────────────────────

async function post3DailySummary(bluesky) {
  console.log('\n📊 [POST 3] Resumen del día...');

  const stats = getTodayStats();
  const fecha = fechaCorta();
  const pct   = stats.total > 0 ? Math.round((stats.bots / stats.total) * 100) : 0;

  const tagLine = stats.topHashtag
    ? `🏆 #${stats.topHashtag} — el más infestado (${stats.topBotCount} bots)`
    : `🏆 Sin hashtags destacados hoy`;

  const cierreFrase = stats.bots > 10
    ? `La manipulación digital es real. No pares de monitorear.`
    : stats.bots > 0
    ? `Actividad moderada. Seguimos monitoreando.`
    : `Día tranquilo. Sin manipulación masiva detectada.`;

  const texto = [
    `📊 Bot-ID — RESUMEN DEL DÍA`,
    `━━━━━━━━━━━━━━━`,
    `📅 ${fecha}`,
    ``,
    `🔍 Análisis realizados: ${stats.total}`,
    `🤖 Bots detectados: ${stats.bots}`,
    tagLine,
    ``,
    cierreFrase,
    `━━━━━━━━━━━━━━━`,
    `🔍 Bot-ID | Transparencia digital`,
    `#BotID #Transparencia #Bots`,
  ].join('\n');

  const imagePath = await generarTarjetaReporte({
    fuente:     stats.topHashtag ? `#${stats.topHashtag}` : 'Resumen',
    bots:       stats.bots,
    total:      Math.max(stats.total, 1),
    porcentaje: pct,
    nivel:      nivelDesdePct(pct),
    fecha,
    labelBots:  'BOTS DETECTADOS HOY',
  }).catch(() => null);

  await postear(bluesky, texto, imagePath, 'Resumen diario Bot-ID: bots detectados hoy');
  console.log(`  ✅ POST 3 publicado (${stats.total} análisis, ${stats.bots} bots, ${pct}%)`);
}

// ─── Programador ──────────────────────────────────────────────────────────────

export function scheduleDailyPosts(bluesky) {
  // POST 1: 9am México
  cron.schedule('0 9 * * *', () => {
    console.log('\n🕘 Disparando POST 1 (análisis matutino)...');
    post1MorningViral(bluesky).catch((err) =>
      console.error('❌ Error en POST 1:', err.message)
    );
  }, { timezone: TZ });

  // POST 2: 3pm México
  cron.schedule('0 15 * * *', () => {
    console.log('\n🕒 Disparando POST 2 (cuenta sospechosa del día)...');
    post2SuspiciousAccount(bluesky).catch((err) =>
      console.error('❌ Error en POST 2:', err.message)
    );
  }, { timezone: TZ });

  // POST 3: 8pm México
  cron.schedule('0 20 * * *', () => {
    console.log('\n🕗 Disparando POST 3 (resumen del día)...');
    post3DailySummary(bluesky).catch((err) =>
      console.error('❌ Error en POST 3:', err.message)
    );
  }, { timezone: TZ });

  console.log('📅 Posts diarios programados: 9am, 3pm, 8pm (hora México)');
}
