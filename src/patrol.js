/**
 * src/patrol.js
 * MODO 1 — Patrulla proactiva de hilos
 *
 * Cada 10 minutos busca posts en hashtags vigilados y analiza los participantes
 * de esas conversaciones. Si > 20 % de las cuentas son bots (capa 1), publica
 * una alerta pública en ese hilo.
 *
 * Reglas:
 *   - Máx 1 intervención por hilo (intervenedThreads).
 *   - Mínimo 10 min entre cualquier intervención (cooldown global).
 *   - Respeta opt-out: si alguien responde "para"/"stop" a la alerta,
 *     el hilo se agrega a optedOut (gestionado en mentions.js).
 */

import { capa1 } from './analyzer.js';
import {
  optedOut,
  intervenedThreads,
  getLastPatrolIntervention,
  setLastPatrolIntervention,
} from './state.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const PATROL_INTERVAL_MS   = 10 * 60 * 1000; // 10 minutos
const INTERVENTION_COOLDOWN = 10 * 60 * 1000; // 10 min entre intervenciones
const BOT_THRESHOLD_CAPA1  = 60;             // puntos mínimos para contar como "bot"
const BOT_PCT_TRIGGER      = 20;             // % mínimo de bots para intervenir
const MAX_PARTICIPANTS     = 20;             // máx cuentas a analizar por hilo
const MAX_POSTS_PER_TAG    = 8;              // posts por hashtag en cada ronda

// Hashtags vigilados (rotan cada ronda)
const PATROL_HASHTAGS = [
  'política', 'noticias', 'México', 'elecciones', 'gobierno',
  'sheinbaum', 'oposición', 'congreso', 'democracia', 'corrupción',
  'economía', 'seguridad', 'reforma', 'senado', 'diputados',
];

let patrolRound = 0; // controla rotación de hashtags

// ─── Análisis rápido de participantes con capa 1 ──────────────────────────────

/**
 * Obtiene perfiles y ejecuta capa 1 sobre la lista de handles.
 * Usa solo profileData (sin historial de posts) para ser rápido.
 * @param {string[]} handles
 * @param {import('./bluesky.js').BlueskyClient} bluesky
 * @returns {Promise<{handle: string, puntos: number, veredicto: string}[]>}
 */
async function patrolBatch(handles, bluesky) {
  const results = [];
  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      const c1 = capa1(profile, []);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto });
      await sleep(500); // evitar burst en la API
    } catch (err) {
      console.warn(`  [patrol] Error analizando @${handle}: ${err.message}`);
    }
  }
  return results;
}

// ─── Intervención pública en el hilo ─────────────────────────────────────────

/**
 * Publica una alerta pública en el hilo si supera el umbral de bots.
 */
async function interveneInThread(rootPost, bots, total, botList, bluesky) {
  const pct = Math.round((bots / total) * 100);
  const topBots = botList.slice(0, 3).map((b) => `@${b.handle}`).join(', ');

  const texto = [
    `🚨 Bot-ID detectó actividad automatizada aquí`,
    `━━━━━━━━━━━━━━━━━━━`,
    `🤖 ${bots} de ${total} cuentas analizadas son bots (${pct}%)`,
    `Cuentas sospechosas: ${topBots}`,
    ``,
    `Para detener el monitoreo responde: para`,
    `Bot-ID | Transparencia digital`,
  ].join('\n');

  try {
    await bluesky.agent.post({
      text: texto.slice(0, 299),
      reply: {
        root:   { uri: rootPost.uri, cid: rootPost.cid },
        parent: { uri: rootPost.uri, cid: rootPost.cid },
      },
    });
    console.log(`  ✅ [patrol] Alerta publicada en ${rootPost.uri} (${pct}% bots)`);
  } catch (err) {
    console.error(`  ❌ [patrol] Error publicando alerta: ${err.message}`);
  }
}

// ─── Ciclo principal del patrullero ──────────────────────────────────────────

async function runPatrolTick(bluesky) {
  // Cooldown global entre intervenciones
  const now = Date.now();
  const sinceLastIntervention = now - getLastPatrolIntervention();

  // Seleccionar 2 hashtags de forma rotatoria
  const tagA = PATROL_HASHTAGS[patrolRound % PATROL_HASHTAGS.length];
  const tagB = PATROL_HASHTAGS[(patrolRound + 1) % PATROL_HASHTAGS.length];
  patrolRound += 2;

  console.log(`\n🚔 [patrol] Ronda ${patrolRound / 2} — #${tagA}, #${tagB}`);

  for (const hashtag of [tagA, tagB]) {
    try {
      const posts = await bluesky.searchHashtag(hashtag, MAX_POSTS_PER_TAG);
      if (!posts.length) continue;

      // Agrupar por hilo raíz
      const threadRoots = new Map(); // rootUri → rootPost
      for (const post of posts) {
        const rootUri = post.record?.reply?.root?.uri || post.uri;
        if (!threadRoots.has(rootUri)) {
          // rootPost: necesitamos uri y cid para hacer el reply
          const rootPostObj = post.record?.reply?.root
            ? { uri: post.record.reply.root.uri, cid: post.record.reply.root.cid }
            : { uri: post.uri, cid: post.cid };
          threadRoots.set(rootUri, rootPostObj);
        }
      }

      for (const [rootUri, rootPost] of threadRoots) {
        // Saltar hilos ya intervenidos u optados-out
        if (intervenedThreads.has(rootUri) || optedOut.has(rootUri)) continue;

        // Obtener participantes del hilo
        const { participants } = await bluesky.getThread(rootUri);
        if (participants.size < 3) continue; // demasiado pequeño para valer la pena

        const botHandle = (process.env.BLUESKY_USERNAME || '').replace('@', '').toLowerCase();
        const handles = [...participants.values()]
          .filter((p) => p.handle.toLowerCase() !== botHandle)
          .slice(0, MAX_PARTICIPANTS)
          .map((p) => p.handle);

        if (handles.length < 3) continue;

        // Análisis capa 1 rápido
        const results = await patrolBatch(handles, bluesky);
        const botsDetected = results.filter((r) => r.puntos > BOT_THRESHOLD_CAPA1);
        const pct = Math.round((botsDetected.length / results.length) * 100);

        console.log(`  [patrol] #${hashtag} hilo ${rootUri.slice(-8)}: ${botsDetected.length}/${results.length} bots (${pct}%)`);

        if (pct >= BOT_PCT_TRIGGER && sinceLastIntervention >= INTERVENTION_COOLDOWN) {
          intervenedThreads.add(rootUri);
          setLastPatrolIntervention(Date.now());
          await interveneInThread(rootPost, botsDetected.length, results.length, botsDetected, bluesky);
          await sleep(3000); // pausa entre intervenciones sucesivas
        }
      }
    } catch (err) {
      console.error(`  ❌ [patrol] Error en #${hashtag}: ${err.message}`);
    }

    await sleep(2000); // pausa entre hashtags
  }
}

// ─── Arranque del patrullero ──────────────────────────────────────────────────

export function startPatrol(bluesky) {
  const tick = async () => {
    try {
      await runPatrolTick(bluesky);
    } catch (err) {
      console.error('❌ Error en ciclo de patrulla:', err.message);
    }
  };

  // Primera patrulla con retraso de 2 min (evita sobrecarga en el arranque)
  setTimeout(tick, 2 * 60 * 1000);
  setInterval(tick, PATROL_INTERVAL_MS);

  console.log('🚔 Patrulla proactiva activa (cada 10 min)');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
