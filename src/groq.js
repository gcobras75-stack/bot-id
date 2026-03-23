/**
 * src/groq.js
 * Capa 2 — Análisis con Groq API (llama-3.1-70b-versatile, gratuito).
 * Se invoca solo para cuentas SOSPECHOSAS de Capa 1.
 * Si Groq falla o devuelve INCIERTO, escala a Claude API (Capa 3).
 */

import { recordGroqCall } from './costMonitor.js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama-3.1-70b-versatile';
const CONFIDENCE_THRESHOLD = 70; // mínimo para aceptar veredicto de Groq

const SYSTEM_PROMPT = `Eres un clasificador experto en detección de bots en redes sociales.
Analiza los datos de una cuenta de Bluesky y decide si es un BOT, un HUMANO, o si no puedes determinarlo (INCIERTO).
Responde SOLO con JSON válido, sin texto adicional.
Formato: {"veredicto":"BOT"|"HUMANO"|"INCIERTO","confianza":0-100,"razones":["razón 1","razón 2"]}`;

/**
 * Construye el prompt de usuario con los datos de la cuenta.
 */
function buildPrompt(profileData, postHistory, c1) {
  const handle      = profileData.handle || 'desconocido';
  const followers   = profileData.followersCount ?? 0;
  const follows     = profileData.followsCount ?? 0;
  const postsTotal  = profileData.postsCount ?? postHistory.length;
  const bio         = profileData.description?.trim() || '(vacía)';
  const tieneAvatar = profileData.avatar ? 'sí' : 'no';
  const createdAt   = profileData.createdAt
    ? new Date(profileData.createdAt).toISOString().split('T')[0]
    : 'desconocida';

  // Muestra de hasta 5 textos recientes
  const muestra = postHistory
    .slice(0, 5)
    .map((p) => `  - "${(p.record?.text || '').slice(0, 100)}"`)
    .join('\n') || '  (sin posts)';

  return `Cuenta: @${handle}
Creada: ${createdAt}
Seguidores: ${followers} | Seguidos: ${follows}
Posts totales: ${postsTotal}
Avatar: ${tieneAvatar}
Bio: ${bio}

Señales automáticas detectadas (Capa 1, ${c1.puntos}pts):
${c1.señales.length ? c1.señales.map((s) => `  • ${s}`).join('\n') : '  (ninguna)'}

Muestra de posts recientes:
${muestra}

¿Es un bot, un humano, o no puedes determinarlo con seguridad?`;
}

/**
 * Analiza una cuenta con Groq. Lanza error si falla para que el caller escale a Claude.
 *
 * @param {object} profileData
 * @param {Array}  postHistory
 * @param {{ puntos: number, veredicto: string, señales: string[] }} c1
 * @returns {Promise<{ veredicto: 'BOT'|'HUMANO'|'INCIERTO', confianza: number, razones: string[] }>}
 */
export async function analizarConGroq(profileData, postHistory, c1) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY no configurada');

  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildPrompt(profileData, postHistory, c1) },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => response.status);
    throw new Error(`Groq HTTP ${response.status}: ${err}`);
  }

  const data    = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq devolvió respuesta vacía');

  // Registrar uso de tokens (free tier, $0 real)
  if (data.usage) {
    recordGroqCall({
      inputTokens:  data.usage.prompt_tokens     ?? 0,
      outputTokens: data.usage.completion_tokens ?? 0,
    });
  }

  const result = JSON.parse(content);

  // Normalizar campos por si el modelo varía la capitalización
  result.veredicto  = (result.veredicto || 'INCIERTO').toUpperCase();
  result.confianza  = Number(result.confianza ?? 0);
  result.razones    = Array.isArray(result.razones) ? result.razones : [];

  // Si la confianza es baja, forzar INCIERTO para escalar a Claude
  if (result.confianza < CONFIDENCE_THRESHOLD) {
    result.veredicto = 'INCIERTO';
  }

  return result;
}
