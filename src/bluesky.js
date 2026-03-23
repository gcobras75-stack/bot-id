/**
 * src/bluesky.js
 * Cliente para interactuar con la API de Bluesky (AT Protocol)
 */

import { BskyAgent } from '@atproto/api';

export class BlueskyClient {
  constructor() {
    this.agent = new BskyAgent({ service: 'https://bsky.social' });
    this.isLoggedIn = false;
  }

  /**
   * Autenticación con las credenciales del .env.
   * Reintenta hasta 3 veces con espera exponencial si Bluesky responde Rate Limit.
   * Errores que no son rate limit (credenciales incorrectas, red) fallan de inmediato.
   */
  async login() {
    const DELAYS = [15 * 60_000, 30 * 60_000]; // 15 min, 30 min
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.agent.login({
          identifier: process.env.BLUESKY_USERNAME,
          password: process.env.BLUESKY_PASSWORD,
        });
        this.isLoggedIn = true;
        console.log(`✅ Bluesky: sesión iniciada como @${process.env.BLUESKY_USERNAME}`);
        return;
      } catch (err) {
        const isRateLimit = err.status === 429 || /rate.?limit/i.test(err.message);

        if (!isRateLimit || attempt === MAX_ATTEMPTS) {
          console.error(`❌ Bluesky login fallido (intento ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
          throw err;
        }

        const waitMs = DELAYS[attempt - 1];
        console.warn(`⚠️  Rate Limit en login (intento ${attempt}/${MAX_ATTEMPTS}). Esperando ${waitMs / 60_000} minutos...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  /**
   * Obtiene menciones no procesadas del perfil del bot
   * @param {string|undefined} cursor - cursor de paginación
   */
  async getMentions(cursor = undefined) {
    this._requireLogin();
    try {
      const params = { limit: 25 };
      if (cursor) params.cursor = cursor;

      const res = await this.agent.listNotifications(params);
      const mentions = (res.data.notifications || []).filter(
        (n) => n.reason === 'mention'
      );
      return { mentions, cursor: res.data.cursor };
    } catch (err) {
      console.error('Error obteniendo menciones:', err.message);
      return { mentions: [], cursor: undefined };
    }
  }

  /**
   * Obtiene datos completos de un perfil por handle o DID
   * @param {string} handle - handle o DID de la cuenta
   */
  async getProfile(handle) {
    this._requireLogin();
    try {
      const res = await this.agent.getProfile({ actor: handle });
      return res.data;
    } catch (err) {
      console.error(`Error obteniendo perfil de ${handle}:`, err.message);
      return null;
    }
  }

  /**
   * Obtiene el historial de posts de una cuenta
   * @param {string} did - DID de la cuenta
   * @param {number} limit - número máximo de posts a obtener
   */
  async getPostHistory(did, limit = 100) {
    this._requireLogin();
    try {
      const posts = [];
      let cursor;

      while (posts.length < limit) {
        const batchSize = Math.min(limit - posts.length, 100);
        const params = { actor: did, limit: batchSize };
        if (cursor) params.cursor = cursor;

        const res = await this.agent.getAuthorFeed(params);
        const feed = res.data.feed || [];
        posts.push(...feed.map((item) => item.post));

        if (!res.data.cursor || feed.length < batchSize) break;
        cursor = res.data.cursor;
      }

      return posts.slice(0, limit);
    } catch (err) {
      console.error(`Error obteniendo historial de ${did}:`, err.message);
      return [];
    }
  }

  /**
   * Responde a un post públicamente
   * @param {string} uri - URI del post a responder
   * @param {string} cid - CID del post a responder
   * @param {string} text - texto de la respuesta
   */
  async replyToPost(uri, cid, text) {
    this._requireLogin();
    try {
      // Bluesky limita posts a 300 caracteres
      const truncated = text.length > 299 ? text.slice(0, 296) + '...' : text;

      const res = await this.agent.post({
        text: truncated,
        reply: {
          root: { uri, cid },
          parent: { uri, cid },
        },
      });
      return res;
    } catch (err) {
      console.error('Error respondiendo post:', err.message);
      return null;
    }
  }

  /**
   * Publica un nuevo post
   * @param {string} text - texto del post (máx 300 chars)
   */
  async post(text) {
    this._requireLogin();
    try {
      const truncated = text.length > 299 ? text.slice(0, 296) + '...' : text;
      const res = await this.agent.post({ text: truncated });
      return res;
    } catch (err) {
      console.error('Error publicando post:', err.message);
      return null;
    }
  }

  /**
   * Busca posts por hashtag
   * @param {string} hashtag - hashtag a buscar (sin #)
   * @param {number} limit - número de resultados
   */
  async searchHashtag(hashtag, limit = 100) {
    this._requireLogin();
    try {
      // Buscar por el hashtag usando la API de búsqueda
      const query = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
      const res = await this.agent.app.bsky.feed.searchPosts({
        q: query,
        limit: Math.min(limit, 100),
      });
      return res.data.posts || [];
    } catch (err) {
      console.error(`Error buscando ${hashtag}:`, err.message);
      return [];
    }
  }

  /**
   * Convierte URL de bsky.app a AT URI
   * Ejemplo: https://bsky.app/profile/user.bsky.social/post/3abcxyz
   *       → at://did:plc:.../app.bsky.feed.post/3abcxyz
   * @param {string} url
   */
  async bskyUrlToAtUri(url) {
    const match = url.match(/bsky\.app\/profile\/([\w.:-]+)\/post\/([\w]+)/);
    if (!match) return null;
    const [, actor, rkey] = match;

    const did = actor.startsWith('did:')
      ? actor
      : (await this.getProfile(actor))?.did;

    if (!did) return null;
    return `at://${did}/app.bsky.feed.post/${rkey}`;
  }

  /**
   * Obtiene todos los participantes únicos de un hilo (recursivo, depth 10)
   * @param {string} uri - AT URI del post raíz
   * @returns {{ rootPost: object|null, participants: Map<handle, {handle, did, postCount}> }}
   */
  async getThread(uri) {
    this._requireLogin();
    try {
      const res = await this.agent.app.bsky.feed.getPostThread({ uri, depth: 10 });
      const participants = new Map();
      this._traverseThread(res.data.thread, participants);
      return { rootPost: res.data.thread?.post || null, participants };
    } catch (err) {
      console.error('Error obteniendo hilo:', err.message);
      return { rootPost: null, participants: new Map() };
    }
  }

  _traverseThread(node, participants) {
    if (!node?.post) return;
    if (
      node.$type === 'app.bsky.feed.defs#notFoundPost' ||
      node.$type === 'app.bsky.feed.defs#blockedPost'
    ) return;

    const { handle, did } = node.post.author || {};
    if (handle) {
      const entry = participants.get(handle) || { handle, did, postCount: 0 };
      entry.postCount++;
      participants.set(handle, entry);
    }

    for (const reply of node.replies || []) {
      this._traverseThread(reply, participants);
    }
  }

  // ─── API de Chat / DMs ──────────────────────────────────────────────────────

  /**
   * Cabeceras de autenticación para la API de chat (atproto-proxy).
   * Llama al PDS de Bluesky, que redirige al servicio de chat.
   */
  _chatHeaders() {
    const token = this.agent.session?.accessJwt;
    if (!token) throw new Error('Sin sesión activa para Chat API');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat',
    };
  }

  /**
   * Lista conversaciones con mensajes no leídos.
   * @returns {Promise<object[]>} array de convo views
   */
  async listUnreadConvos(limit = 20) {
    this._requireLogin();
    try {
      const res = await fetch(
        `https://bsky.social/xrpc/chat.bsky.convo.listConvos?limit=${limit}`,
        { headers: this._chatHeaders() }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json();
      return (data.convos || []).filter((c) => c.unreadCount > 0);
    } catch (err) {
      console.error('Error listando convos:', err.message);
      return [];
    }
  }

  /**
   * Obtiene los mensajes de una conversación.
   * @param {string} convoId
   * @param {number} limit
   * @returns {Promise<object[]>} mensajes (más reciente primero)
   */
  async getConvoMessages(convoId, limit = 20) {
    this._requireLogin();
    try {
      const res = await fetch(
        `https://bsky.social/xrpc/chat.bsky.convo.getMessages?convoId=${encodeURIComponent(convoId)}&limit=${limit}`,
        { headers: this._chatHeaders() }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.messages || [];
    } catch (err) {
      console.error('Error obteniendo mensajes:', err.message);
      return [];
    }
  }

  /**
   * Envía un DM a una conversación.
   * @param {string} convoId
   * @param {string} text  (máx 1000 chars)
   * @returns {Promise<object|null>}
   */
  async sendDM(convoId, text) {
    this._requireLogin();
    try {
      const truncated = text.length > 1000 ? text.slice(0, 997) + '...' : text;
      const res = await fetch('https://bsky.social/xrpc/chat.bsky.convo.sendMessage', {
        method: 'POST',
        headers: this._chatHeaders(),
        body: JSON.stringify({
          convoId,
          message: { $type: 'chat.bsky.convo.defs#messageInput', text: truncated },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      return await res.json();
    } catch (err) {
      console.error('Error enviando DM:', err.message);
      return null;
    }
  }

  /**
   * Marca una conversación como leída hasta el mensaje indicado.
   * @param {string} convoId
   * @param {string} messageId
   */
  async markConvoRead(convoId, messageId) {
    this._requireLogin();
    try {
      const res = await fetch('https://bsky.social/xrpc/chat.bsky.convo.updateRead', {
        method: 'POST',
        headers: this._chatHeaders(),
        body: JSON.stringify({ convoId, messageId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Error marcando convo como leída:', err.message);
    }
  }

  // ─── Helpers internos ────────────────────────────────────────────────────────

  _requireLogin() {
    if (!this.isLoggedIn) {
      throw new Error('BlueskyClient: debes llamar a login() primero');
    }
  }
}
