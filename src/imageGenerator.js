/**
 * src/imageGenerator.js
 * Genera imágenes SVG 1200×675 con tendencias diarias y las convierte a PNG con sharp.
 * Si sharp no está disponible, guarda el SVG como fallback.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '..', 'reports', 'images');

// ── Paleta de colores Bot-ID ──────────────────────────────────────────────────
const C = {
  bg:       '#0a0500',
  bgCard:   '#1a0f00',
  bgFooter: '#0f0800',
  naranja:  '#ff6b00',
  verde:    '#00ff88',
  amarillo: '#ffdd00',
  rojo:     '#ff3333',
  blanco:   '#ffffff',
  gris:     '#888888',
  grisClar: '#aaaaaa',
};

/** Retorna color según % de bots */
function colorBots(pct) {
  if (pct < 30) return C.verde;
  if (pct < 60) return C.amarillo;
  return C.rojo;
}

/** Escapa caracteres especiales para SVG */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Configuración por tipo de reporte */
const CONFIGS = {
  internacional: {
    emoji: '🌍',
    titulo: 'TENDENCIAS INTERNACIONALES',
    subtitulo: 'Análisis de amplificación artificial',
  },
  nacional: {
    emoji: '🇲🇽',
    titulo: 'TENDENCIAS MÉXICO HOY',
    subtitulo: 'Monitoreo nacional de bots',
  },
  local: {
    emoji: '📍',
    titulo: 'TENDENCIAS SINALOA / NOROESTE',
    subtitulo: 'Conversación local monitoreada',
  },
};

/**
 * Genera el string SVG completo
 * @param {'internacional'|'nacional'|'local'} tipo
 * @param {Array} tendencias
 * @param {string} fecha - fecha formateada en español
 * @returns {string}
 */
function generarSVG(tipo, tendencias, fecha) {
  const W = 1200;
  const H = 675;
  const cfg = CONFIGS[tipo];
  const top5 = tendencias.slice(0, 5);
  const maxPosts = Math.max(...top5.map((t) => t.posts), 1);

  // ── Grid de puntos (marca de agua) ────────────────────────────────────────
  let dots = '';
  for (let dx = 20; dx < W; dx += 40) {
    for (let dy = 20; dy < H; dy += 40) {
      dots += `<circle cx="${dx}" cy="${dy}" r="1" fill="${C.naranja}" opacity="0.07"/>`;
    }
  }

  // ── Filas de tendencias ───────────────────────────────────────────────────
  let filas = '';
  const ROW_H = 82;
  const ROW_Y0 = 215;
  const BAR_X = 60;
  const BAR_MAX_W = 600;

  top5.forEach((t, i) => {
    const y = ROW_Y0 + i * ROW_H;
    const pctBots = t.posts > 0 ? Math.round((t.bots / t.posts) * 100) : Math.min(t.bots, 100);
    const color = colorBots(pctBots);
    const barW = Math.round((t.posts / maxPosts) * BAR_MAX_W);
    const barBotW = Math.round(barW * (pctBots / 100));
    const tema = esc(t.tema.length > 24 ? t.tema.slice(0, 24) + '…' : t.tema);
    const fuente = esc(t.fuente || 'Bluesky');
    const postsStr = t.posts.toLocaleString('es-MX');

    filas += `
    <text x="${BAR_X}" y="${y}"
      font-family="Arial Black, Arial, sans-serif" font-size="21" font-weight="900"
      fill="${C.blanco}">${i + 1}. ${tema}</text>
    <text x="${BAR_X}" y="${y + 20}"
      font-family="Arial, sans-serif" font-size="13" fill="${C.gris}">
      ${postsStr} posts · ${fuente}
    </text>
    <rect x="${BAR_X}" y="${y + 28}" width="${barW}" height="16" rx="4" fill="#2a1500"/>
    <rect x="${BAR_X}" y="${y + 28}" width="${barBotW}" height="16" rx="4" fill="${color}"/>
    <text x="${BAR_X + barW + 10}" y="${y + 41}"
      font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="${color}">
      ${pctBots}% bots
    </text>`;
  });

  // ── Badge de alerta si hay tema >60% bots ────────────────────────────────
  const hayAlerta = top5.some((t) => {
    const pct = t.posts > 0 ? Math.round((t.bots / t.posts) * 100) : t.bots;
    return pct > 60;
  });
  const alertaBadge = hayAlerta
    ? `<rect x="840" y="148" width="300" height="32" rx="6" fill="${C.rojo}" opacity="0.9"/>
    <text x="990" y="170" font-family="Arial, sans-serif" font-size="15" font-weight="bold"
      fill="${C.blanco}" text-anchor="middle">⚠️ ALTA ACTIVIDAD BOT</text>`
    : '';

  // ── SVG completo ──────────────────────────────────────────────────────────
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">

  <!-- Fondo -->
  <rect width="${W}" height="${H}" fill="${C.bg}"/>

  <!-- Marca de agua: grid de puntos -->
  ${dots}

  <!-- Header naranja -->
  <rect x="0" y="0" width="${W}" height="88" fill="${C.naranja}"/>
  <text x="40" y="36"
    font-family="Arial Black, Arial, sans-serif" font-size="24" font-weight="900"
    fill="${C.blanco}">${cfg.emoji}  ${esc(cfg.titulo)}</text>
  <text x="40" y="68"
    font-family="Arial, sans-serif" font-size="15" fill="${C.bg}" opacity="0.8">
    ${esc(cfg.subtitulo)}  ·  ${esc(fecha)}
  </text>

  <!-- Separador -->
  <rect x="0" y="88" width="${W}" height="3" fill="${C.naranja}" opacity="0.5"/>

  <!-- Subtítulo columna -->
  <text x="${BAR_X}" y="140"
    font-family="Arial, sans-serif" font-size="15" letter-spacing="2" fill="${C.gris}">
    TOP 5 TEMAS  ·  % DE BOTS AMPLIFICADORES
  </text>
  <line x1="${BAR_X}" y1="152" x2="780" y2="152"
    stroke="${C.naranja}" stroke-width="1.5" opacity="0.4"/>

  ${alertaBadge}

  <!-- Filas de tendencias -->
  ${filas}

  <!-- Footer -->
  <rect x="0" y="618" width="${W}" height="2" fill="${C.naranja}" opacity="0.35"/>
  <rect x="0" y="620" width="${W}" height="55" fill="${C.bgFooter}"/>

  <!-- Logo Bot-ID -->
  <text x="40" y="657"
    font-family="Arial Black, Arial, sans-serif" font-size="22" font-weight="900"
    fill="${C.naranja}">BOT-ID</text>
  <text x="138" y="657"
    font-family="Arial, sans-serif" font-size="14" fill="${C.gris}">
    Transparencia Digital  ·  bot-id.bsky.social
  </text>

  <!-- Leyenda colores -->
  <circle cx="870" cy="649" r="6" fill="${C.verde}"/>
  <text x="882" y="654" font-family="Arial, sans-serif" font-size="12" fill="${C.grisClar}">&lt;30% Bajo</text>
  <circle cx="960" cy="649" r="6" fill="${C.amarillo}"/>
  <text x="972" y="654" font-family="Arial, sans-serif" font-size="12" fill="${C.grisClar}">30-60% Medio</text>
  <circle cx="1065" cy="649" r="6" fill="${C.rojo}"/>
  <text x="1077" y="654" font-family="Arial, sans-serif" font-size="12" fill="${C.grisClar}">&gt;60% Alto</text>

</svg>`;
}

/** Asegura que el directorio de imágenes exista */
function ensureImagesDir() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }
}

/**
 * Convierte SVG a PNG usando sharp.
 * Si sharp no está disponible, guarda el SVG como fallback.
 * @param {string} svgString
 * @param {string} outputPath - ruta .png
 * @returns {string} ruta del archivo guardado (png o svg)
 */
async function svgToPng(svgString, outputPath) {
  try {
    const { default: sharp } = await import('sharp');
    const buffer = Buffer.from(svgString, 'utf-8');
    await sharp(buffer).png().toFile(outputPath);
    return outputPath;
  } catch (err) {
    console.warn(`⚠️  sharp no disponible (${err.message}), guardando SVG`);
    const svgPath = outputPath.replace(/\.png$/, '.svg');
    fs.writeFileSync(svgPath, svgString, 'utf-8');
    return svgPath;
  }
}

/**
 * Genera la imagen de tendencias para el tipo dado.
 * @param {'internacional'|'nacional'|'local'} tipo
 * @param {Array} tendencias - array de { tema, posts, bots, fuente }
 * @returns {string|null} ruta del archivo generado, o null si no hay datos
 */
export async function generarImagenTendencias(tipo, tendencias) {
  if (!tendencias || tendencias.length === 0) {
    console.log(`⚠️  Sin tendencias para imagen ${tipo}, omitiendo`);
    return null;
  }

  ensureImagesDir();

  const fecha = new Date().toLocaleDateString('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Mexico_City',
  });

  const fechaISO = new Date().toISOString().split('T')[0];
  const filename = `tendencias_${tipo}_${fechaISO}.png`;
  const outputPath = path.join(IMAGES_DIR, filename);

  console.log(`🎨 Generando imagen ${tipo}...`);
  const svg = generarSVG(tipo, tendencias, fecha);
  const archivoFinal = await svgToPng(svg, outputPath);

  console.log(`  ✅ Imagen guardada: reports/images/${path.basename(archivoFinal)}`);
  return archivoFinal;
}
