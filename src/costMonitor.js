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

// ── Precios USD por 1M tokens (actualizar si Anthropic los cambia) ─────────────
const PRECIOS = {
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':  { input: 0.25,  output: 1.25  },
};

const LIMITE_DIARIO_USD = 50;

// Evita enviar más de una alerta por día
let alertaEnviadaFecha = null;

// ── Registro de llamadas ───────────────────────────────────────────────────────

/**
 * Registra una llamada a la API de Anthropic y devuelve el costo en USD.
 * @param {{ model: string, inputTokens: number, outputTokens: number, endpoint?: string }} data
 * @returns {number} costo en USD
 */
export function recordApiCall({ model, inputTokens, outputTokens, endpoint = 'claude' }) {
  const precios = PRECIOS[model] ?? PRECIOS['claude-sonnet-4-6'];
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

// ── Consultas ──────────────────────────────────────────────────────────────────

/**
 * Costo total del día actual.
 * @returns {{ total: number, calls: number, date: string }}
 */
export function getCostToday() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_costs WHERE timestamp LIKE ?
    `).get(`${today}%`);
    return { total: row.total, calls: row.calls, date: today };
  } catch {
    return { total: 0, calls: 0, date: today };
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

async function checkCostAlert(blueskyClient) {
  const { total, calls, date } = getCostToday();

  if (total >= LIMITE_DIARIO_USD && alertaEnviadaFecha !== date) {
    alertaEnviadaFecha = date;

    const adminHandle = process.env.ADMIN_BLUESKY_HANDLE;
    const mention    = adminHandle ? `@${adminHandle} ` : '';

    const msg = `⚠️ ALERTA INTERNA — Bot-ID
${mention}Costo API hoy: $${total.toFixed(2)} USD
Llamadas realizadas: ${calls}
Límite configurado: $${LIMITE_DIARIO_USD}/día

Revisa el uso en Railway para reducir consumo.
Bot-ID | Monitor interno`;

    try {
      await blueskyClient.post(msg);
      console.warn(`⚠️  Alerta de costo enviada: $${total.toFixed(2)} USD hoy (${calls} llamadas)`);
    } catch (err) {
      console.error('Error enviando alerta de costo:', err.message);
    }

    // ADMIN_EMAIL: reservado para integración futura con SendGrid / SMTP
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

  const { total, calls } = getCostToday();
  console.log(`💰 Monitor de costos activo — hoy: $${total.toFixed(4)} USD (${calls} llamadas) · límite: $${LIMITE_DIARIO_USD}/día`);
}
