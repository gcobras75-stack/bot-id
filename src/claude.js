/**
 * src/claude.js
 * Integración con la API de Anthropic (Claude) para generar reportes
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Eres Bot-ID, un sistema anónimo de transparencia digital en redes sociales. Tu misión es exponer la manipulación digital con datos concretos. Escribes en español, con tono activista pero siempre basado en evidencia medible, nunca en especulación. Nunca acusas con certeza absoluta — siempre hablas de probabilidades y señales detectadas. Eres directo, sin miedo, y tus análisis están basados en datos observables, no en opinión. Tu audiencia es la ciudadanía mexicana que merece saber cuándo el debate público está siendo manipulado.`;

/**
 * Genera un reporte de bot basado en el análisis
 * @param {object} profileData    - datos del perfil de Bluesky
 * @param {object} analysisResult - resultado de analyzer.js
 * @returns {object} { bluesky, substack }
 */
export async function generateBotReport(profileData, analysisResult) {
  const { score, nivel, señales, resumen } = analysisResult;
  const handle = profileData.handle || 'desconocido';

  const contexto = `
PERFIL ANALIZADO:
- Handle: @${handle}
- Nombre: ${profileData.displayName || 'Sin nombre'}
- Seguidores: ${profileData.followersCount ?? 'N/D'}
- Seguidos: ${profileData.followsCount ?? 'N/D'}
- Posts totales: ${profileData.postsCount ?? 'N/D'}
- Cuenta creada: ${profileData.createdAt ? new Date(profileData.createdAt).toLocaleDateString('es-MX') : 'Desconocido'}
- Bio: ${profileData.description || '(vacía)'}

RESULTADO DEL ANÁLISIS AUTOMATIZADO:
- Score de probabilidad de bot: ${score}/100
- Nivel de riesgo: ${nivel}
- Señales detectadas (${señales.length}):
${señales.map((s, i) => `  ${i + 1}. ${s.señal}: ${s.detalle}`).join('\n')}

RESUMEN: ${resumen}
`;

  try {
    // --- Versión Bluesky (≤280 caracteres) ---
    const resBsky = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${contexto}

Genera un reporte para publicar en Bluesky. MÁXIMO 280 caracteres.
Debe incluir: @handle, score %, nivel de riesgo y 1-2 señales clave.
Tono: activista y basado en datos. Sin hashtags en esta versión.
Devuelve SOLO el texto del post, sin comillas ni explicaciones adicionales.`,
        },
      ],
    });

    const blueskyText = extractText(resBsky);

    // --- Versión Substack / larga (500-800 palabras) ---
    const resSubstack = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${contexto}

Genera un análisis completo para publicar en Substack/newsletter.
Extensión: 500-800 palabras en español.
Estructura:
1. Título impactante
2. Qué se detectó (datos concretos)
3. Análisis señal por señal
4. Contexto: por qué importa la manipulación digital en México
5. Qué puede hacer la ciudadanía
6. Pie: "Datos abiertos. Sin partido. Sin patrocinador. — Bot-ID"

Tono: periodismo de denuncia activista, basado en evidencia medible.`,
        },
      ],
    });

    const substackText = extractText(resSubstack);

    return {
      bluesky: blueskyText,
      substack: substackText,
    };
  } catch (err) {
    console.error('Error llamando a Claude:', err.message);
    // Fallback: reporte básico sin IA
    return {
      bluesky: generarFallbackBluesky(handle, score, nivel, señales),
      substack: generarFallbackSubstack(handle, score, nivel, señales, resumen),
    };
  }
}

/**
 * Genera el reporte semanal completo con Claude
 * @param {object} statsData - estadísticas de la semana
 * @returns {object} { bluesky, instagram, twitter, substack }
 */
export async function generateWeeklyReport(statsData) {
  const contexto = `
DATOS DE LA SEMANA:
- Total cuentas analizadas: ${statsData.totalAnalyzadas}
- Total bots detectados: ${statsData.totalBots}
- Porcentaje general: ${statsData.porcentaje}%
- Semana: ${statsData.weekStart} al ${statsData.weekEnd}

TOP HASHTAGS MANIPULADOS:
${statsData.topHashtags.map((h, i) => `  ${i + 1}. #${h.hashtag}: ${h.botPct}% bots (${h.botsDetected}/${h.accountsFound} cuentas)`).join('\n')}

HASHTAG MÁS MANIPULADO: #${statsData.topHashtags[0]?.hashtag || 'N/D'} (${statsData.topHashtags[0]?.botPct || 0}% bots)
`;

  try {
    const [resBsky, resInsta, resTwitter, resSubstack] = await Promise.all([
      // Bluesky (≤300 chars con emojis)
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${contexto}\nGenera el reporte semanal para Bluesky. MÁXIMO 300 caracteres con emojis. Incluye: bots detectados, hashtag más manipulado, porcentaje. Devuelve SOLO el texto.`,
          },
        ],
      }),

      // Instagram (caption con hashtags)
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${contexto}\nGenera caption para Instagram. 150-200 palabras + 10 hashtags relevantes en español sobre manipulación digital México. Devuelve SOLO el texto.`,
          },
        ],
      }),

      // Twitter/X (hilo de 5 tweets numerados)
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${contexto}\nGenera un hilo de exactamente 5 tweets numerados (1/5, 2/5, etc). Cada tweet máximo 270 chars. El hilo debe contar la historia: qué pasó, datos clave, contexto, implicaciones, llamado a acción. Devuelve SOLO los tweets numerados.`,
          },
        ],
      }),

      // Substack (artículo completo ~800 palabras)
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${contexto}\nEscribe el artículo completo para Substack. ~800 palabras. Estructura: título, introducción, datos de la semana, análisis de los hashtags más manipulados, contexto político México, metodología (breve), conclusión activista. Termina con: "Datos abiertos. Sin partido. Sin patrocinador. — Bot-ID"`,
          },
        ],
      }),
    ]);

    return {
      bluesky: extractText(resBsky),
      instagram: extractText(resInsta),
      twitter: extractText(resTwitter),
      substack: extractText(resSubstack),
    };
  } catch (err) {
    console.error('Error generando reporte semanal con Claude:', err.message);
    return generarFallbackWeekly(statsData);
  }
}

// ─── Helpers ──────────────────────────────────────────────

function extractText(response) {
  const block = response.content?.find((b) => b.type === 'text');
  return block?.text?.trim() || '';
}

function generarFallbackBluesky(handle, score, nivel, señales) {
  const emoji = nivel === 'MUY ALTO' ? '🔴' : nivel === 'ALTO' ? '🟠' : '🟡';
  const top = señales[0]?.señal || 'comportamiento automatizado detectado';
  return `🤖 BOT-ID | @${handle}\nScore: ${score}/100 ${emoji} ${nivel}\n⚠️ ${top}\n\nDatos abiertos. Sin partido. — Bot-ID`.slice(0, 279);
}

function generarFallbackSubstack(handle, score, nivel, señales, resumen) {
  return `# Análisis Bot-ID: @${handle}\n\n${resumen}\n\n## Señales detectadas\n\n${señales.map((s) => `- **${s.señal}**: ${s.detalle}`).join('\n')}\n\n---\nDatos abiertos. Sin partido. Sin patrocinador. — Bot-ID`;
}

function generarFallbackWeekly(statsData) {
  const top = statsData.topHashtags[0] || { hashtag: 'N/D', botPct: 0 };
  return {
    bluesky: `📊 BOT-ID Semana ${statsData.weekStart}\n🤖 ${statsData.totalBots} bots detectados (${statsData.porcentaje}%)\n📈 #${top.hashtag} el más manipulado\n\nDatos abiertos. — Bot-ID`,
    instagram: `Reporte semanal Bot-ID\n${statsData.totalBots} cuentas bot detectadas esta semana.\n#BotWatch #TransparenciaDigital #Mexico`,
    twitter: `1/5 📊 Reporte Bot-ID — semana del ${statsData.weekStart}\n\n2/5 🤖 ${statsData.totalBots} bots detectados (${statsData.porcentaje}% del total analizado)\n\n3/5 📈 #${top.hashtag} fue el hashtag más manipulado (${top.botPct}% bots)\n\n4/5 La manipulación digital es real. Los datos son abiertos.\n\n5/5 Bot-ID es una herramienta ciudadana. Sin partido. Sin patrocinador.`,
    substack: `# Reporte Semanal Bot-ID\n\nEsta semana analizamos ${statsData.totalAnalyzadas} cuentas y detectamos ${statsData.totalBots} bots (${statsData.porcentaje}%).\n\nDatos abiertos. Sin partido. Sin patrocinador. — Bot-ID`,
  };
}
