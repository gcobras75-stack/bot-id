/**
 * src/socialPublisher.js
 * Publica imágenes de tendencias en Bluesky usando uploadBlob + embed.images.
 */

import fs from 'fs';

// ── Captions por tipo ────────────────────────────────────────────────────────

const CAPTIONS = {
  internacional: `🌍 Tendencias internacionales de hoy
y cuántos bots las están amplificando.

Los datos no mienten.
━━━━━━━━━━━━━━━━
🔍 Bot-ID | Transparencia Digital
#BotID #Bots #ManipulaciónDigital`,

  nacional: `🇲🇽 ¿Qué está pasando en México hoy?
¿Y cuánto es real vs artificial?

Analizamos las tendencias por ti.
━━━━━━━━━━━━━━━━
🔍 Bot-ID | Transparencia Digital
#México #BotID #Bots`,

  local: `📍 Tendencias en Sinaloa y el Noroeste hoy.
Monitoreamos la conversación local.

━━━━━━━━━━━━━━━━
🔍 Bot-ID | Transparencia Digital
#Sinaloa #Culiacán #BotID`,
};

const ALT_TEXTS = {
  internacional: 'Gráfica Bot-ID: tendencias internacionales con porcentaje de bots amplificadores',
  nacional:      'Gráfica Bot-ID: tendencias de México con porcentaje de bots amplificadores',
  local:         'Gráfica Bot-ID: tendencias de Sinaloa y el Noroeste con porcentaje de bots',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sube un archivo de imagen (PNG o SVG) como blob a Bluesky.
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 * @param {string} imagePath
 * @returns {object|null} blobRef de Bluesky
 */
async function uploadImageBlob(blueskyClient, imagePath) {
  try {
    const encoding = imagePath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    const imageData = fs.readFileSync(imagePath);
    const response = await blueskyClient.agent.uploadBlob(imageData, { encoding });
    return response.data.blob;
  } catch (err) {
    console.error(`❌ Error subiendo imagen blob: ${err.message}`);
    return null;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Publica un post con imagen adjunta en Bluesky.
 * Si la subida falla, publica solo el texto como fallback.
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 * @param {string} imagePath  - ruta al archivo PNG o SVG
 * @param {string} caption    - texto del post
 * @param {string} altText    - texto alternativo de la imagen
 * @returns {object|null}
 */
export async function publishImagePost(blueskyClient, imagePath, caption, altText = 'Tendencias Bot-ID') {
  if (!fs.existsSync(imagePath)) {
    console.error(`❌ Imagen no encontrada: ${imagePath}`);
    return null;
  }

  console.log(`📤 Subiendo imagen a Bluesky...`);
  const blobRef = await uploadImageBlob(blueskyClient, imagePath);

  if (!blobRef) {
    console.warn('⚠️  Sin imagen — publicando solo texto como fallback');
    return blueskyClient.post(caption);
  }

  try {
    const res = await blueskyClient.agent.post({
      text: caption,
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ image: blobRef, alt: altText }],
      },
    });
    console.log(`  ✅ Post con imagen publicado en Bluesky`);
    return res;
  } catch (err) {
    console.error(`❌ Error publicando post con imagen: ${err.message}`);
    console.warn('⚠️  Reintentando sin imagen...');
    return blueskyClient.post(caption);
  }
}

/**
 * Genera y publica el reporte de tendencias completo para un tipo dado.
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 * @param {'internacional'|'nacional'|'local'} tipo
 * @param {string} imagePath - ruta a la imagen PNG/SVG generada
 * @returns {object|null}
 */
export async function publicarReporteTendencias(blueskyClient, tipo, imagePath) {
  const caption = CAPTIONS[tipo];
  const altText = ALT_TEXTS[tipo];

  if (!caption) {
    console.error(`❌ Tipo de reporte desconocido: ${tipo}`);
    return null;
  }

  console.log(`\n📣 Publicando reporte ${tipo}...`);
  return publishImagePost(blueskyClient, imagePath, caption, altText);
}
