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
import { saveAccount, getDb } from './database.js';
import {
  buildUserContext, incrementDailyCount, billAnalysis, creditUser,
  formatPlanInfo, formatTarifas, getOrCreateUser,
} from './plans.js';
import { detectCoordinatedNetwork, formatCoordinationResult } from './coordination.js';
import { getCostToday, getGroqUsageToday, getCostThisMonth } from './costMonitor.js';

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

// ─── Análisis de hilo con detección de red coordinada ────────────────────────

async function analyzeThreadForDMWithCoordination(url, bluesky, ctx) {
  const atUri = await bluesky.bskyUrlToAtUri(url);
  if (!atUri) return { ok: false, texto: `❌ No pude acceder a ese enlace. ¿Es un link válido de Bluesky?` };

  const { participants } = await bluesky.getThread(atUri);
  if (participants.size === 0) return { ok: false, texto: `❌ No encontré participantes en ese hilo.` };

  const handles = [...participants.values()].slice(0, ctx.maxCuentas).map((p) => p.handle);
  const results = [];
  const accountsData = [];

  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      const posts = ctx.canUseCoordination ? await bluesky.getPostHistory(profile.did, 15) : [];
      const c1 = capa1(profile, posts);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto });
      if (ctx.canUseCoordination) accountsData.push({ handle, profile, posts });
      await sleep(400);
    } catch { /* continuar con siguientes */ }
  }

  const bots    = results.filter((r) => r.puntos > 60);
  const pct     = results.length > 0 ? Math.round((bots.length / results.length) * 100) : 0;
  const topBots = bots.slice(0, 5).map((b) => `• @${b.handle} (${b.puntos}pts)`).join('\n');

  const lines = [
    `🔍 ANÁLISIS DE HILO (privado)`,
    `━━━━━━━━━━━━━━━`,
    `👥 Participantes analizados: ${results.length}`,
    `🤖 Bots detectados: ${bots.length} (${pct}%)`,
    bots.length > 0 ? `\nCuentas sospechosas:\n${topBots}` : `\n✅ Sin bots detectados`,
  ];

  if (ctx.canUseCoordination && accountsData.length >= 3) {
    const coord = detectCoordinatedNetwork(accountsData);
    lines.push(``, formatCoordinationResult(coord));
  } else if (!ctx.canUseCoordination) {
    lines.push(``, `🕸️ Detección de redes coordinadas disponible en plan Prepago.`);
  }

  lines.push(``, `Bot-ID | Análisis privado`);

  if (ctx.plan === 'PREPAGO') billAnalysis(ctx.handle, results.length);

  return { ok: true, texto: lines.join('\n') };
}

// ─── Análisis de hashtag con detección de red coordinada ─────────────────────

async function analyzeHashtagForDMWithCoordination(hashtag, bluesky, ctx) {
  const posts = await bluesky.searchHashtag(hashtag, 50);
  if (!posts.length) return { ok: false, texto: `⚠️ No encontré posts recientes con #${hashtag}.` };

  const autoresMap = new Map();
  for (const p of posts) {
    const { handle, did } = p.author || {};
    if (!handle) continue;
    if (!autoresMap.has(handle)) autoresMap.set(handle, { handle, did });
  }

  const handles = [...autoresMap.keys()].slice(0, ctx.maxCuentas);
  const results = [];
  const accountsData = [];

  for (const handle of handles) {
    try {
      const profile = await bluesky.getProfile(handle);
      if (!profile) continue;
      // Collect posts for coordination detection only for paid plans (perf saving)
      const postHistory = ctx.canUseCoordination ? await bluesky.getPostHistory(profile.did, 15) : [];
      const c1 = capa1(profile, postHistory);
      results.push({ handle, puntos: c1.puntos, veredicto: c1.veredicto });
      if (ctx.canUseCoordination) accountsData.push({ handle, profile, posts: postHistory });
      await sleep(400);
    } catch { /* continuar */ }
  }

  const bots    = results.filter((r) => r.puntos > 60);
  const pct     = results.length > 0 ? Math.round((bots.length / results.length) * 100) : 0;
  const topBots = bots.slice(0, 5).map((b) => `• @${b.handle} (${b.puntos}pts)`).join('\n');

  const lines = [
    `📊 ANÁLISIS DE #${hashtag} (privado)`,
    `━━━━━━━━━━━━━━━`,
    `📝 Posts encontrados: ${posts.length}`,
    `👥 Cuentas únicas analizadas: ${results.length}`,
    `🤖 Bots detectados: ${bots.length} (${pct}%)`,
    bots.length > 0 ? `\nCuentas sospechosas:\n${topBots}` : `\n✅ Sin bots detectados`,
  ];

  if (ctx.canUseCoordination && accountsData.length >= 3) {
    const coord = detectCoordinatedNetwork(accountsData);
    lines.push(``, formatCoordinationResult(coord));
  } else if (!ctx.canUseCoordination) {
    lines.push(``, `🕸️ Detección de redes coordinadas disponible en plan Prepago.`);
  }

  lines.push(``, `Bot-ID | Análisis privado`);

  if (ctx.plan === 'PREPAGO') billAnalysis(ctx.handle, results.length);

  return { ok: true, texto: lines.join('\n') };
}

// ─── Comandos de administrador ────────────────────────────────────────────────

const ADMIN_HANDLES = (process.env.ADMIN_BLUESKY_HANDLE || 'duendess.bsky.social,katya19.bsky.social')
  .split(',')
  .map((h) => h.trim().replace('@', '').toLowerCase())
  .filter(Boolean);

// Asegurarse de incluir a katya19 (y duendess) como administradores defaults
if (!ADMIN_HANDLES.includes('katya19.bsky.social')) ADMIN_HANDLES.push('katya19.bsky.social');
if (!ADMIN_HANDLES.includes('duendess.bsky.social')) ADMIN_HANDLES.push('duendess.bsky.social');

/**
 * Compara el handle del remitente contra administradores permitidos.
 * Tolerante a si el handle tiene dominio (ej: "duendess" == "duendess.bsky.social").
 */
function isAdmin(handle) {
  if (ADMIN_HANDLES.length === 0) return false;
  const h = handle.toLowerCase();
  return ADMIN_HANDLES.some(
    (admin) => h === admin || h.startsWith(admin + '.') || admin.startsWith(h + '.')
  );
}

/**
 * Detecta comandos !admin <subcomando>.
 * Solo disponibles para el handle configurado en ADMIN_BLUESKY_HANDLE.
 */
function parseAdminCommand(text) {
  const t = text.trim().toLowerCase();
  if (/^!admin\s+stats?\b/i.test(t))  return { type: 'admin-stats' };
  if (/^!admin\s+test\b/i.test(t))    return { type: 'admin-test' };
  if (/^!admin\s+status\b/i.test(t))  return { type: 'admin-status' };
  return null;
}

/**
 * Construye estadísticas del día desde la base de datos.
 */
function getTodayDbStats() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const db = getDb();
    const accounts = db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN score >= 60 THEN 1 ELSE 0 END) as bots
       FROM accounts_analyzed WHERE analyzed_at LIKE ?`
    ).get(`${today}%`);
    const users = db.prepare('SELECT COUNT(*) as total FROM users').get();
    return {
      totalAnalyzed: accounts?.total || 0,
      botsDetected:  accounts?.bots  || 0,
      totalUsers:    users?.total    || 0,
    };
  } catch {
    return { totalAnalyzed: 0, botsDetected: 0, totalUsers: 0 };
  }
}

async function handleAdminCommand(cmd, bluesky, convoId, senderHandle) {
  switch (cmd.type) {

    case 'admin-stats': {
      const claude = getCostToday();
      const groq   = getGroqUsageToday();
      const mes    = getCostThisMonth();
      const db     = getTodayDbStats();
      const pct    = db.totalAnalyzed > 0
        ? Math.round((db.botsDetected / db.totalAnalyzed) * 100) : 0;
      const hora   = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });

      return [
        `📊 Bot-ID — Estadísticas del día`,
        `━━━━━━━━━━━━━━━`,
        `🤖 Cuentas analizadas: ${db.totalAnalyzed}`,
        `🔴 Bots detectados: ${db.botsDetected} (${pct}%)`,
        `👥 Usuarios en DB: ${db.totalUsers}`,
        `━━━━━━━━━━━━━━━`,
        `💰 Claude API: $${claude.total.toFixed(4)} USD (${claude.calls} llamadas)`,
        `🆓 Groq API: ${groq.tokens.toLocaleString()} tokens (${groq.calls} llamadas)`,
        `💵 Mes en curso: $${mes.total.toFixed(4)} USD`,
        `━━━━━━━━━━━━━━━`,
        `🕐 Hora México: ${hora}`,
        `🔍 Bot-ID | Admin Panel`,
      ].join('\n');
    }

    case 'admin-status': {
      const db  = getTodayDbStats();
      const mes = getCostThisMonth();
      const allTime = (() => {
        try {
          const row = getDb().prepare('SELECT COUNT(*) as t FROM accounts_analyzed').get();
          return row?.t || 0;
        } catch { return 0; }
      })();
      const uptimeMs  = process.uptime() * 1000;
      const uptimeH   = Math.floor(uptimeMs / 3_600_000);
      const uptimeMin = Math.floor((uptimeMs % 3_600_000) / 60_000);

      return [
        `⚙️ Bot-ID — Estado del sistema`,
        `━━━━━━━━━━━━━━━`,
        `✅ Menciones: activo (cada 60s)`,
        `✅ Patrulla: activo (cada 10min)`,
        `✅ DM listener: activo (cada 2min)`,
        `✅ Scanner: activo (cada 6h)`,
        `✅ Posts diarios: 9am / 3pm / 8pm`,
        `━━━━━━━━━━━━━━━`,
        `🗄️ Base de datos`,
        `  • Total histórico: ${allTime} cuentas`,
        `  • Hoy analizadas: ${db.totalAnalyzed}`,
        `  • Usuarios registrados: ${db.totalUsers}`,
        `━━━━━━━━━━━━━━━`,
        `⏱️ Uptime: ${uptimeH}h ${uptimeMin}min`,
        `💵 Costo mes: $${mes.total.toFixed(4)} USD`,
        `👤 Admins: ${ADMIN_HANDLES.map(a => '@'+a).join(', ')} | Plan: EMPRESARIAL`,
      ].join('\n');
    }

    case 'admin-test': {
      // Ack inmediato para que el admin sepa que arrancó
      await bluesky.sendDM(convoId,
        `🧪 Iniciando reporte empresarial...\nBuscando hashtags activos, esto tarda ~1 min.`
      );

      // Probar hashtags en orden hasta encontrar uno con posts suficientes
      const CANDIDATOS = ['iran', 'guerra', 'mexico', 'elecciones', 'politica', 'noticias'];
      let mejorHashtag = 'mexico';
      let mejorPosts   = [];

      for (const ht of CANDIDATOS) {
        try {
          const p = await bluesky.searchHashtag(ht, 50);
          console.log(`  [admin-test] #${ht}: ${p.length} posts`);
          if (p.length > mejorPosts.length) {
            mejorPosts   = p;
            mejorHashtag = ht;
          }
          if (mejorPosts.length >= 30) break; // suficiente
        } catch { /* seguir */ }
      }

      const ctx = {
        handle: senderHandle,
        plan: 'EMPRESARIAL',
        canUseCoordination: true,
        maxCuentas: 30,
        canProceed: true,
        blockMessage: null,
      };

      // Ejecutar análisis completo
      const result = await analyzeHashtagForDMWithCoordination(mejorHashtag, bluesky, ctx);

      // DM 1: encabezado
      await bluesky.sendDM(convoId,
        `🧪 REPORTE EMPRESARIAL — #${mejorHashtag}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📝 Posts escaneados: ${mejorPosts.length}\n` +
        `🏢 Plan: EMPRESARIAL | Red coordinada: ✅`
      );

      await sleep(1000);

      // DM 2: análisis completo
      await bluesky.sendDM(convoId, result.texto);

      console.log(`  ✅ [admin-test] Reporte enviado — #${mejorHashtag} (${result.texto.length} chars)`);
      return null; // ya manejado internamente
    }

    default:
      return null;
  }
}

/**
 * Intenta parsear un comando de plan/admin.
 * @returns {{ type: string, args: any }|null}
 */
function parsePlanCommand(text) {
  const t = text.trim();

  if (/^!(plan|saldo|balance)\b/i.test(t))  return { type: 'plan-info' };
  if (/^!(tarifas|precios)\b/i.test(t))      return { type: 'tarifas' };
  if (/^!ayuda\b/i.test(t))                  return { type: 'help' };

  // Admin: !creditar @handle 50
  const creditMatch = t.match(/^!creditar\s+@?([\w.-]+)\s+(\d+(?:\.\d+)?)/i);
  if (creditMatch) return { type: 'admin-credit', handle: creditMatch[1], amount: parseFloat(creditMatch[2]) };

  // Admin: !empresarial @handle
  const empMatch = t.match(/^!empresarial\s+@?([\w.-]+)/i);
  if (empMatch) return { type: 'admin-empresarial', handle: empMatch[1] };

  // Admin: !usuario @handle  (ver info)
  const userMatch = t.match(/^!usuario\s+@?([\w.-]+)/i);
  if (userMatch) return { type: 'admin-user-info', handle: userMatch[1] };

  return null;
}

async function handlePlanCommand(cmd, senderHandle, convoId, bluesky) {
  switch (cmd.type) {
    case 'plan-info':
      return formatPlanInfo(senderHandle);

    case 'tarifas':
      return formatTarifas();

    case 'help':
      return [
        `🤖 Bot-ID — Comandos disponibles`,
        `━━━━━━━━━━━━━━━`,
        `• @handle — analiza una cuenta`,
        `• URL bsky.app — analiza un hilo`,
        `• #hashtag — analiza un hashtag`,
        ``,
        `• !plan / !saldo — ver tu plan y saldo`,
        `• !tarifas — ver precios`,
        `• !ayuda — este menú`,
        ``,
        `🔍 Bot-ID | Transparencia digital`,
      ].join('\n');

    case 'admin-credit':
      if (!isAdmin(senderHandle)) return `❌ Solo el administrador puede ejecutar este comando.`;
      creditUser(cmd.handle, cmd.amount);
      return `✅ Acreditados $${cmd.amount} MXN a @${cmd.handle}. Plan actualizado a Prepago si era FREE.`;

    case 'admin-empresarial':
      if (!isAdmin(senderHandle)) return `❌ Solo el administrador puede ejecutar este comando.`;
      creditUser(cmd.handle, 0, 'EMPRESARIAL');
      return `✅ @${cmd.handle} actualizado a plan Empresarial.`;

    case 'admin-user-info': {
      if (!isAdmin(senderHandle)) return `❌ Solo el administrador puede ejecutar este comando.`;
      const u = getOrCreateUser(cmd.handle);
      return [
        `👤 @${cmd.handle}`,
        `Plan: ${u.plan}`,
        `Saldo: $${(u.balance_mxn ?? 0).toFixed(2)} MXN`,
        `Uso hoy: ${u.daily_count}`,
        `Registro: ${u.created_at?.split('T')[0] ?? 'N/A'}`,
      ].join('\n');
    }

    default:
      return null;
  }
}

// ─── Procesamiento de un DM ───────────────────────────────────────────────────

async function processDM(convo, bluesky) {
  const convoId = convo.id;
  const botDid  = bluesky.agent.session?.did;

  const messages = await bluesky.getConvoMessages(convoId, 10);
  if (!messages.length) return;

  const incoming = messages.find((m) => {
    const senderId = m.sender?.did;
    return senderId && senderId !== botDid && !processedMessages.has(m.id);
  });
  if (!incoming) return;

  const msgId      = incoming.id;
  const text       = incoming.text || '';

  // Resolve sender handle from the convo members list
  const senderDid  = incoming.sender?.did;
  const senderMember = (convo.members || []).find((m) => m.did === senderDid);
  const senderHandle = senderMember?.handle || senderDid || 'unknown';

  console.log(`📨 [DM] @${senderHandle}: "${text.slice(0, 60)}" | isAdmin=${isAdmin(senderHandle)}`);

  // ── Comandos !admin (solo para el admin) ─────────────────────────────────
  if (isAdmin(senderHandle)) {
    const adminCmd = parseAdminCommand(text);
    if (adminCmd) {
      const reply = await handleAdminCommand(adminCmd, bluesky, convoId, senderHandle);
      // reply===null significa que handleAdminCommand ya envió los DMs internamente
      if (reply) {
        await bluesky.sendDM(convoId, reply);
      }
      processedMessages.add(msgId);
      await bluesky.markConvoRead(convoId, msgId);
      console.log(`  ✅ [DM] Admin comando: ${adminCmd.type}`);
      return;
    }
  }

  // ── Plan/admin commands — check first ────────────────────────────────────
  const planCmd = parsePlanCommand(text);
  if (planCmd) {
    const reply = await handlePlanCommand(planCmd, senderHandle, convoId, bluesky);
    if (reply) {
      await bluesky.sendDM(convoId, reply);
      processedMessages.add(msgId);
      await bluesky.markConvoRead(convoId, msgId);
      console.log(`  ✅ [DM] Comando de plan: ${planCmd.type}`);
      return;
    }
  }

  // ── Plan gate for analysis ────────────────────────────────────────────────
  // El admin siempre obtiene contexto EMPRESARIAL, sin importar el estado en DB
  const ctx = isAdmin(senderHandle)
    ? { handle: senderHandle, plan: 'EMPRESARIAL', canUseCoordination: true,
        maxCuentas: 5000, canProceed: true, blockMessage: null }
    : buildUserContext(senderHandle);

  if (!ctx.canProceed) {
    await bluesky.sendDM(convoId, ctx.blockMessage);
    processedMessages.add(msgId);
    await bluesky.markConvoRead(convoId, msgId);
    console.log(`  ⛔ [DM] Plan bloqueado para @${senderHandle}`);
    return;
  }

  // ── Analysis dispatch ─────────────────────────────────────────────────────
  const target = parseTarget(text);
  let respuesta;

  switch (target.type) {
    case 'handle':
      respuesta = await analyzeHandleForDM(target.value, bluesky);
      break;
    case 'thread-url':
      respuesta = await analyzeThreadForDMWithCoordination(target.value, bluesky, ctx);
      break;
    case 'hashtag':
      respuesta = await analyzeHashtagForDMWithCoordination(target.value, bluesky, ctx);
      break;
    default:
      respuesta = {
        ok: true,
        texto: [
          `🤖 Bot-ID — Análisis privado`,
          `━━━━━━━━━━━━━━━`,
          `Puedo analizar:`,
          `• @handle — analiza una cuenta`,
          `• https://bsky.app/… — analiza un hilo`,
          `• #hashtag — analiza un hashtag`,
          ``,
          `• !plan — ver tu plan y saldo`,
          `• !tarifas — ver precios`,
        ].join('\n'),
      };
  }

  // Incrementar uso y cobrar si PREPAGO
  if (target.type !== 'unknown') {
    incrementDailyCount(senderHandle);
  }

  await bluesky.sendDM(convoId, respuesta.texto);
  processedMessages.add(msgId);
  await bluesky.markConvoRead(convoId, msgId);
  console.log(`  ✅ [DM] Respuesta enviada (tipo: ${target.type} | plan: ${ctx.plan})`);
}

// ─── Listener principal ───────────────────────────────────────────────────────

export function startDMListener(bluesky) {
  // Log de diagnóstico: mostrar qué handle de admin se cargó
  console.log(`👤 [admin] ADMIN_BLUESKY_HANDLE="${process.env.ADMIN_BLUESKY_HANDLE || '(no configurado)'}" → ADMIN_HANDLES="${ADMIN_HANDLES.join(', ')}"`);

  // Auto-elevar al admin a plan EMPRESARIAL si aún no lo es
  if (ADMIN_HANDLES.length > 0) {
    for (const admin of ADMIN_HANDLES) {
      try {
        creditUser(admin, 0, 'EMPRESARIAL');
        console.log(`👤 [admin] @${admin} configurado como EMPRESARIAL`);
      } catch (err) {
        console.warn(`⚠️ [admin] No se pudo configurar plan admin para @${admin}: ${err.message}`);
      }
    }
  } else {
    console.warn('⚠️ [admin] No hay administradores configurados');
  }

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

/**
 * Envía un reporte de prueba por DM al admin al iniciar el bot.
 * Simula el formato completo de un cliente EMPRESARIAL.
 * @param {import('./bluesky.js').BlueskyClient} bluesky
 */
export async function sendAdminStartupReport(bluesky) {
  if (ADMIN_HANDLES.length === 0) return;

  // Buscar el hashtag con más actividad real
  const CANDIDATOS = ['iran', 'guerra', 'mexico', 'elecciones', 'politica', 'noticias'];
  let mejorHashtag = 'mexico';
  let mejorPosts   = [];

  for (const ht of CANDIDATOS) {
    try {
      const p = await bluesky.searchHashtag(ht, 50);
      if (p.length > mejorPosts.length) { mejorPosts = p; mejorHashtag = ht; }
      if (mejorPosts.length >= 30) break;
    } catch { /* seguir */ }
  }

  console.log(`[admin] Analizando #${mejorHashtag} (${mejorPosts.length} posts)...`);

  const resultsByAdmin = {};

  for (const admin of ADMIN_HANDLES) {
    try {
      const convo = await bluesky.getOrCreateConvoWithHandle(admin);
      if (!convo) {
        console.warn(`⚠️ [admin] No se pudo crear convo para reporte de prueba con @${admin}`);
        continue;
      }

      // Mensaje de bienvenida
      await bluesky.sendDM(convo.id, [
        `🤖 Bot-ID iniciado correctamente`,
        `━━━━━━━━━━━━━━━`,
        `👤 Admin: @${admin}`,
        `🏢 Plan: EMPRESARIAL (ilimitado)`,
        ``,
        `Comandos disponibles:`,
        `• !admin stats — estadísticas del día`,
        `• !admin status — estado del sistema`,
        `• !admin test — reporte de prueba`,
        `• !creditar @handle 50 — acreditar saldo`,
        `• !empresarial @handle — cambiar plan`,
        `• !usuario @handle — ver info de usuario`,
        ``,
        `Generando reporte de prueba...`,
      ].join('\n'));

      const ctx = {
        handle: admin,
        plan: 'EMPRESARIAL',
        canUseCoordination: true,
        maxCuentas: 30,
        canProceed: true,
        blockMessage: null,
      };

      if (!resultsByAdmin[mejorHashtag]) {
        resultsByAdmin[mejorHashtag] = await analyzeHashtagForDMWithCoordination(mejorHashtag, bluesky, ctx);
      }
      
      const result = resultsByAdmin[mejorHashtag];

      // DM 1: encabezado del reporte
      await bluesky.sendDM(convo.id,
        `🧪 REPORTE EMPRESARIAL — #${mejorHashtag}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📝 Posts escaneados: ${mejorPosts.length}\n` +
        `🏢 Plan: EMPRESARIAL | Red coordinada: ✅`
      );

      await sleep(500);

      // DM 2: análisis completo
      await bluesky.sendDM(convo.id, result.texto);

      console.log(`✅ [admin] Reporte enviado a @${admin} — #${mejorHashtag} (${result.texto.length} chars)`);
    } catch (err) {
      console.error(`❌ [admin] Error enviando reporte de prueba a @${admin}: ${err.message}`);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
