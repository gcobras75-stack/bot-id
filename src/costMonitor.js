/**
 * src/costMonitor.js
 * Monitor de costos de la API de Anthropic.
 *
 * - Registra cada llamada con su costo estimado en SQLite
 * - Calcula costo total del día y del mes
 * - Alerta en Bluesky (mencionando admin) si se supera el límite diario
 * - Exporta getCostToday() para consultas desde otros módulos
 */

import cron from 'node-cron';
import { getDb } from './database.js';

// ── Precios USD por 1M tokens ──────────────────────────────────────────────────
const PRECIOS_CLAUDE = {
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':  { input: 0.25,  output: 1.25  },
};

// Groq tiene free tier — precios de referencia por si se pasa al plan de pago
const PRECIOS_GROQ = {
  'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 },
};

const LIMITE_DIARIO_CLAUDE_USD = 50;

// Evita enviar más de una alerta por día
let alertaEnviadaFecha = null;

// ── Registro de llamadas ───────────────────────────────────────────────────────

/**
 * Registra una llamada a la API de Anthropic y devuelve el costo en USD.
 * @param {{ model: string, inputTokens: number, outputTokens: number, endpoint?: string }} data
 * @returns {number} costo en USD
 */
export function recordApiCall({ model, inputTokens, outputTokens, endpoint = 'claude' }) {
  const precios = PRECIOS_CLAUDE[model] ?? PRECIOS_CLAUDE['claude-sonnet-4-6'];
  const costUsd = (inputTokens  / 1_000_000) * precios.input
                + (outputTokens / 1_000_000) * precios.output;

  try {
    getDb().prepare(`
      INSERT INTO api_costs (timestamp, model, input_tokens, output_tokens, cost_usd, endpoint)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), model, inputTokens, outputTokens, costUsd, endpoint);
  } catch (err) {
    // No interrumpir el flujo principal si falla el registro
    console.warn('⚠️  costMonitor: error registrando llamada:', err.message);
  }

  return costUsd;
}

/**
 * Registra una llamada a la API de Groq.
 * El costo en USD es 0 en el free tier pero se rastrean los tokens igualmente.
 * @param {{ inputTokens: number, outputTokens: number }} data
 */
export function recordGroqCall({ inputTokens, outputTokens }) {
  const model   = 'llama-3.1-70b-versatile';
  const precios = PRECIOS_GROQ[model];
  // Costo real si se usara plan de pago (free tier = $0 real)
  const costUsd = (inputTokens  / 1_000_000) * precios.input
                + (outputTokens / 1_000_000) * precios.output;

  try {
    getDb().prepare(`
      INSERT INTO api_costs (timestamp, model, input_tokens, output_tokens, cost_usd, endpoint)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), model, inputTokens, outputTokens, costUsd, 'groq');
  } catch (err) {
    console.warn('⚠️  costMonitor: error registrando llamada Groq:', err.message);
  }
}

// ── Consultas ──────────────────────────────────────────────────────────────────

/**
 * Costo total del día para Claude (model LIKE 'claude%').
 * @returns {{ total: number, calls: number, date: string }}
 */
export function getCostToday() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_costs WHERE timestamp LIKE ? AND model LIKE 'claude%'
    `).get(`${today}%`);
    return { total: row.total, calls: row.calls, date: today };
  } catch {
    return { total: 0, calls: 0, date: today };
  }
}

/**
 * Uso de Groq del día actual (free tier — costo referencial).
 * @returns {{ tokens: number, calls: number, refCostUsd: number }}
 */
export function getGroqUsageToday() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
             COUNT(*) as calls,
             COALESCE(SUM(cost_usd), 0) as refCost
      FROM api_costs WHERE timestamp LIKE ? AND model LIKE 'llama%'
    `).get(`${today}%`);
    return { tokens: row.tokens, calls: row.calls, refCostUsd: row.refCost };
  } catch {
    return { tokens: 0, calls: 0, refCostUsd: 0 };
  }
}

/**
 * Costo total del mes en curso.
 * @returns {{ total: number, calls: number, month: string }}
 */
export function getCostThisMonth() {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_costs WHERE timestamp LIKE ?
    `).get(`${month}%`);
    return { total: row.total, calls: row.calls, month };
  } catch {
    return { total: 0, calls: 0, month };
  }
}

// ── Alerta ─────────────────────────────────────────────────────────────────────

/**
 * Imprime resumen de costos en consola (Railway logs).
 */
function logCostSummary() {
  const claude = getCostToday();
  const groq   = getGroqUsageToday();

  console.log(
    `💰 Costos API hoy (${claude.date}):` +
    `\n   Claude: $${claude.total.toFixed(4)} USD (${claude.calls} llamadas)` +
    `\n   Groq:   ${groq.tokens.toLocaleString()} tokens (${groq.calls} llamadas) [free tier]` +
    `\n   Límite Claude: $${LIMITE_DIARIO_CLAUDE_USD}/día`
  );
}

async function checkCostAlert(blueskyClient) {
  const { total, calls, date } = getCostToday();

  // Log de costos en cada revisión horaria
  logCostSummary();

  if (total >= LIMITE_DIARIO_CLAUDE_USD && alertaEnviadaFecha !== date) {
    alertaEnviadaFecha = date;

    const groq        = getGroqUsageToday();
    const adminHandle = process.env.ADMIN_BLUESKY_HANDLE;
    const mention     = adminHandle ? `@${adminHandle} ` : '';

    const msg = [
      `⚠️ ALERTA INTERNA — Bot-ID`,
      `${mention}Límite diario de Claude API alcanzado`,
      `━━━━━━━━━━━━━━━`,
      `💸 Claude: $${total.toFixed(2)} USD (${calls} llamadas)`,
      `🤖 Groq: ${groq.tokens.toLocaleString()} tokens (${groq.calls} llamadas)`,
      `Límite: $${LIMITE_DIARIO_CLAUDE_USD}/día`,
      ``,
      `Revisa el uso en Railway para reducir consumo.`,
      `Bot-ID | Monitor interno`,
    ].join('\n');

    try {
      await blueskyClient.post(msg);
      console.warn(`⚠️  Alerta de costo enviada: $${total.toFixed(2)} USD Claude hoy (${calls} llamadas)`);
    } catch (err) {
      console.error('Error enviando alerta de costo:', err.message);
    }

    if (process.env.ADMIN_EMAIL) {
      console.warn(`📧 [pendiente] Enviar alerta a ${process.env.ADMIN_EMAIL} — requiere configurar SMTP`);
    }
  }

  return { total, calls };
}

// ── Inicialización ─────────────────────────────────────────────────────────────

/**
 * Inicia el monitor: revisa costos cada hora y muestra estado inicial.
 * Llamar en index.js después de initDatabase() y bluesky.login().
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 */
export function initCostMonitor(blueskyClient) {
  // Revisión cada hora en punto
  cron.schedule('0 * * * *', () => {
    checkCostAlert(blueskyClient).catch(err =>
      console.error('Error en checkCostAlert:', err.message)
    );
  });

  logCostSummary();
}
