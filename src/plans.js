/**
 * src/plans.js
 * Sistema de planes de usuario: FREE · PREPAGO · EMPRESARIAL
 *
 * FREE        — 3 análisis/día, máx 30 cuentas, sin red coordinada
 * PREPAGO     — saldo en MXN, tarifas por tamaño, red coordinada incluida
 * EMPRESARIAL — ilimitado, sin costo adicional por operación
 */

import { getDb } from './database.js';

// ─── Definición de planes ─────────────────────────────────────────────────────

export const PLANES = {
  FREE: {
    nombre:             'Gratuito',
    emoji:              '🆓',
    limiteDiario:       3,
    maxCuentas:         30,
    redCoordinada:      false,
    detalleCompleto:    false,
  },
  PREPAGO: {
    nombre:             'Prepago',
    emoji:              '💳',
    limiteDiario:       Infinity,
    maxCuentas:         1000,
    redCoordinada:      true,
    detalleCompleto:    true,
  },
  EMPRESARIAL: {
    nombre:             'Empresarial',
    emoji:              '🏢',
    limiteDiario:       Infinity,
    maxCuentas:         5000,
    redCoordinada:      true,
    detalleCompleto:    true,
  },
};

// Tarifas PREPAGO en MXN según tamaño del análisis
export const TARIFAS = [
  { nombre: 'Pequeño',  min: 1,   max: 30,   precio: 2  },
  { nombre: 'Mediano',  min: 31,  max: 100,  precio: 5  },
  { nombre: 'Grande',   min: 101, max: 300,  precio: 12 },
  { nombre: 'Masivo',   min: 301, max: 1000, precio: 25 },
];

// Cargos adicionales
export const COSTO_RED_COORDINADA = 5; // MXN (incluida en precio base)
export const COSTO_PDF = 3;            // MXN (reservado para futuro)

// ─── User helpers ─────────────────────────────────────────────────────────────

export function getTarifa(numCuentas) {
  return TARIFAS.find((t) => numCuentas >= t.min && numCuentas <= t.max)
    ?? TARIFAS[TARIFAS.length - 1];
}

/**
 * Obtiene o crea un usuario con plan FREE por defecto.
 */
export function getOrCreateUser(handle) {
  const db   = getDb();
  const row  = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
  if (row) return row;

  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO users (handle, plan, balance_mxn, daily_count, last_reset, created_at)
    VALUES (?, 'FREE', 0, 0, ?, ?)
  `).run(handle, today, new Date().toISOString());
  return db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
}

/**
 * Devuelve el uso diario; resetea automáticamente si cambió el día.
 */
function getDailyCount(handle) {
  const db    = getDb();
  const today = new Date().toISOString().split('T')[0];
  const user  = getOrCreateUser(handle);

  if (user.last_reset !== today) {
    db.prepare('UPDATE users SET daily_count = 0, last_reset = ? WHERE handle = ?').run(today, handle);
    return 0;
  }
  return user.daily_count;
}

export function incrementDailyCount(handle) {
  const today = new Date().toISOString().split('T')[0];
  getDb().prepare(
    'UPDATE users SET daily_count = daily_count + 1, last_reset = ? WHERE handle = ?'
  ).run(today, handle);
}

// ─── Contexto de usuario para cada análisis ───────────────────────────────────

/**
 * Construye el contexto del usuario para un análisis.
 * @param {string} handle
 * @returns {{
 *   handle: string,
 *   plan: string,
 *   balance: number,
 *   maxCuentas: number,
 *   canUseCoordination: boolean,
 *   canProceed: boolean,
 *   blockMessage: string|null,
 * }}
 */
export function buildUserContext(handle) {
  const user  = getOrCreateUser(handle);
  const plan  = PLANES[user.plan] ?? PLANES.FREE;
  const count = getDailyCount(handle);

  // EMPRESARIAL — sin límites
  if (user.plan === 'EMPRESARIAL') {
    return {
      handle, plan: 'EMPRESARIAL', balance: 0,
      maxCuentas: plan.maxCuentas, canUseCoordination: true,
      canProceed: true, blockMessage: null,
    };
  }

  // PREPAGO — verificar saldo
  if (user.plan === 'PREPAGO') {
    const saldo = user.balance_mxn ?? 0;
    if (saldo <= 0) {
      return {
        handle, plan: 'PREPAGO', balance: saldo,
        maxCuentas: plan.maxCuentas, canUseCoordination: false,
        canProceed: false,
        blockMessage: [
          `💳 Saldo insuficiente — $${saldo.toFixed(2)} MXN`,
          ``,
          `Recarga para continuar:`,
          `• Pequeño (1-30):   $2 MXN`,
          `• Mediano (31-100): $5 MXN`,
          `• Grande (101-300): $12 MXN`,
          `• Masivo (301-1k):  $25 MXN`,
          ``,
          `Envía DM para recargar.`,
          `🔍 Bot-ID`,
        ].join('\n'),
      };
    }
    return {
      handle, plan: 'PREPAGO', balance: saldo,
      maxCuentas: plan.maxCuentas, canUseCoordination: true,
      canProceed: true, blockMessage: null,
    };
  }

  // FREE — verificar límite diario
  if (count >= plan.limiteDiario) {
    return {
      handle, plan: 'FREE', balance: 0,
      maxCuentas: plan.maxCuentas, canUseCoordination: false,
      canProceed: false,
      blockMessage: [
        `⏳ Límite gratuito: ${count}/${plan.limiteDiario} análisis usados hoy`,
        ``,
        `💳 Plan Prepago: análisis ilimitados desde $2 MXN`,
        `• Red coordinada incluida`,
        `• Hasta 1,000 cuentas por análisis`,
        ``,
        `Envía DM a @${process.env.BOT_HANDLE || 'bot-id.bsky.social'} para recargar.`,
        `🔍 Bot-ID`,
      ].join('\n'),
    };
  }

  return {
    handle, plan: 'FREE', balance: 0,
    maxCuentas: plan.maxCuentas, canUseCoordination: false,
    canProceed: true, blockMessage: null,
  };
}

// ─── Cobro post-análisis ──────────────────────────────────────────────────────

/**
 * Cobra al usuario PREPAGO según la cantidad de cuentas analizadas.
 * @returns {number} monto cobrado en MXN
 */
export function billAnalysis(handle, numCuentas) {
  const user = getOrCreateUser(handle);
  if (user.plan !== 'PREPAGO') return 0;

  const tarifa = getTarifa(numCuentas);
  getDb().prepare(
    'UPDATE users SET balance_mxn = balance_mxn - ? WHERE handle = ?'
  ).run(tarifa.precio, handle);

  console.log(`💳 [plans] @${handle} cobrado $${tarifa.precio} MXN (${tarifa.nombre}, ${numCuentas} cuentas)`);
  return tarifa.precio;
}

// ─── Administración (operaciones de admin) ────────────────────────────────────

/**
 * Acredita saldo y opcionalmente cambia el plan.
 * @param {string} handle
 * @param {number} amountMxn
 * @param {'PREPAGO'|'EMPRESARIAL'|null} newPlan
 */
export function creditUser(handle, amountMxn, newPlan = null) {
  const db = getDb();
  getOrCreateUser(handle); // ensure row exists

  if (newPlan && PLANES[newPlan]) {
    db.prepare(
      'UPDATE users SET balance_mxn = balance_mxn + ?, plan = ? WHERE handle = ?'
    ).run(amountMxn, newPlan, handle);
  } else {
    // Si está en FREE y recibe saldo → auto-upgrade a PREPAGO
    db.prepare(`
      UPDATE users
      SET balance_mxn = balance_mxn + ?,
          plan = CASE WHEN plan = 'FREE' AND ? > 0 THEN 'PREPAGO' ELSE plan END
      WHERE handle = ?
    `).run(amountMxn, amountMxn, handle);
  }
}

// ─── Textos informativos ──────────────────────────────────────────────────────

export function formatPlanInfo(handle) {
  const user  = getOrCreateUser(handle);
  const plan  = PLANES[user.plan] ?? PLANES.FREE;
  const count = getDailyCount(handle);

  const lines = [
    `${plan.emoji} Bot-ID — Tu plan: ${plan.nombre}`,
    `━━━━━━━━━━━━━━━`,
  ];

  if (user.plan === 'FREE') {
    lines.push(`📊 Análisis hoy: ${count} / ${plan.limiteDiario}`);
    lines.push(`👥 Máx. cuentas por análisis: ${plan.maxCuentas}`);
    lines.push(`🕸️  Red coordinada: no incluida`);
    lines.push(``, `Recarga con !tarifas para ver los precios.`);
  } else if (user.plan === 'PREPAGO') {
    lines.push(`💰 Saldo: $${(user.balance_mxn ?? 0).toFixed(2)} MXN`);
    lines.push(`📊 Análisis hoy: ${count} (sin límite diario)`);
    lines.push(`👥 Máx. cuentas por análisis: ${plan.maxCuentas}`);
    lines.push(`🕸️  Red coordinada: incluida`);
  } else {
    lines.push(`✅ Acceso ilimitado a todas las funciones`);
    lines.push(`🏢 Contrato empresarial activo`);
    lines.push(`🕸️  Red coordinada: incluida`);
  }

  return lines.join('\n');
}

export function formatTarifas() {
  return [
    `💳 Bot-ID — Tarifas Prepago`,
    `━━━━━━━━━━━━━━━`,
    `🔹 Pequeño  (1-30 ctas)    $2 MXN`,
    `🔹 Mediano  (31-100 ctas)  $5 MXN`,
    `🔹 Grande   (101-300 ctas) $12 MXN`,
    `🔹 Masivo   (301-1k ctas)  $25 MXN`,
    ``,
    `Red coordinada incluida en todos los planes.`,
    `Plan Empresarial: contacta al admin.`,
    ``,
    `🔍 Bot-ID | Transparencia digital`,
  ].join('\n');
}
