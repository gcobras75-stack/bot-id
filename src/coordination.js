/**
 * src/coordination.js
 * Detección de redes coordinadas de bots
 *
 * Disponible para planes PREPAGO y EMPRESARIAL.
 *
 * Detecta:
 *   1. Clústeres temporales — múltiples cuentas publicando en la misma ventana
 *   2. Similitud de contenido — textos muy parecidos entre cuentas
 *   3. Patrones de cuenta — creación en el mismo período, ratios similares
 *
 * Cada señal suma puntos → nivel ALTO (≥65) / MEDIO (≥35) / BAJO (<35)
 */

const TIME_WINDOW_MS        = 15 * 60 * 1000; // 15 minutos
const MIN_CLUSTER_SIZE      = 3;               // mínimo de cuentas para "red"
const CONTENT_SIM_THRESHOLD = 0.55;            // Jaccard ≥55 % = contenido similar
const AGE_WINDOW_DAYS       = 10;              // ±10 días = creación "simultánea"

// ─── Tokenización ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'de','la','el','en','y','a','que','es','se','los','del','las','un','una',
  'con','no','su','para','al','lo','como','más','pero','sus','le','ya','o',
  'este','ha','si','porque','esta','son','entre','cuando','muy','sin','sobre',
  'también','me','hasta','hay','donde','desde','todo','nos','todos','uno',
  'les','ni','otros','ese','eso','ante','ellos','mi','tu','te','the','is',
  'in','of','and','to','it','that','was','for','on','are','as','at','be',
]);

function tokenize(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')   // quitar URLs
      .replace(/[^a-záéíóúüñ\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccardSim(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) { if (setB.has(t)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

// ─── 1. Clústeres temporales ──────────────────────────────────────────────────

function detectTimeClusters(accountsData) {
  const flat = [];
  for (const { handle, posts = [] } of accountsData) {
    for (const p of posts) {
      const ts = p.indexedAt || p.record?.createdAt;
      if (ts) flat.push({ handle, ts: new Date(ts).getTime() });
    }
  }
  if (flat.length < 2) return [];

  flat.sort((a, b) => a.ts - b.ts);

  const clusters = [];
  const seen     = new Set();

  for (let i = 0; i < flat.length; i++) {
    const window  = flat.filter((p) => Math.abs(p.ts - flat[i].ts) <= TIME_WINDOW_MS);
    const handles = [...new Set(window.map((p) => p.handle))];
    if (handles.length < MIN_CLUSTER_SIZE) continue;

    const key = handles.slice().sort().join('|');
    if (!seen.has(key)) {
      seen.add(key);
      clusters.push({ handles, postCount: window.length });
    }
  }
  return clusters;
}

// ─── 2. Similitud de contenido ────────────────────────────────────────────────

function detectContentClusters(accountsData) {
  // Un vector de tokens por cuenta (union de sus últimos 15 posts)
  const vecs = accountsData.map(({ handle, posts = [] }) => ({
    handle,
    tokens: tokenize(posts.slice(0, 15).map((p) => p.record?.text || '').join(' ')),
  })).filter((v) => v.tokens.size >= 3);

  if (vecs.length < MIN_CLUSTER_SIZE) return [];

  // Grafo de similitud
  const adj = new Map();
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = jaccardSim(vecs[i].tokens, vecs[j].tokens);
      if (sim >= CONTENT_SIM_THRESHOLD) {
        const a = vecs[i].handle, b = vecs[j].handle;
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b);
        adj.get(b).add(a);
      }
    }
  }

  // BFS para encontrar componentes conexos
  const visited  = new Set();
  const clusters = [];

  for (const [node] of adj) {
    if (visited.has(node)) continue;
    const cluster = new Set();
    const queue   = [node];
    while (queue.length) {
      const curr = queue.shift();
      if (visited.has(curr)) continue;
      visited.add(curr);
      cluster.add(curr);
      for (const neighbor of (adj.get(curr) || [])) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (cluster.size >= MIN_CLUSTER_SIZE) clusters.push([...cluster]);
  }
  return clusters;
}

// ─── 3. Patrones de cuenta (solo perfil) ─────────────────────────────────────

function detectPatternClusters(accountsData) {
  const profiles = accountsData
    .map(({ handle, profile }) => ({
      handle,
      createdMs: profile?.createdAt ? new Date(profile.createdAt).getTime() : 0,
      ratio: profile
        ? (profile.followsCount || 0) / Math.max(profile.followersCount || 1, 1)
        : 0,
    }))
    .filter((p) => p.createdMs > 0)
    .sort((a, b) => a.createdMs - b.createdMs);

  if (profiles.length < MIN_CLUSTER_SIZE) return [];

  const WINDOW_MS = AGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const clusters  = [];
  const used      = new Set();

  for (let i = 0; i < profiles.length; i++) {
    if (used.has(profiles[i].handle)) continue;
    const group = profiles.filter(
      (p) => Math.abs(p.createdMs - profiles[i].createdMs) <= WINDOW_MS &&
             Math.abs(p.ratio - profiles[i].ratio) < 0.5
    );
    if (group.length >= MIN_CLUSTER_SIZE) {
      clusters.push(group.map((p) => p.handle));
      group.forEach((p) => used.add(p.handle));
    }
  }
  return clusters;
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Detecta redes coordinadas en un conjunto de cuentas.
 *
 * @param {{ handle: string, profile: object, posts: object[] }[]} accountsData
 * @returns {{
 *   detectada: boolean,
 *   nivel: 'ALTO' | 'MEDIO' | 'BAJO',
 *   puntos: number,
 *   señales: string[],
 *   clusters: string[][],
 *   topCluster: string[],
 * }}
 */
export function detectCoordinatedNetwork(accountsData) {
  if (!accountsData || accountsData.length < MIN_CLUSTER_SIZE) {
    return { detectada: false, nivel: 'BAJO', puntos: 0, señales: [], clusters: [], topCluster: [] };
  }

  let puntos      = 0;
  const señales   = [];
  const clusters  = [];

  // ── 1. Clústeres temporales ───────────────────────────────────────────────
  const timeC = detectTimeClusters(accountsData);
  if (timeC.length > 0) {
    const maxSz = Math.max(...timeC.map((c) => c.handles.length));
    puntos += Math.min(35, maxSz * 6);
    señales.push(
      `${timeC[0].handles.length} cuentas publicaron en la misma ventana de 15 min ` +
      `(${timeC[0].postCount} posts en total)`
    );
    clusters.push(...timeC.map((c) => c.handles));
  }

  // ── 2. Similitud de contenido ─────────────────────────────────────────────
  const contC = detectContentClusters(accountsData);
  if (contC.length > 0) {
    const maxSz = Math.max(...contC.map((c) => c.length));
    puntos += Math.min(40, maxSz * 8);
    señales.push(
      `${contC[0].length} cuentas publican contenido ` +
      `con ≥${Math.round(CONTENT_SIM_THRESHOLD * 100)}% de palabras en común`
    );
    clusters.push(...contC);
  }

  // ── 3. Patrones de cuenta ─────────────────────────────────────────────────
  const patC = detectPatternClusters(accountsData);
  if (patC.length > 0) {
    puntos += Math.min(20, patC[0].length * 3);
    señales.push(
      `${patC[0].length} cuentas creadas en el mismo período (±${AGE_WINDOW_DAYS} días) ` +
      `con ratios de seguidores similares`
    );
    clusters.push(...patC);
  }

  // Deduplicar clusters por contenido ordenado
  const uniq = new Map();
  for (const c of clusters) {
    const key = [...c].sort().join('|');
    if (!uniq.has(key)) uniq.set(key, c);
  }
  const uniqueClusters = [...uniq.values()];

  const nivel     = puntos >= 65 ? 'ALTO' : puntos >= 35 ? 'MEDIO' : 'BAJO';
  const detectada = puntos >= 25;
  const topCluster = uniqueClusters.reduce(
    (best, c) => c.length > best.length ? c : best, []
  );

  return { detectada, nivel, puntos, señales, clusters: uniqueClusters, topCluster };
}

/**
 * Formatea el resultado para incluir en una respuesta de Bluesky.
 */
export function formatCoordinationResult(result) {
  if (!result.detectada) {
    return `🕸️ Sin indicios de red coordinada.`;
  }

  const nivelEmoji = result.nivel === 'ALTO' ? '🔴' : result.nivel === 'MEDIO' ? '🟠' : '🟡';
  const topHandles = result.topCluster.slice(0, 3).map((h) => `@${h}`).join(', ');

  const lines = [
    `🕸️ RED COORDINADA — ${nivelEmoji} ${result.nivel}`,
    `━━━━━━━━━━━━━━━`,
    ...result.señales.slice(0, 2).map((s) => `• ${s}`),
  ];
  if (topHandles) lines.push(``, `Nodo principal: ${topHandles}`);
  return lines.join('\n');
}
