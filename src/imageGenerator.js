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
  bg:       '#0a0a0a',
  bgCard:   '#111111',
  bgFooter: '#0f0f0f',
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
      font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="21" font-weight="900"
      fill="${C.blanco}">${i + 1}. ${tema}</text>
    <text x="${BAR_X}" y="${y + 20}"
      font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" fill="${C.gris}">
      ${postsStr} posts · ${fuente}
    </text>
    <rect x="${BAR_X}" y="${y + 28}" width="${barW}" height="16" rx="4" fill="#1e1e1e"/>
    <rect x="${BAR_X}" y="${y + 28}" width="${barBotW}" height="16" rx="4" fill="${color}"/>
    <text x="${BAR_X + barW + 10}" y="${y + 41}"
      font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="16" font-weight="bold" fill="${color}">
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
    <text x="990" y="170" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold"
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
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="900"
    fill="${C.blanco}">${cfg.emoji}  ${esc(cfg.titulo)}</text>
  <text x="40" y="68"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" fill="${C.bg}" opacity="0.8">
    ${esc(cfg.subtitulo)}  ·  ${esc(fecha)}
  </text>

  <!-- Separador -->
  <rect x="0" y="88" width="${W}" height="3" fill="${C.naranja}" opacity="0.5"/>

  <!-- Subtítulo columna -->
  <text x="${BAR_X}" y="140"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" letter-spacing="2" fill="${C.gris}">
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
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="900"
    fill="${C.naranja}">BOT-ID</text>
  <text x="138" y="657"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="14" fill="${C.gris}">
    Transparencia Digital  ·  bot-id.bsky.social
  </text>

  <!-- Leyenda colores -->
  <circle cx="870" cy="649" r="6" fill="${C.verde}"/>
  <text x="882" y="654" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="13" fill="${C.grisClar}">&lt;30% Bajo</text>
  <circle cx="960" cy="649" r="6" fill="${C.amarillo}"/>
  <text x="972" y="654" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="13" fill="${C.grisClar}">30-60% Medio</text>
  <circle cx="1065" cy="649" r="6" fill="${C.rojo}"/>
  <text x="1077" y="654" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="13" fill="${C.grisClar}">&gt;60% Alto</text>

</svg>`;
}

/** Retorna color hex según nivel BAJO/MEDIO/ALTO (spec Sesión 2) */
function nivelColor(nivel) {
  if (nivel === 'BAJO')  return '#00ff88';
  if (nivel === 'MEDIO') return '#ffaa00';
  return '#ff4444'; // ALTO
}

/**
 * Genera SVG de tarjeta de reporte individual 1200×630px.
 * @param {{
 *   fuente: string,    — hashtag, @handle o 'Hilo'
 *   bots: number,      — bots detectados (o score si es cuenta individual)
 *   total: number,     — cuentas analizadas
 *   porcentaje: number,
 *   nivel: 'BAJO'|'MEDIO'|'ALTO',
 *   fecha: string,
 *   labelBots?: string — etiqueta bajo el número grande (default: 'BOTS DETECTADOS')
 * }} datos
 */
function generarSVGReporte(datos) {
  const W = 1200;
  const H = 630;
  const { fuente, bots, total, porcentaje, nivel, fecha } = datos;
  const label = datos.labelBots || 'BOTS DETECTADOS';
  const color = nivelColor(nivel);
  const cx = W / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">

  <!-- Fondo -->
  <rect width="${W}" height="${H}" fill="#0a0a0a"/>

  <!-- Borde de color según nivel (4px) -->
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}"
    fill="none" stroke="${color}" stroke-width="4" rx="3"/>

  <!-- Línea decorativa bajo header -->
  <line x1="40" y1="108" x2="${W - 40}" y2="108"
    stroke="${color}" stroke-width="1" opacity="0.15"/>

  <!-- Logo BOT-ID (arriba izquierda) -->
  <text x="50" y="78"
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="38" font-weight="900"
    fill="#ffffff">BOT-ID</text>
  <text x="188" y="78"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="16" fill="#666666">
    Detector de bots
  </text>

  <!-- Badge de nivel (arriba derecha) -->
  <rect x="942" y="28" width="210" height="52" rx="8"
    fill="${color}" opacity="0.12" stroke="${color}" stroke-width="1.5"/>
  <text x="1047" y="61"
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="900"
    fill="${color}" text-anchor="middle">${esc(nivel)}</text>

  <!-- Número grande (bots o score) -->
  <text x="${cx}" y="278"
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="148" font-weight="900"
    fill="${color}" text-anchor="middle">${bots}</text>

  <!-- Etiqueta bajo el número -->
  <text x="${cx}" y="316"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="18" fill="#777777"
    text-anchor="middle" letter-spacing="4">${esc(label)}</text>

  <!-- Separador central -->
  <line x1="180" y1="344" x2="${W - 180}" y2="344"
    stroke="${color}" stroke-width="1" opacity="0.25"/>

  <!-- Porcentaje -->
  <text x="${cx}" y="432"
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="82" font-weight="900"
    fill="#ffffff" text-anchor="middle">${porcentaje}%</text>

  <!-- Subtítulo porcentaje -->
  <text x="${cx}" y="464"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="17" fill="#666666"
    text-anchor="middle" letter-spacing="3">DE MANIPULACIÓN ARTIFICIAL</text>

  <!-- Fuente analizada -->
  <text x="${cx}" y="516"
    font-family="Arial Black, Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="700"
    fill="#ffffff" text-anchor="middle">📌 ${esc(fuente)}</text>

  <!-- Total cuentas -->
  <text x="${cx}" y="546"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" fill="#555555"
    text-anchor="middle">${Number(total).toLocaleString('es-MX')} cuentas analizadas</text>

  <!-- Separador footer -->
  <rect x="0" y="574" width="${W}" height="2" fill="${color}" opacity="0.35"/>
  <rect x="0" y="576" width="${W}" height="54" fill="#0f0f0f"/>

  <!-- Footer texto -->
  <text x="50" y="610"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" fill="#555555">
    bot-id.bsky.social  ·  Transparencia digital
  </text>
  <text x="${W - 50}" y="610"
    font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="15" fill="#555555"
    text-anchor="end">${esc(fecha)}</text>

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
 * @param {number} width  - ancho final en px (default 1200)
 * @param {number} height - alto final en px (default 630)
 * @returns {string} ruta del archivo guardado (png o svg)
 */
async function svgToPng(svgString, outputPath, width = 1200, height = 630) {
  try {
    const { default: sharp } = await import('sharp');
    const buffer = Buffer.from(svgString, 'utf-8');
    await sharp(buffer, { density: 150 })
      .resize(width, height)
      .png()
      .toFile(outputPath);
    return outputPath;
  } catch (err) {
    console.warn(`⚠️  sharp no disponible (${err.message}), guardando SVG`);
    const svgPath = outputPath.replace(/\.png$/, '.svg');
    fs.writeFileSync(svgPath, svgString, 'utf-8');
    return svgPath;
  }
}

/**
 * Genera la tarjeta PNG de reporte de análisis (individual, hilo o hashtag).
 * @param {{fuente, bots, total, porcentaje, nivel, fecha, labelBots?}} datos
 * @returns {string|null} ruta del archivo PNG generado
 */
export async function generarTarjetaReporte(datos) {
  ensureImagesDir();

  const fechaISO = new Date().toISOString().split('T')[0];
  const safeFuente = String(datos.fuente)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 20) || 'reporte';
  const filename = `reporte_${safeFuente}_${fechaISO}.png`;
  const outputPath = path.join(IMAGES_DIR, filename);

  console.log(`🎨 Generando tarjeta de reporte: ${filename}`);
  const svg = generarSVGReporte(datos);
  return svgToPng(svg, outputPath, 1200, 630);
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
  const archivoFinal = await svgToPng(svg, outputPath, 1200, 675);

  console.log(`  ✅ Imagen guardada: reports/images/${path.basename(archivoFinal)}`);
  return archivoFinal;
}
