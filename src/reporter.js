/**
 * src/reporter.js
 * Generador de reportes semanales — 4 formatos de salida
 */

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWeeklyStats } from './database.js';
import { generateWeeklyReport } from './claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

/**
 * Obtiene el rango de la semana anterior (lunes-domingo)
 */
function getPreviousWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = domingo
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  // Inicio de esta semana
  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  thisMonday.setUTCHours(0, 0, 0, 0);

  // Semana anterior
  const prevMonday = new Date(thisMonday);
  prevMonday.setUTCDate(thisMonday.getUTCDate() - 7);

  const prevSunday = new Date(thisMonday);
  prevSunday.setUTCDate(thisMonday.getUTCDate() - 1);
  prevSunday.setUTCHours(23, 59, 59, 999);

  return {
    weekStart: prevMonday.toISOString().split('T')[0],
    weekEnd: prevSunday.toISOString().split('T')[0],
  };
}

/**
 * Genera el número de semana del año
 */
function getWeekNumber(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = d - start;
  const oneWeek = 604800000;
  return Math.ceil((diff / oneWeek) + 1);
}

/**
 * Crea la carpeta de reporte si no existe
 */
function ensureReportDir(dateStr) {
  const dirPath = path.join(REPORTS_DIR, dateStr);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Genera la versión Bluesky del reporte (con formato estructurado)
 */
function formatBlueskySummary(stats) {
  const top = stats.topHashtags[0] || { hashtag: 'N/D', botPct: 0 };
  const weekNum = getWeekNumber(stats.weekStart);

  return `📊 REPORTE BOT-ID — Semana ${weekNum}
${stats.weekStart} al ${stats.weekEnd}
━━━━━━━━━━━━━━━━━━━

🤖 ${stats.totalBots} cuentas bot detectadas
📈 #${top.hashtag} fue el más manipulado (${top.botPct}% bots)

Datos abiertos. Sin partido. Sin patrocinador.
🔍 Bot-ID`.slice(0, 299);
}

/**
 * Genera y guarda el reporte semanal completo
 * @param {BlueskyClient} blueskyClient
 */
export async function generateWeeklyReportFull(blueskyClient) {
  console.log('\n📊 Generando reporte semanal...');

  const { weekStart, weekEnd } = getPreviousWeekRange();
  const stats = getWeeklyStats(weekStart, weekEnd);

  if (stats.totalAnalyzadas === 0) {
    console.log('⚠️  Sin datos suficientes para el reporte semanal');
    return null;
  }

  console.log(`  Datos: ${stats.totalAnalyzadas} analizadas, ${stats.totalBots} bots (${stats.porcentaje}%)`);

  // Generar contenido con Claude
  let reportContent;
  try {
    reportContent = await generateWeeklyReport(stats);
  } catch (err) {
    console.error('Error generando reporte con Claude:', err.message);
    reportContent = {
      bluesky: formatBlueskySummary(stats),
      instagram: `[Error generando versión Instagram]`,
      twitter: `[Error generando hilo de Twitter]`,
      substack: `[Error generando artículo Substack]`,
    };
  }

  // Guardar archivos en /reports/YYYY-MM-DD/
  const reportDir = ensureReportDir(weekStart);
  const weekNum = getWeekNumber(weekStart);

  const archivos = {
    'bluesky.txt': reportContent.bluesky,
    'instagram.txt': reportContent.instagram,
    'twitter-hilo.txt': reportContent.twitter,
    'substack.md': reportContent.substack,
    'datos.json': JSON.stringify(stats, null, 2),
  };

  for (const [filename, content] of Object.entries(archivos)) {
    const filePath = path.join(reportDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`  💾 Guardado: reports/${weekStart}/${filename}`);
  }

  // Publicar en Bluesky
  if (blueskyClient && reportContent.bluesky) {
    const postResult = await blueskyClient.post(reportContent.bluesky);
    if (postResult) {
      console.log(`  ✅ Reporte publicado en Bluesky`);
    }
  }

  console.log(`\n✅ Reporte semana ${weekNum} generado en reports/${weekStart}/`);

  return {
    weekStart,
    weekEnd,
    weekNum,
    stats,
    reportDir,
    content: reportContent,
  };
}

/**
 * Programa el reporte semanal automático
 * Lunes 8am hora México (UTC-6 = 14:00 UTC)
 * @param {BlueskyClient} blueskyClient
 */
export function scheduleWeeklyReport(blueskyClient) {
  // Lunes a las 14:00 UTC (8:00 hora México UTC-6)
  cron.schedule('0 14 * * 1', async () => {
    console.log('\n🕐 Disparando reporte semanal automático...');
    try {
      await generateWeeklyReportFull(blueskyClient);
    } catch (err) {
      console.error('Error en reporte semanal:', err.message);
    }
  });

  // Calcular próximo lunes 8am México
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7;
  const nextMonday = new Date(now);
  nextMonday.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextMonday.setUTCHours(14, 0, 0, 0);

  const fechaFormateada = nextMonday.toLocaleDateString('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Mexico_City',
  });

  console.log(`📊 Reporte semanal programado: próximo lunes ${fechaFormateada} (hora México)`);
  return fechaFormateada;
}
