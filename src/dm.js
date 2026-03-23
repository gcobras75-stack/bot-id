/**
 * src/dm.js
 * MODO 3 — Listener de DMs privados
 *
 * Cada 2 minutos revisa conversaciones no leídas.
 * Cuando recibe un mensaje, analiza lo que pide (handle, URL o hashtag)
 * y responde SOLO en el DM. Sin posts públicos. 100 % discreto.
 *
 * Comandos reconocidos en el mensaje:
 *   @handle          → analiza esa cuenta
 *   https://bsky.app/…  → analiza el hilo de esa URL
 *   #hashtag         → analiza ese hashtag
 *   "analiza …"      → cualquiera de los anteriores con prefijo
 *   otro texto       → responde mensaje de ayuda
 */

import { capa1 } from './analyzer.js';
import { analizarConGroq } from './groq.js';
import { generateBotReport } from './claude.js';
import { saveAccount } from './database.js';

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

// IDs de mensajes ya procesados (resetea al reiniciar)
const processedMessages = new Set();

// ─── Parseo del mensaje ───────────────────────────────────────────────────────

function parseTarget(text) {
  // URL de Bluesky
  const urlMatch = text.match(/(https?:\/\/bsky\.app\/profile\/[\w.:-]+\/post\/\w+)/);
  if (urlMatch) return { type: 'thread-url', value: urlMatch[1] };

  // @handle explícito
  const handleMatch = text.match(/@([\w.-]+)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };

  // #hashtag
  const hashtagMatch = text.match(/#(\w+)/);
  if (hashtagMatch) return { type: 'hashtag', value: hashtagMatch[1] };

  // Texto sin @ ni # ni URL → buscar handle escrito sin @
  // Ej: "analiza spambot.bsky.social"
  const bareHandle = text.match(/\b([\w-]+\.bsky\.social)\b/i);
  if (bareHandle) return { type: 'handle', value: bareHandle[1] };

  return { type: 'unknown' };
}

// ─── Análisis de cuenta (capa 1 → groq → claude) ─────────────────────────────

async function analyzeHandleForDM(handle, bluesky) {
  const profileData = await bluesky.getProfile(handle);
  if (!profileData) return { ok: false, texto: `❌ No encontré el perfil @${handle}. ¿El handle es correcto?` };

  const postHistory = await bluesky.getPostHistory(profileData.did, 50);
  const c1 = capa1(profileData, postHistory);

  // BOT claro → responder directo
  if (c1.veredicto === 'BOT') {
    const señales = c1.señales.slice(0, 4).map((s) => `• ${s}`).join('\n');
    return {
      ok: true,
      texto: [
        `🔴 BOT DETECTADO — @${handle}`,
        `━━━━━━━━━━━━━━━`,
        `Puntuación Capa 1: ${c1.puntos}/130 pts`,
        señales,
        ``,
        `Bot-ID | Análisis privado`,
      ].join('\n'),
    };
  }

  // HUMANO claro → responder directo
  if (c1.veredicto === 'HUMANO') {
    return {
      ok: true,
      texto: [
        `🟢 CUENTA HUMANA — @${handle}`,
        `━━━━━━━━━━━━━━━`,
        `Sin señales de automatización (${c1.puntos}/130 pts)`,
        `Seguidores: ${profileData.followersCount ?? '?'} | Siguiendo: ${profileData.followsCount ?? '?'}`,
        ``,
        `Bot-ID | Análisis privado`,
      ].join('\n'),
    };
  }

  // SOSPECHOSO → Groq
  try {
    const g = await analizarConGroq(profileData, postHistory, c1);

    if (g.veredicto === 'BOT') {
      const razones = g.razones.slice(0, 4).map((r) => `• ${r}`).join('\n');
      return {
        ok: true,
        texto: [
          `🔴 BOT DETECTADO — @${handle}`,
          `━━━━━━━━━━━━━━━`,
          `Confianza: ${g.confianza}% (Groq/Llama)`,
          razones,
          ``,
          `Bot-ID | Análisis privado`,
        ].join('\n'),
      };
    }

    if (g.veredicto === 'HUMANO') {
      return {
        ok: true,
        texto: [
          `🟢 CUENTA HUMANA — @${handle}`,
          `━━━━━━━━━━━━━━━`,
          `Sin indicios de bot (confianza: ${g.confianza}%)`,
          ``,
          `Bot-ID | Análisis privado`,
        ].join('\n'),
      };
    }
    // INCIERTO → escala a Claude
  } catch (err) {
    console.warn(`  [DM] Groq falló: ${err.message} → escalando a Claude`);
  }

  // Capa 3: Claude API
  try {
    const { analyzeAccount } = await import('./analyzer.js');
    const analysis = analyzeAccount(profileData, postHistory);
    saveAccount({
      handle, did: profileData.did, score: analysis.score,
      nivel: analysis.nivel, señales: analysis.señales, requestedBy: 'dm',
    });

    const report = await generateBotReport(profileData, analysis);
    return { ok: true, texto: report.bluesky || `⚠️ Análisis completado para @${handle}. Score: ${analysis.score}%` };
  } catch (err) {
    return { ok: false, texto: `⚠️ Error al analizar @${handle}: ${err.message}` };
  }
}

// ─── Análisis de hilo por URL ─────────────────────────────────────────────────

async function analyzeThreadForDM(url, bluesky) {
  const atUri = await bluesky.bskyUrlToAtUri(url);
  if (!atUri) return { ok: false, texto: `❌ No pude acceder a ese enlace. ¿Es un link válido de Bluesky?` };

  const { participants } = await bluesky.getThread(atUri);
  if (participants.size === 0) return { ok: false, texto: `❌ No encontré participantes en ese hilo.` };

  const handles = [...participants.values()].slice(0, 20).map((p) => p.handle);
  const results = [];

  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      const c1 = capa1(profile, []);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto });
      await sleep(400);
    } catch { /* continuar con siguientes */ }
  }

  const bots = results.filter((r) => r.puntos > 60);
  const pct  = results.length > 0 ? Math.round((bots.length / results.length) * 100) : 0;
  const topBots = bots.slice(0, 5).map((b) => `• @${b.handle} (${b.puntos}pts)`).join('\n');

  return {
    ok: true,
    texto: [
      `🔍 ANÁLISIS DE HILO (privado)`,
      `━━━━━━━━━━━━━━━`,
      `👥 Participantes analizados: ${results.length}`,
      `🤖 Bots detectados: ${bots.length} (${pct}%)`,
      bots.length > 0 ? `\nCuentas sospechosas:\n${topBots}` : `\n✅ Sin bots detectados`,
      ``,
      `Bot-ID | Análisis privado`,
    ].join('\n'),
  };
}

// ─── Análisis de hashtag ──────────────────────────────────────────────────────

async function analyzeHashtagForDM(hashtag, bluesky) {
  const posts = await bluesky.searchHashtag(hashtag, 50);
  if (!posts.length) return { ok: false, texto: `⚠️ No encontré posts recientes con #${hashtag}.` };

  const autoresMap = new Map();
  for (const p of posts) {
    const { handle, did } = p.author || {};
    if (!handle) continue;
    autoresMap.set(handle, { handle, did });
  }

  const handles = [...autoresMap.keys()].slice(0, 20);
  const results = [];

  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      const c1 = capa1(profile, []);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto });
      await sleep(400);
    } catch { /* continuar */ }
  }

  const bots = results.filter((r) => r.puntos > 60);
  const pct  = results.length > 0 ? Math.round((bots.length / results.length) * 100) : 0;
  const topBots = bots.slice(0, 5).map((b) => `• @${b.handle} (${b.puntos}pts)`).join('\n');

  return {
    ok: true,
    texto: [
      `📊 ANÁLISIS DE #${hashtag} (privado)`,
      `━━━━━━━━━━━━━━━`,
      `📝 Posts encontrados: ${posts.length}`,
      `👥 Cuentas únicas analizadas: ${results.length}`,
      `🤖 Bots detectados: ${bots.length} (${pct}%)`,
      bots.length > 0 ? `\nCuentas sospechosas:\n${topBots}` : `\n✅ Sin bots detectados`,
      ``,
      `Bot-ID | Análisis privado`,
    ].join('\n'),
  };
}

// ─── Procesamiento de un DM ───────────────────────────────────────────────────

async function processDM(convo, bluesky) {
  const convoId = convo.id;
  const botDid  = bluesky.agent.session?.did;

  // Obtener mensajes no leídos
  const messages = await bluesky.getConvoMessages(convoId, 10);
  if (!messages.length) return;

  // Encontrar el último mensaje del otro usuario (no del bot)
  const incoming = messages.find((m) => {
    const senderId = m.sender?.did;
    return senderId && senderId !== botDid && !processedMessages.has(m.id);
  });
  if (!incoming) return;

  const msgId = incoming.id;
  const text  = incoming.text || '';
  const senderDid = incoming.sender?.did;

  console.log(`📨 [DM] convo=${convoId.slice(0, 8)} | "${text.slice(0, 60)}"`);

  const target = parseTarget(text);
  let respuesta;

  switch (target.type) {
    case 'handle':
      respuesta = await analyzeHandleForDM(target.value, bluesky);
      break;
    case 'thread-url':
      respuesta = await analyzeThreadForDM(target.value, bluesky);
      break;
    case 'hashtag':
      respuesta = await analyzeHashtagForDM(target.value, bluesky);
      break;
    default:
      respuesta = {
        ok: false,
        texto: [
          `🤖 Bot-ID — Análisis privado`,
          `━━━━━━━━━━━━━━━`,
          `Puedo analizar:`,
          `• @handle — analiza una cuenta`,
          `• https://bsky.app/… — analiza un hilo`,
          `• #hashtag — analiza un hashtag`,
          ``,
          `Envíame uno de esos y te respondo aquí en privado.`,
        ].join('\n'),
      };
  }

  await bluesky.sendDM(convoId, respuesta.texto);
  processedMessages.add(msgId);
  await bluesky.markConvoRead(convoId, msgId);
  console.log(`  ✅ [DM] Respuesta enviada (tipo: ${target.type})`);
}

// ─── Listener principal ───────────────────────────────────────────────────────

export function startDMListener(bluesky) {
  const tick = async () => {
    try {
      const convos = await bluesky.listUnreadConvos();
      if (convos.length > 0) {
        console.log(`\n📨 ${convos.length} DM(s) no leído(s)`);
        for (const convo of convos) {
          await processDM(convo, bluesky);
          await sleep(1000);
        }
      }
    } catch (err) {
      console.error('❌ Error en listener de DMs:', err.message);
    }
  };

  // Primera revisión al arrancar
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
  console.log('📨 Listener de DMs activo (cada 2 min) — modo silencioso');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
