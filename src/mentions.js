/**
 * src/mentions.js
 * Sistema de escucha y respuesta de menciones — 3 modos de análisis
 *
 * MODO 1  — analiza @cuenta              → análisis individual
 * MODO 2a — escanea [url de post]        → escaneo de hilo por URL
 * MODO 2b — "escanea esta conversación"  → escaneo contextual del hilo actual
 * MODO 3  — escanea #hashtag             → escaneo de hashtag
 */

import fs from 'fs';
import { analyzeAccount, analyzeAccountsBatch } from './analyzer.js';
import { generateBotReport } from './claude.js';
import {
  saveAccount,
  saveWeeklyScan,
  isProcessed,
  markProcessed,
} from './database.js';
import { generarTarjetaReporte } from './imageGenerator.js';

// ─── Configuración ───────────────────────────────────────────────────────────

const MAX_PER_USER_PER_HOUR = parseInt(process.env.MAX_ANALYSES_PER_HOUR || '10', 10);
const BOT_THRESHOLD = 75;   // score >= este valor → bot (🔴)
const DUD_THRESHOLD = 50;   // score >= este valor → dudoso (🟡)
const MAX_THREAD_ACCOUNTS = 200;  // máximo de cuentas a analizar en un hilo
const MAX_HASHTAG_ACCOUNTS = 200; // máximo de cuentas a analizar en un hashtag

// Frases que activan el escaneo contextual del hilo actual (modo 2b)
const CONTEXTUAL_THREAD_RE = /escanea\s+esta\s+conversaci[oó]n|analiza\s+este\s+hilo|escanea\s+aqu[ií]|analiza\s+aqu[ií]|qui[eé]nes\s+son\s+bots\s+aqu[ií]|hay\s+bots\s+aqu[ií]/i;

// Rate limiting por usuario (en memoria, reset natural cada hora)
// Map<handle, number[]> — timestamps de cada solicitud
const userRequests = new Map();

// ─── Rate limiting ────────────────────────────────────────────────────────────

function countUserRequestsLastHour(handle) {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const times = (userRequests.get(handle) || []).filter((t) => t > oneHourAgo);
  userRequests.set(handle, times); // limpia entradas viejas
  return times.length;
}

function recordUserRequest(handle) {
  const times = userRequests.get(handle) || [];
  times.push(Date.now());
  userRequests.set(handle, times);
}

// ─── Detección de modo ────────────────────────────────────────────────────────

/**
 * Detecta qué modo usar según el texto y la estructura de la mención.
 * @param {string} text       - texto del post
 * @param {object} mention    - objeto completo de la notificación
 * @returns {'analyze'|'thread-context'|'thread-url'|'hashtag'|'unknown'}
 */
function detectMode(text, mention) {
  // Modo 2b: frases contextuales ("escanea esta conversación", etc.)
  // Prioridad alta — se comprueba antes que URLs para no confundir
  if (CONTEXTUAL_THREAD_RE.test(text)) {
    return 'thread-context';
  }
  // Modo 2a: contiene URL de bsky.app
  if (/https?:\/\/bsky\.app\/profile\/[\w.:-]+\/post\/\w+/.test(text)) {
    return 'thread-url';
  }
  // Modo 3: contiene #hashtag (que no sea parte de URL)
  if (/#\w+/.test(text.replace(/https?:\/\/\S+/g, ''))) {
    return 'hashtag';
  }
  // Modo 1: contiene otro @handle
  if (/@[\w.-]+/.test(text)) {
    return 'analyze';
  }
  return 'unknown';
}

/**
 * Extrae el handle objetivo del texto (ignorando el handle del bot)
 */
function extractTargetHandle(text, botHandle) {
  const botClean = (botHandle || '').replace('@', '').toLowerCase();
  const matches = text.match(/@[\w.-]+/g) || [];
  for (const m of matches) {
    const h = m.replace('@', '').toLowerCase();
    if (h !== botClean && h.length > 2) return h;
  }
  // Fallback: "analiza usuario.bsky.social" sin @
  const m = text.match(/analiz[ae]r?\s+([\w.-]+\.bsky\.social)/i);
  return m ? m[1] : null;
}

/**
 * Extrae la URL de bsky.app del texto
 */
function extractBskyUrl(text) {
  const m = text.match(/(https?:\/\/bsky\.app\/profile\/[\w.:-]+\/post\/\w+)/);
  return m ? m[1] : null;
}

/**
 * Extrae el hashtag del texto (sin el #)
 */
function extractHashtag(text) {
  const clean = text.replace(/https?:\/\/\S+/g, ''); // quita URLs
  const m = clean.match(/#(\w+)/);
  return m ? m[1] : null;
}

// ─── Helpers de formato ───────────────────────────────────────────────────────

function scoreEmoji(score) {
  if (score >= BOT_THRESHOLD) return '🔴';
  if (score >= DUD_THRESHOLD) return '🟡';
  return '🟢';
}

function nivelEmoji(nivel) {
  const map = { 'MUY ALTO': '🔴', 'ALTO': '🟠', 'MEDIO': '🟡', 'BAJO': '🟢' };
  return map[nivel] || '⚪';
}

/** Analiza una cuenta y devuelve {profileData, analysis} o null si falla */
async function analyzeOne(handle, blueskyClient, requestedBy = 'mentions') {
  const profileData = await blueskyClient.getProfile(handle);
  if (!profileData) return null;

  const postHistory = await blueskyClient.getPostHistory(profileData.did, 100);
  const analysis = analyzeAccount(profileData, postHistory);

  saveAccount({
    handle,
    did: profileData.did,
    score: analysis.score,
    nivel: analysis.nivel,
    señales: analysis.señales,
    requestedBy,
  });

  return { profileData, analysis };
}

// ─── MODO 1 — Análisis individual ────────────────────────────────────────────

async function handleModeAnalyze(mention, blueskyClient) {
  const requesterHandle = mention.author?.handle;
  const text = mention.record?.text || '';
  const targetHandle = extractTargetHandle(text, process.env.BLUESKY_USERNAME);

  if (!targetHandle) {
    return replyHelp(mention, blueskyClient);
  }

  console.log(`  [M1] Analizando @${targetHandle}...`);

  const result = await analyzeOne(targetHandle, blueskyClient, requesterHandle);

  if (!result) {
    await blueskyClient.replyToPost(
      mention.uri, mention.cid,
      `❌ Bot-ID no encontró el perfil @${targetHandle}. ¿El handle es correcto?`
    );
    return;
  }

  const { profileData, analysis } = result;
  const { score, nivel, señales } = analysis;
  const emoji = nivelEmoji(nivel);
  const top3 = señales.slice(0, 3).map((s) => `• ${s.señal}`).join('\n');

  // Intentar versión Claude para scores significativos
  let texto;
  if (score >= 35) {
    try {
      const report = await generateBotReport(profileData, analysis);
      texto = report.bluesky;
    } catch {
      texto = null;
    }
  }

  // Fallback: formato propio
  if (!texto) {
    texto = [
      `🤖 BOT-ID ANÁLISIS`,
      `━━━━━━━━━━━━━━━`,
      `Cuenta: @${targetHandle}`,
      `Probabilidad bot: ${score}%`,
      `Nivel: ${emoji} ${nivel}`,
      ``,
      top3 || `• Sin señales críticas`,
      ``,
      `📊 Bot-ID | Datos abiertos`,
    ].join('\n');
  }

  const nivelTarjeta = (nivel === 'BAJO') ? 'BAJO' : (nivel === 'MEDIO') ? 'MEDIO' : 'ALTO';
  const imagePath = await generarTarjetaReporte({
    fuente: `@${targetHandle}`,
    bots: score,
    total: 1,
    porcentaje: score,
    nivel: nivelTarjeta,
    fecha: fechaCorta(),
    labelBots: 'PROBABILIDAD BOT',
  }).catch(() => null);

  await replyConImagen(blueskyClient, mention, texto.slice(0, 299), imagePath);
  console.log(`  ✅ M1 respondido (@${targetHandle} → ${score}/100)`);
}

// ─── MODO 2 — Escaneo de hilo (lógica compartida) ────────────────────────────

/**
 * Escanea un hilo por su AT URI y responde con el reporte.
 * Usado tanto por el modo URL (2a) como por el modo contextual (2b).
 * @param {string} atUri          - AT URI del post raíz del hilo
 * @param {string} tituloHeader   - primera línea del reporte ("ESCANEO DE CONVERSACIÓN" o "ESCANEO DEL HILO")
 * @param {object} mention        - objeto de la notificación (para reply)
 * @param {object} blueskyClient
 */
async function scanAndReportThread(atUri, tituloHeader, mention, blueskyClient) {
  const requesterHandle = mention.author?.handle;

  const { participants } = await blueskyClient.getThread(atUri);
  if (participants.size === 0) {
    await blueskyClient.replyToPost(
      mention.uri, mention.cid,
      `❌ Bot-ID no encontró participantes en ese hilo.`
    );
    return;
  }

  // Analizar hasta MAX_THREAD_ACCOUNTS cuentas únicas — en paralelo
  const handlesList = [...participants.values()].slice(0, MAX_THREAD_ACCOUNTS).map(p => p.handle);
  const botsEncontrados = [];
  let analizados = 0;

  const batchResults = await analyzeAccountsBatch(handlesList, blueskyClient, { postLimit: 100 });
  for (const { handle, profileData, analysis } of batchResults) {
    analizados++;
    saveAccount({
      handle, did: profileData.did, score: analysis.score,
      nivel: analysis.nivel, señales: analysis.señales, requestedBy: requesterHandle,
    });
    if (analysis.score >= DUD_THRESHOLD) {
      botsEncontrados.push({ handle, score: analysis.score });
    }
  }

  botsEncontrados.sort((a, b) => b.score - a.score);
  const pct = analizados > 0 ? Math.round((botsEncontrados.length / analizados) * 100) : 0;

  let respuesta;
  if (botsEncontrados.length === 0) {
    respuesta = [
      `✅ BOT-ID — Hilo limpio`,
      `No se detectaron bots en esta conversación`,
      ``,
      `Bot-ID | Transparencia digital 🔍`,
    ].join('\n');
  } else {
    const listaTop = botsEncontrados
      .slice(0, 2)  // máx 2 para respetar el límite de 299 chars
      .map((b) => `${scoreEmoji(b.score)} @${b.handle} — ${b.score}% ${b.score >= BOT_THRESHOLD ? 'probabilidad bot' : 'dudoso'}`)
      .join('\n');

    respuesta = [
      `🔍 BOT-ID — ${tituloHeader}`,
      `━━━━━━━━━━━━━━━━━━━`,
      `👥 Participantes analizados: ${analizados}`,
      `🤖 Bots detectados: ${botsEncontrados.length} (${pct}%)`,
      ``,
      `Cuentas sospechosas:`,
      listaTop,
      ``,
      `⚠️ Esta conversación tiene manipulación artificial`,
      `━━━━━━━━━━━━━━━━━━━`,
      `Bot-ID | Transparencia digital 🔍`,
    ].join('\n');
  }

  const imagePath = await generarTarjetaReporte({
    fuente: 'Hilo',
    bots: botsEncontrados.length,
    total: analizados,
    porcentaje: pct,
    nivel: nivelDesdePct(pct),
    fecha: fechaCorta(),
  }).catch(() => null);

  await replyConImagen(blueskyClient, mention, respuesta.slice(0, 299), imagePath);
  console.log(`  ✅ Hilo escaneado (${botsEncontrados.length}/${analizados} bots)`);
}

// ─── MODO 2a — Escaneo de hilo por URL ───────────────────────────────────────

async function handleModeThreadUrl(mention, blueskyClient) {
  const text = mention.record?.text || '';
  const url = extractBskyUrl(text);

  if (!url) {
    return replyHelp(mention, blueskyClient);
  }

  console.log(`  [M2a] Escaneando hilo por URL: ${url}`);

  const atUri = await blueskyClient.bskyUrlToAtUri(url);
  if (!atUri) {
    await blueskyClient.replyToPost(
      mention.uri, mention.cid,
      `❌ Bot-ID no pudo acceder al post. ¿El enlace es correcto?`
    );
    return;
  }

  await scanAndReportThread(atUri, 'ESCANEO DE CONVERSACIÓN', mention, blueskyClient);
}

// ─── MODO 2b — Escaneo contextual del hilo actual ────────────────────────────

async function handleModeThreadContext(mention, blueskyClient) {
  // El AT URI raíz del hilo está en record.reply.root.uri
  // Si no hay reply, la mención está suelta (no dentro de un hilo)
  const rootUri = mention.record?.reply?.root?.uri;

  if (!rootUri) {
    await blueskyClient.replyToPost(
      mention.uri, mention.cid,
      `⚠️ Bot-ID no detectó un hilo activo. Usa este comando dentro de una conversación, o proporciona un enlace al post.`
    );
    return;
  }

  console.log(`  [M2b] Escaneo contextual del hilo: ${rootUri}`);
  await scanAndReportThread(rootUri, 'ESCANEO DEL HILO', mention, blueskyClient);
}

// ─── MODO 3 — Escaneo de hashtag ─────────────────────────────────────────────

async function handleModeHashtag(mention, blueskyClient) {
  const requesterHandle = mention.author?.handle;
  const text = mention.record?.text || '';
  const hashtag = extractHashtag(text);

  if (!hashtag) {
    return replyHelp(mention, blueskyClient);
  }

  console.log(`  [M3] Escaneando #${hashtag}...`);

  // Buscar posts con el hashtag
  const posts = await blueskyClient.searchHashtag(hashtag, 100);
  if (posts.length === 0) {
    await blueskyClient.replyToPost(
      mention.uri, mention.cid,
      `⚠️ Bot-ID no encontró posts recientes con #${hashtag}.`
    );
    return;
  }

  // Construir mapa de autores con conteo de posts
  const autoresMap = new Map(); // handle → { handle, did, postCount }
  for (const post of posts) {
    const { handle, did } = post.author || {};
    if (!handle) continue;
    const entry = autoresMap.get(handle) || { handle, did, postCount: 0 };
    entry.postCount++;
    autoresMap.set(handle, entry);
  }

  // Analizar hasta MAX_HASHTAG_ACCOUNTS cuentas únicas — en paralelo
  const autores = [...autoresMap.values()].slice(0, MAX_HASHTAG_ACCOUNTS);
  const botsEncontrados = [];
  let analizados = 0;

  const batchResults = await analyzeAccountsBatch(autores.map(a => a.handle), blueskyClient, { postLimit: 100 });
  for (const { handle, profileData, analysis } of batchResults) {
    analizados++;
    saveAccount({
      handle, did: profileData.did, score: analysis.score,
      nivel: analysis.nivel, señales: analysis.señales, requestedBy: requesterHandle,
    });
    const postCount = autoresMap.get(handle)?.postCount || 1;
    if (analysis.score >= DUD_THRESHOLD) {
      botsEncontrados.push({ handle, score: analysis.score, postCount });
    }
  }

  // Guardar en weekly_scans
  const hoy = new Date().toISOString().split('T')[0];
  if (analizados > 0) {
    saveWeeklyScan({
      hashtag,
      accountsFound: analizados,
      botsDetected: botsEncontrados.length,
      percentage: Math.round((botsEncontrados.length / analizados) * 100),
      weekStart: hoy,
      weekEnd: hoy,
    });
  }

  botsEncontrados.sort((a, b) => b.score - a.score);
  const pct = analizados > 0 ? Math.round((botsEncontrados.length / analizados) * 100) : 0;

  // Nivel de manipulación
  let nivelManip;
  if (pct >= 30) nivelManip = '🔴 ALTO';
  else if (pct >= 15) nivelManip = '🟡 MEDIO';
  else nivelManip = '🟢 BAJO';

  const topBots = botsEncontrados
    .slice(0, 2)
    .map((b) => `* @${b.handle} — ${b.postCount} posts, ${b.score}% bot`)
    .join('\n');

  const respuesta = [
    `📊 BOT-ID — REPORTE DE HASHTAG`,
    `#${hashtag} — últimas 2 horas`,
    `━━━━━━━━━━━━━━━━━━━`,
    `📝 Posts analizados: ${posts.length}`,
    `👥 Cuentas únicas: ${analizados}`,
    `🤖 Bots detectados: ${botsEncontrados.length} (${pct}%)`,
    ``,
    `Nivel de manipulación: ${nivelManip}`,
    botsEncontrados.length > 0 ? `\nTop bots más activos:\n${topBots}` : '',
    ``,
    `Bot-ID | Transparencia digital`,
  ].join('\n');

  const imagePath = await generarTarjetaReporte({
    fuente: `#${hashtag}`,
    bots: botsEncontrados.length,
    total: analizados,
    porcentaje: pct,
    nivel: nivelDesdePct(pct),
    fecha: fechaCorta(),
  }).catch(() => null);

  await replyConImagen(blueskyClient, mention, respuesta.slice(0, 299), imagePath);
  console.log(`  ✅ M3 respondido (#${hashtag} → ${botsEncontrados.length}/${analizados} bots)`);
}

// ─── Helpers de imagen ───────────────────────────────────────────────────────

/** Deriva nivel BAJO/MEDIO/ALTO desde un porcentaje */
function nivelDesdePct(pct) {
  if (pct >= 30) return 'ALTO';
  if (pct >= 15) return 'MEDIO';
  return 'BAJO';
}

/** Fecha corta formateada en español para las tarjetas */
function fechaCorta() {
  return new Date().toLocaleDateString('es-MX', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'America/Mexico_City',
  });
}

/**
 * Responde a una mención con imagen adjunta.
 * Si la generación de imagen falla, envía solo el texto.
 */
async function replyConImagen(blueskyClient, mention, texto, imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return blueskyClient.replyToPost(mention.uri, mention.cid, texto);
  }
  try {
    const imageData = fs.readFileSync(imagePath);
    const encoding = imagePath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    const blobRef = (await blueskyClient.agent.uploadBlob(imageData, { encoding })).data.blob;
    const truncated = texto.length > 299 ? texto.slice(0, 296) + '...' : texto;
    await blueskyClient.agent.post({
      text: truncated,
      reply: {
        root:   { uri: mention.uri, cid: mention.cid },
        parent: { uri: mention.uri, cid: mention.cid },
      },
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ image: blobRef, alt: 'Análisis Bot-ID' }],
      },
    });
  } catch (err) {
    console.warn(`⚠️  Sin imagen en reply: ${err.message}`);
    return blueskyClient.replyToPost(mention.uri, mention.cid, texto);
  }
}

// ─── MODO DESCONOCIDO — Detección automática de contexto ─────────────────────

async function handleModeUnknown(mention, blueskyClient) {
  // ¿La mención viene dentro de un hilo?
  const rootUri = mention.record?.reply?.root?.uri;
  if (rootUri) {
    console.log(`  [AUTO] Mención en hilo detectada → analizando conversación`);
    await scanAndReportThread(rootUri, 'ESCANEO AUTOMÁTICO', mention, blueskyClient);
    return;
  }

  // Sin contexto claro → mensaje amigable
  await blueskyClient.replyToPost(
    mention.uri, mention.cid,
    `¡Hola! Para analizar bots puedes:\n• Mencionarme en cualquier conversación\n• Enviarme un link de Bluesky\n• Escribir un #hashtag\n\nBot-ID | Transparencia digital`
  );
}

// ─── Mensaje de ayuda ─────────────────────────────────────────────────────────

async function replyHelp(mention, blueskyClient) {
  await blueskyClient.replyToPost(
    mention.uri, mention.cid,
    `🤖 Bot-ID — Comandos disponibles:\n* analiza @cuenta\n* escanea esta conversación\n* escanea [url conversación]\n* escanea #hashtag`
  );
}

// ─── Dispatcher principal ─────────────────────────────────────────────────────

async function processMention(mention, blueskyClient) {
  const mentionUri = mention.uri;
  const requesterHandle = mention.author?.handle || 'unknown';
  const text = mention.record?.text || '';

  // Deduplicación
  if (isProcessed(mentionUri)) return;

  // Rate limiting por usuario
  if (countUserRequestsLastHour(requesterHandle) >= MAX_PER_USER_PER_HOUR) {
    console.log(`  ⏸️  Rate limit para @${requesterHandle}`);
    await blueskyClient.replyToPost(
      mentionUri, mention.cid,
      `⏳ Límite alcanzado. Intenta en 1 hora.`
    );
    markProcessed({ mentionUri, requesterHandle, targetHandle: null });
    return;
  }

  const modo = detectMode(text, mention);
  console.log(`📬 Mención de @${requesterHandle} — modo: ${modo}`);

  recordUserRequest(requesterHandle);

  try {
    switch (modo) {
      case 'analyze':
        await handleModeAnalyze(mention, blueskyClient);
        break;
      case 'thread-context':
        await handleModeThreadContext(mention, blueskyClient);
        break;
      case 'thread-url':
        await handleModeThreadUrl(mention, blueskyClient);
        break;
      case 'hashtag':
        await handleModeHashtag(mention, blueskyClient);
        break;
      default:
        await handleModeUnknown(mention, blueskyClient);
    }
  } catch (err) {
    console.error(`  ❌ Error procesando mención (${modo}):`, err.message);
  }

  markProcessed({ mentionUri, requesterHandle, targetHandle: null });
}

// ─── Listener de polling ──────────────────────────────────────────────────────

export function startMentionsListener(blueskyClient) {
  let cursor;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const { mentions, cursor: newCursor } = await blueskyClient.getMentions(cursor);
      if (newCursor) cursor = newCursor;

      if (mentions.length > 0) {
        console.log(`\n📬 ${mentions.length} mención(es) nueva(s)`);
      }

      for (const mention of mentions) {
        try {
          await processMention(mention, blueskyClient);
          await sleep(2000);
        } catch (err) {
          console.error(`Error procesando mención ${mention.uri}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error en tick de menciones:', err.message);
    } finally {
      running = false;
    }
  };

  tick();
  const intervalo = setInterval(tick, 60 * 1000);
  console.log('📡 Listener de menciones activo (polling cada 60s)');
  return intervalo;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
