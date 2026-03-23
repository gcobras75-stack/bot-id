/**
 * src/analyzer.js
 * Motor de detección de bots — 8 señales con pesos ponderados
 */

/**
 * Analiza una cuenta y calcula su probabilidad de ser bot
 * @param {object} profileData  - datos del perfil (getProfile)
 * @param {Array}  postHistory  - historial de posts (getPostHistory)
 * @returns {object} { score, nivel, señales, resumen }
 */
export function analyzeAccount(profileData, postHistory = []) {
  const señalesActivas = [];
  let totalScore = 0;

  // ─────────────────────────────────────────
  // SEÑAL 1 — Ratio seguidores / seguidos (20%)
  // ─────────────────────────────────────────
  const followers = profileData.followersCount ?? 0;
  const follows = profileData.followsCount ?? 0;
  let señal1Score = 0;

  if (follows > 0 && followers < 10 && follows > 500) {
    señal1Score = 20;
    señalesActivas.push({
      señal: 'Ratio seguidores/seguidos crítico',
      detalle: `${followers} seguidores vs ${follows} seguidos (menos de 10 seguidores con más de 500 seguidos)`,
      peso: 20,
    });
  } else if (follows > 0 && follows > followers * 10) {
    señal1Score = 15;
    señalesActivas.push({
      señal: 'Ratio seguidores/seguidos alto',
      detalle: `${followers} seguidores vs ${follows} seguidos (ratio ${(follows / Math.max(followers, 1)).toFixed(1)}x)`,
      peso: 15,
    });
  }
  totalScore += señal1Score;

  // ─────────────────────────────────────────
  // SEÑAL 2 — Edad de la cuenta (15%)
  // ─────────────────────────────────────────
  const createdAt = profileData.createdAt
    ? new Date(profileData.createdAt)
    : null;
  const ahora = new Date();
  const postsTotal = profileData.postsCount ?? postHistory.length;
  let señal2Score = 0;

  if (createdAt) {
    const diasDeVida = (ahora - createdAt) / (1000 * 60 * 60 * 24);

    if (diasDeVida < 7 && postsTotal > 50) {
      señal2Score = 25;
      señalesActivas.push({
        señal: 'Cuenta muy nueva con actividad masiva',
        detalle: `${Math.round(diasDeVida)} días de vida con ${postsTotal} posts`,
        peso: 15,
      });
    } else if (diasDeVida < 30 && postsTotal > 200) {
      señal2Score = 10;
      señalesActivas.push({
        señal: 'Cuenta nueva con alta actividad',
        detalle: `${Math.round(diasDeVida)} días de vida con ${postsTotal} posts`,
        peso: 10,
      });
    }
  }
  totalScore += señal2Score;

  // ─────────────────────────────────────────
  // SEÑAL 3 — Frecuencia de publicación (20%)
  // ─────────────────────────────────────────
  let señal3Score = 0;
  if (postHistory.length >= 2) {
    const fechas = postHistory
      .map((p) => new Date(p.record?.createdAt || p.indexedAt))
      .filter((d) => !isNaN(d))
      .sort((a, b) => b - a);

    if (fechas.length >= 2) {
      const rangoHoras =
        (fechas[0] - fechas[fechas.length - 1]) / (1000 * 60 * 60);
      const rangoDias = rangoHoras / 24 || 1;
      const postsPorDia = fechas.length / rangoDias;

      if (postsPorDia > 50) {
        señal3Score = 20;
        señalesActivas.push({
          señal: 'Frecuencia de publicación extrema',
          detalle: `~${Math.round(postsPorDia)} posts/día detectados`,
          peso: 20,
        });
      } else if (postsPorDia > 20) {
        señal3Score = 12;
        señalesActivas.push({
          señal: 'Frecuencia de publicación sospechosa',
          detalle: `~${Math.round(postsPorDia)} posts/día detectados`,
          peso: 12,
        });
      }
    }
  }
  totalScore += señal3Score;

  // ─────────────────────────────────────────
  // SEÑAL 4 — Bio vacía o sin foto (10%)
  // ─────────────────────────────────────────
  const sinBio = !profileData.description || profileData.description.trim().length === 0;
  const sinAvatar = !profileData.avatar;
  let señal4Score = 0;

  if (sinBio && sinAvatar) {
    señal4Score = 20;
    señalesActivas.push({
      señal: 'Perfil vacío (sin bio y sin foto)',
      detalle: 'Sin descripción y sin imagen de perfil',
      peso: 10,
    });
  } else if (sinBio || sinAvatar) {
    señal4Score = 5;
    señalesActivas.push({
      señal: 'Perfil incompleto',
      detalle: sinBio ? 'Sin descripción de perfil' : 'Sin imagen de perfil',
      peso: 5,
    });
  }
  totalScore += señal4Score;

  // ─────────────────────────────────────────
  // SEÑAL 5 — Patrón del nombre de usuario (5%)
  // ─────────────────────────────────────────
  const handle = (profileData.handle || '').toLowerCase();
  const handleSinDominio = handle.split('.')[0];
  let señal5Score = 0;

  // Más de 4 números consecutivos
  if (/\d{5,}/.test(handleSinDominio)) {
    señal5Score = 5;
    señalesActivas.push({
      señal: 'Handle con secuencia numérica larga',
      detalle: `@${handle} contiene 5+ dígitos consecutivos`,
      peso: 5,
    });
  }
  // Patrón aleatorio: letras+números mezclados sin sentido (ej: xk9m2j)
  else if (/^[a-z]{1,4}[0-9]{2,}[a-z]{1,4}[0-9]+$/i.test(handleSinDominio)) {
    señal5Score = 5;
    señalesActivas.push({
      señal: 'Handle con patrón generado automáticamente',
      detalle: `@${handle} parece generado aleatoriamente`,
      peso: 5,
    });
  }
  totalScore += señal5Score;

  // ─────────────────────────────────────────
  // SEÑAL 6 — Contenido repetitivo (15%)
  // ─────────────────────────────────────────
  let señal6Score = 0;
  if (postHistory.length > 0) {
    // Ratio de reposts
    const reposts = postHistory.filter((p) => p.record?.$type === 'app.bsky.feed.repost').length;
    const ratioReposts = reposts / postHistory.length;

    if (ratioReposts > 0.6) {
      señal6Score = Math.max(señal6Score, 15);
      señalesActivas.push({
        señal: 'Alta proporción de reposts',
        detalle: `${Math.round(ratioReposts * 100)}% de su actividad son reposts (${reposts}/${postHistory.length})`,
        peso: 15,
      });
    }

    // Hashtags siempre iguales
    const hashtagCounts = {};
    postHistory.forEach((p) => {
      const facets = p.record?.facets || [];
      facets.forEach((f) => {
        f.features?.forEach((feat) => {
          if (feat.$type === 'app.bsky.richtext.facet#tag') {
            const tag = feat.tag?.toLowerCase();
            if (tag) hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
          }
        });
      });
    });

    const topHashtag = Object.entries(hashtagCounts).sort((a, b) => b[1] - a[1])[0];
    if (topHashtag && topHashtag[1] / postHistory.length > 0.7) {
      señal6Score = Math.max(señal6Score, 10);
      señalesActivas.push({
        señal: 'Hashtag repetido de forma mecánica',
        detalle: `#${topHashtag[0]} aparece en el ${Math.round((topHashtag[1] / postHistory.length) * 100)}% de sus posts`,
        peso: 10,
      });
    }
  }
  totalScore += señal6Score;

  // ─────────────────────────────────────────
  // SEÑAL 7 — Horario de actividad robótico (10%)
  // ─────────────────────────────────────────
  let señal7Score = 0;
  if (postHistory.length >= 10) {
    const fechas = postHistory
      .map((p) => new Date(p.record?.createdAt || p.indexedAt))
      .filter((d) => !isNaN(d))
      .sort((a, b) => a - b);

    if (fechas.length >= 10) {
      const intervalos = [];
      for (let i = 1; i < Math.min(fechas.length, 20); i++) {
        intervalos.push(fechas[i] - fechas[i - 1]);
      }

      const media = intervalos.reduce((a, b) => a + b, 0) / intervalos.length;
      const varianza =
        intervalos.reduce((sum, x) => sum + Math.pow(x - media, 2), 0) /
        intervalos.length;
      const desviacion = Math.sqrt(varianza);
      const coefVariacion = media > 0 ? desviacion / media : 1;

      // Baja variación = intervalos muy regulares = robot
      if (coefVariacion < 0.1 && media < 10 * 60 * 1000) {
        señal7Score = 10;
        señalesActivas.push({
          señal: 'Actividad con intervalos perfectamente regulares',
          detalle: `Posts cada ~${Math.round(media / 60000)} minutos con variación de solo ${Math.round(coefVariacion * 100)}%`,
          peso: 10,
        });
      } else if (coefVariacion < 0.2 && media < 5 * 60 * 1000) {
        señal7Score = 6;
        señalesActivas.push({
          señal: 'Ritmo de publicación muy mecánico',
          detalle: `Intervalos muy consistentes entre posts (CV: ${(coefVariacion * 100).toFixed(1)}%)`,
          peso: 6,
        });
      }
    }
  }
  totalScore += señal7Score;

  // ─────────────────────────────────────────
  // SEÑAL 8 — Interacción cero (5%)
  // ─────────────────────────────────────────
  let señal8Score = 0;
  if (postHistory.length >= 5) {
    const totalLikes = postHistory.reduce(
      (sum, p) => sum + (p.likeCount ?? 0),
      0
    );
    const totalReplies = postHistory.reduce(
      (sum, p) => sum + (p.replyCount ?? 0),
      0
    );
    const totalInteracciones = totalLikes + totalReplies;

    if (totalInteracciones === 0 && postHistory.length >= 10) {
      señal8Score = 15;
      señalesActivas.push({
        señal: 'Cero interacciones recibidas',
        detalle: `${postHistory.length} posts analizados sin ningún like ni respuesta`,
        peso: 5,
      });
    }
  }
  totalScore += señal8Score;

  // ─────────────────────────────────────────
  // CALCULAR NIVEL Y RESUMEN
  // ─────────────────────────────────────────
  const score = Math.min(100, Math.round(totalScore));
  let nivel;
  if (score >= 70) nivel = 'MUY ALTO';
  else if (score >= 50) nivel = 'ALTO';
  else if (score >= 25) nivel = 'MEDIO';
  else nivel = 'BAJO';

  const resumen = generarResumen(score, nivel, señalesActivas, profileData.handle);

  return { score, nivel, señales: señalesActivas, resumen };
}

function generarResumen(score, nivel, señales, handle) {
  if (señales.length === 0) {
    return `@${handle} no muestra señales claras de comportamiento automatizado (score: ${score}/100)`;
  }
  const topSeñal = señales[0]?.señal || '';
  return `@${handle} muestra ${señales.length} señal(es) de bot (score: ${score}/100). Principal: ${topSeñal}`;
}

/**
 * Capa 1 — Clasificación rápida sin Claude API.
 * 7 reglas con puntos fijos. Resultado: BOT / SOSPECHOSO / HUMANO.
 * Solo SOSPECHOSO pasa al análisis profundo con Claude.
 *
 * @param {object} profileData
 * @param {Array}  postHistory
 * @returns {{ puntos: number, veredicto: 'BOT'|'SOSPECHOSO'|'HUMANO', señales: string[] }}
 */
export function capa1(profileData, postHistory = []) {
  let puntos = 0;
  const señales = [];

  // Regla 1: Cuenta < 30 días → +30
  const createdAt = profileData.createdAt ? new Date(profileData.createdAt) : null;
  if (createdAt) {
    const diasDeVida = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    if (diasDeVida < 30) {
      puntos += 30;
      señales.push(`Cuenta nueva (${Math.round(diasDeVida)} días de vida)`);
    }
  }

  // Regla 2: Sin foto de perfil → +20
  if (!profileData.avatar) {
    puntos += 20;
    señales.push('Sin foto de perfil');
  }

  // Regla 3: Más de 50 posts/día → +25
  if (postHistory.length >= 2) {
    const fechas = postHistory
      .map((p) => new Date(p.record?.createdAt || p.indexedAt))
      .filter((d) => !isNaN(d))
      .sort((a, b) => b - a);
    if (fechas.length >= 2) {
      const rangoDias = (fechas[0] - fechas[fechas.length - 1]) / (1000 * 60 * 60 * 24) || 1;
      const postsPorDia = fechas.length / rangoDias;
      if (postsPorDia > 50) {
        puntos += 25;
        señales.push(`Volumen extremo: ${Math.round(postsPorDia)} posts/día`);
      }
    }
  }

  // Regla 4: Ratio seguidores/seguidos < 0.02 → +20
  const followers = profileData.followersCount ?? 0;
  const follows   = profileData.followsCount   ?? 0;
  if (follows > 0 && followers / follows < 0.02) {
    puntos += 20;
    señales.push(`Ratio seguidores/seguidos: ${(followers / follows).toFixed(3)} (umbral: 0.02)`);
  }

  // Regla 5: Bio vacía → +10
  if (!profileData.description || profileData.description.trim().length === 0) {
    puntos += 10;
    señales.push('Bio vacía');
  }

  // Regla 6: Solo postea entre 2am y 5am UTC → +30
  if (postHistory.length >= 5) {
    const horas = postHistory
      .map((p) => new Date(p.record?.createdAt || p.indexedAt))
      .filter((d) => !isNaN(d))
      .map((d) => d.getUTCHours());
    const fueraNocturna = horas.filter((h) => h < 2 || h >= 5).length;
    if (fueraNocturna === 0) {
      puntos += 30;
      señales.push('Actividad exclusiva 2am–5am UTC (horario robótico)');
    }
  }

  // Regla 7: Username termina en 4+ números → +15
  const handleBase = (profileData.handle || '').split('.')[0];
  if (/\d{4,}$/.test(handleBase)) {
    puntos += 15;
    señales.push(`Username termina en 4+ números (@${profileData.handle})`);
  }

  // Clasificación final
  let veredicto;
  if      (puntos > 60)  veredicto = 'BOT';
  else if (puntos >= 35) veredicto = 'SOSPECHOSO';
  else                   veredicto = 'HUMANO';

  return { puntos, veredicto, señales };
}

/**
 * Analiza un array de handles en paralelo, en lotes de batchSize.
 * Reduce el tiempo de escaneo de O(n) serie a O(n/batchSize) paralelo.
 *
 * @param {string[]} handles
 * @param {import('./bluesky.js').BlueskyClient} blueskyClient
 * @param {{ batchSize?: number, pauseMs?: number, postLimit?: number }} options
 * @returns {Promise<Array<{handle: string, profileData: object, analysis: object}>>}
 */
export async function analyzeAccountsBatch(handles, blueskyClient, options = {}) {
  const { batchSize = 10, pauseMs = 500, postLimit = 50 } = options;
  const results = [];

  for (let i = 0; i < handles.length; i += batchSize) {
    const batch = handles.slice(i, i + batchSize);

    const batchResults = await Promise.all(batch.map(async (handle) => {
      try {
        const profileData = await blueskyClient.getProfile(handle);
        if (!profileData) return null;
        const postHistory = await blueskyClient.getPostHistory(profileData.did, postLimit);
        const analysis = analyzeAccount(profileData, postHistory);
        return { handle, profileData, analysis };
      } catch (err) {
        console.error(`  Error analizando @${handle}:`, err.message);
        return null;
      }
    }));

    results.push(...batchResults.filter(Boolean));

    if (i + batchSize < handles.length) {
      await new Promise(r => setTimeout(r, pauseMs));
    }
  }

  return results;
}
