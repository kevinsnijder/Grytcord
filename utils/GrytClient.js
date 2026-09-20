import { EventEmitter } from "node:events";
import { GrytBot, loadIdentity } from "@gryt/bot";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";
import { GrytMessage } from "./GrytMessage.js";
import RandomString from "./RandomString.js";

/**
 * What the bot asks an admin for, the first time it turns up at a server.
 *
 * The declaration is fixed from then on: a later run asking for more gets the
 * answer to the question the first one asked. So this list is the whole bridge,
 * not the part that happens to be in use today.
 *
 * - read_messages / send_messages: the bridge itself
 * - attach_files: files from Discord ride along as real uploads
 * - add_reactions: reaction bridging
 * - edit_own_messages: edits of the copies Grytcord posted as itself
 * - delete_own_messages + manage_messages: a deleted Discord message takes its
 *   Gryt copy with it, and a webhook-posted copy is not "own"
 * - manage_webhooks: `setup` creates the per-channel webhook that carries the
 *   Discord author's name and picture
 * - create_invite: the `invite` command
 */
export const WANTED_PERMISSIONS = [
  "read_messages",
  "send_messages",
  "attach_files",
  "add_reactions",
  "edit_own_messages",
  "delete_own_messages",
  "manage_messages",
  "manage_webhooks",
  "create_invite",
  "view_members",
  // The "gc!help | bridging N channels" line beside the bot's name.
  "set_activity",
];

const SEND_ACK_TIMEOUT_MS = 15_000;

/**
 * Where the REST half talks to. The same rule the SDK uses for the socket, kept
 * in step so both halves reach one server.
 *
 * Only loopback is guessed as plain http: a Gryt server on a LAN address served
 * over http needs `secure: false` in its config entry, which is passed to the
 * SDK too.
 *
 * @param {string} host
 * @param {boolean | undefined} secure
 */
function httpBase(host, secure) {
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "");
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const scheme = secure ?? !isLocal ? "https" : "http";
  return `${scheme}://${host.replace(/\/+$/, "")}`;
}

/** One Gryt server. A Grytcord may be bridging several. */
export class GrytServerConnection {
  /**
   * @param {GrytClient} client
   * @param {{ host: string, botToken?: string, secure?: boolean }} options
   */
  constructor(client, options) {
    this.client = client;
    this.host = options.host;
    this.botToken = options.botToken;
    /** Force http/https rather than guessing from the host. */
    this.secure = options.secure;
    /** @type {import("@gryt/bot").GrytBot | null} */
    this.bot = null;
    /** @type {any} */
    this.socket = null;
    /** The token the REST half authenticates with. Read off the socket. */
    this.accessToken = null;
    /**
     * The weaker token that reads uploads, and the only thing that does.
     *
     * It rides in the query string rather than a header, because these URLs end
     * up somewhere a header cannot follow — an `<img src>` in Gryt's own client,
     * and a webhook's `avatar_url` here, which Discord fetches for itself with
     * nothing of ours attached.
     */
    this.fileToken = null;
    /** @type {import("@gryt/bot").ServerInfo | null} */
    this.info = null;
    this.serverUserId = null;
    /** @type {Map<string, any>} */
    this.channels = new Map();
    /** @type {Map<string, any>} */
    this.members = new Map();
    /** @type {Map<string, { resolve: (id: string) => void, timer: NodeJS.Timeout }>} */
    this.pendingSends = new Map();
    /**
     * Who has reacted with what, as far as we last heard, keyed
     * `conversationId:messageId`. Two things need it: a Gryt reaction is a
     * toggle, so relaying a removal without knowing the current state would add
     * one instead; and `chat:reaction` sends the whole message rather than what
     * changed, so the change is a diff against this.
     * @type {Map<string, Map<string, Set<string>>>}
     */
    this.reactionState = new Map();
    /**
     * The last few hundred messages seen, so a reply preview does not cost a
     * history fetch. Keyed `conversationId:messageId`.
     * @type {Map<string, any>}
     */
    this.recentMessages = new Map();
    this.ready = false;
  }

  get restBase() {
    return httpBase(this.host, this.secure);
  }

  get name() {
    return this.info?.name ?? this.host;
  }

  /** The server id, which is what a ChannelMap stores as its "guild". */
  get guildId() {
    return this.info?.serverId ?? "";
  }

  /**
   * @param {import("@gryt/bot").BotIdentity} identity
   */
  async start(identity) {
    const bot = new GrytBot({
      host: this.host,
      identity,
      nickname: Config.GrytNickname,
      description: Config.GrytDescription,
      wants: WANTED_PERMISSIONS,
      botToken: this.botToken,
      secure: this.secure,
      // Grytcord routes commands itself, with per-server prefixes and the same
      // command set both sides see. The SDK's router would answer twice.
      prefix: "",
      helpCommand: false,
    });
    this.bot = bot;

    bot.on("waiting", (message) => {
      log(
        "GRYT",
        `${this.host}: ${message} Approve it in Server settings > Bots.`,
      );
      this.client.emit("waiting", this, message);
    });
    bot.on("error", (error) => {
      log("GRYT", `${this.host}:`, error);
      this.client.emit("error", error, this);
    });
    bot.on("disconnected", (reason) => {
      this.ready = false;
      this.accessToken = null;
      log("GRYT", `${this.host}: disconnected (${reason})`);
    });
    bot.on("channels", (channels) => {
      this.channels.clear();
      for (const channel of channels ?? []) {
        this.channels.set(channel.id, { ...channel, host: this.host });
        this.client.channelIndex.set(channel.id, this.host);
      }
      this.client.emit("channels", this, [...this.channels.values()]);
    });
    bot.on("members", (members) => {
      this.members.clear();
      for (const member of members ?? []) {
        this.members.set(member.serverUserId, member);
      }
      this.client.emit("members", this, [...this.members.values()]);
    });
    bot.on("ready", (info) => {
      this.info = info;
      this.ready = true;
      log(
        "GRYT",
        `${this.host}: joined ${info.name} as ${Config.GrytNickname} (role ${info.role || "member"})`,
      );
      this.requestMembers();
      this.client.emit("ready", this, info);
    });

    // `start()` wires the socket before it awaits anything, as long as the
    // identity is handed to it rather than loaded from disk inside — so the
    // socket is here now, and our own listeners are on it before the first
    // frame arrives.
    const started = bot.start().catch((e) => {
      log("GRYT", `${this.host}: join failed`, e);
    });

    if (bot.socket) {
      this.socket = bot.socket;
      this.wire(this.socket);
    } else {
      // Only reachable if a future SDK awaits something before opening the
      // socket. Cheap to survive, expensive to debug if it ever happens.
      const waitForSocket = setInterval(() => {
        if (!bot.socket) return;
        clearInterval(waitForSocket);
        this.socket = bot.socket;
        this.wire(this.socket);
      }, 50);
      if (typeof waitForSocket.unref === "function") waitForSocket.unref();
      setTimeout(() => clearInterval(waitForSocket), 30_000).unref?.();
    }

    return started;
  }

  /** @param {any} socket */
  wire(socket) {
    socket.on("server:joined", (payload) => {
      this.accessToken = payload?.accessToken ?? null;
      this.fileToken = payload?.fileToken ?? null;
      this.serverUserId = readSelfId(payload?.accessToken) ?? this.serverUserId;

      // Being joined is what `ready` means here. The SDK's own `ready` fires
      // once and never again, so a reconnect would otherwise leave the bridge
      // switched off for the rest of the run.
      if (this.info) {
        this.ready = true;
        // The activity line lives on the connection and died with the old one.
        this.client.emit("rejoined", this);
      }
    });
    socket.on("token:refreshed", (payload) => {
      this.accessToken = payload?.accessToken ?? this.accessToken;
      this.fileToken = payload?.fileToken ?? this.fileToken;
    });

    socket.on("chat:new", (raw) => {
      // Our own sends come back here too, which is how a send learns the id the
      // server gave it. The SDK drops them before its own listeners see them,
      // so this one is on the socket rather than on the bot.
      if (raw?.nonce && this.pendingSends.has(raw.nonce)) {
        const pending = this.pendingSends.get(raw.nonce);
        this.pendingSends.delete(raw.nonce);
        clearTimeout(pending.timer);
        pending.resolve(raw.message_id);
      }
      const message = new GrytMessage(this, raw);
      this.rememberReactions(raw);
      this.remember(raw);
      this.client.emit("messageCreate", message);
    });

    socket.on("chat:edited", (raw) => {
      this.remember(raw);
      this.client.emit("messageUpdate", new GrytMessage(this, raw));
    });

    socket.on("chat:deleted", (raw) => {
      if (!raw?.message_id) return;
      this.client.emit("messageDelete", {
        host: this.host,
        server: this,
        channelId: raw.conversation_id,
        messageId: raw.message_id,
      });
    });

    socket.on("chat:reaction", (raw) => {
      const { previous, current } = this.rememberReactions(raw);
      this.client.emit("reaction", {
        server: this,
        message: new GrytMessage(this, raw),
        changes: diffReactions(previous, current),
      });
    });

    socket.on("chat:typing", (raw) => {
      if (!raw?.conversationId) return;
      this.client.emit("typingStart", {
        server: this,
        host: this.host,
        channelId: raw.conversationId,
        serverUserId: raw.serverUserId,
        nickname: raw.nickname,
      });
    });

    socket.on("chat:purge_user", (raw) => {
      this.client.emit("purgeUser", { server: this, raw });
    });
  }

  // ── Reaction bookkeeping ──────────────────────────────────────────

  /**
   * Record the reaction state a `chat:new` / `chat:reaction` carried, and hand
   * back what it was before, so the caller can work out what changed.
   *
   * @param {any} raw
   * @returns {{ previous: Map<string, Set<string>>, current: Map<string, Set<string>> }}
   */
  rememberReactions(raw) {
    const empty = { previous: new Map(), current: new Map() };
    if (!raw?.message_id) return empty;

    const key = `${raw.conversation_id}:${raw.message_id}`;
    const previous = this.reactionState.get(key) ?? new Map();

    /** @type {Map<string, Set<string>>} */
    const current = new Map();
    for (const reaction of raw.reactions ?? []) {
      current.set(reaction.src, new Set(reaction.users ?? []));
    }
    this.reactionState.set(key, current);

    return { previous, current };
  }

  /**
   * Whether this bot's own reaction is on a message right now.
   *
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} reactionSrc
   */
  hasOwnReaction(conversationId, messageId, reactionSrc) {
    if (!this.serverUserId) return false;
    const state = this.reactionState.get(`${conversationId}:${messageId}`);
    return Boolean(state?.get(reactionSrc)?.has(this.serverUserId));
  }

  // ── Socket actions ────────────────────────────────────────────────

  /** @param {string} event @param {object} payload */
  emitAuthed(event, payload) {
    if (!this.socket || !this.accessToken) {
      throw new Error(`Not joined to ${this.host} yet.`);
    }
    this.socket.emit(event, { ...payload, accessToken: this.accessToken });
  }

  /** @param {string} permission */
  can(permission) {
    return this.bot?.can(permission) ?? false;
  }

  /** What the server says this bot may do here. */
  get permissions() {
    return this.bot?.permissions ?? [];
  }

  /**
   * Post as the bot. Carries files and replies, and can be edited later, which
   * a webhook message cannot.
   *
   * @param {string} conversationId
   * @param {{ text?: string, attachments?: string[], replyToMessageId?: string | null }} options
   * @returns {Promise<string | null>} the new message's id
   */
  async sendMessage(conversationId, options) {
    const nonce = `gc_${Date.now()}_${RandomString(10)}`;
    const payload = {
      conversationId,
      text: options.text ?? "",
      nonce,
    };
    if (options.attachments?.length) payload.attachments = options.attachments;
    if (options.replyToMessageId)
      payload.replyToMessageId = options.replyToMessageId;

    const waitForId = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(nonce);
        resolve(null);
      }, SEND_ACK_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.pendingSends.set(nonce, { resolve, timer });
    });

    this.emitAuthed("chat:send", payload);
    return waitForId;
  }

  /**
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} text
   */
  async editMessage(conversationId, messageId, text) {
    this.emitAuthed("chat:edit", { conversationId, messageId, text });
  }

  /**
   * @param {string} conversationId
   * @param {string} messageId
   */
  async deleteMessage(conversationId, messageId) {
    this.emitAuthed("chat:delete", { conversationId, messageId });
  }

  /**
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} reactionSrc
   */
  async react(conversationId, messageId, reactionSrc) {
    this.emitAuthed("chat:react", { conversationId, messageId, reactionSrc });
  }

  /**
   * Add or remove one reaction, given that the server only offers a toggle.
   *
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} reactionSrc
   * @param {boolean} wanted
   */
  async setReaction(conversationId, messageId, reactionSrc, wanted) {
    if (this.hasOwnReaction(conversationId, messageId, reactionSrc) === wanted)
      return;

    await this.react(conversationId, messageId, reactionSrc);

    // Assume it took. The `chat:reaction` that follows is the real answer and
    // overwrites this a moment later.
    const key = `${conversationId}:${messageId}`;
    const state = this.reactionState.get(key) ?? new Map();
    const users = new Set(state.get(reactionSrc) ?? []);
    if (wanted) users.add(this.serverUserId);
    else users.delete(this.serverUserId);
    if (users.size > 0) state.set(reactionSrc, users);
    else state.delete(reactionSrc);
    this.reactionState.set(key, state);
  }

  /** @param {string} conversationId */
  sendTyping(conversationId) {
    this.socket?.emit("chat:typing", { conversationId });
  }

  requestMembers() {
    this.socket?.emit("members:fetch", {});
  }

  /**
   * The line beside the bot's name in the member list. Gryt caps it at 96
   * characters and clears it when the connection goes, so it is re-sent on
   * every join rather than stored.
   *
   * @param {string} text
   */
  setActivity(text) {
    if (!this.socket || !this.ready) return;
    this.socket.emit("presence:activity", { activity: String(text).slice(0, 96) });
  }

  /**
   * Open (or find) the direct conversation with one member.
   *
   * `dm:open` is idempotent, so asking twice gets the same conversation back.
   * Returns null when the server has direct messages turned off.
   *
   * @param {string} targetServerUserId
   * @returns {Promise<string | null>} the conversation id
   */
  async openDm(targetServerUserId) {
    if (!this.socket || !targetServerUserId) return null;
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.socket?.off("dm:opened", onOpened);
        this.socket?.off("dm:error", onError);
        resolve(value);
      };
      const onOpened = (payload) => done(payload?.conversation_id ?? null);
      const onError = () => done(null);
      const timer = setTimeout(() => done(null), 10_000);

      this.socket.once("dm:opened", onOpened);
      this.socket.once("dm:error", onError);
      this.emitAuthed("dm:open", { targetServerUserId });
    });
  }

  /**
   * @param {{ maxUses?: number, expiresInHours?: number }} options
   * @returns {Promise<{ code: string } | null>}
   */
  async createInvite(options = {}) {
    if (!this.socket) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket?.off("server:invite:created", onCreated);
        resolve(null);
      }, 10_000);
      const onCreated = (payload) => {
        clearTimeout(timer);
        this.socket?.off("server:invite:created", onCreated);
        resolve(payload?.invite ?? null);
      };
      this.socket.once("server:invite:created", onCreated);
      this.emitAuthed("server:invites:create", {
        maxUses: options.maxUses ?? 0,
        infinite: !options.maxUses,
        expiresInHours: options.expiresInHours ?? 48,
        note: "Created by Grytcord",
      });
    });
  }

  // ── REST ──────────────────────────────────────────────────────────

  /**
   * @param {string} path
   * @param {{ method?: string, body?: any, form?: FormData, auth?: boolean }} [options]
   */
  async rest(path, options = {}) {
    const headers = {};
    if (options.auth !== false) {
      if (!this.accessToken) throw new Error(`Not joined to ${this.host} yet.`);
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    let body;
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.restBase}${path}`, {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const error = new Error(
        `${options.method ?? "GET"} ${path} on ${this.host} failed: ${res.status} ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`,
      );
      // @ts-ignore
      error.status = res.status;
      // @ts-ignore
      error.body = parsed;
      throw error;
    }

    return parsed;
  }

  /**
   * @param {{ data: Buffer | ArrayBuffer, filename: string, contentType?: string }} file
   * @returns {Promise<string | null>} the stored file's id
   */
  async uploadFile(file) {
    const form = new FormData();
    const bytes = file.data instanceof Buffer ? file.data : Buffer.from(file.data);
    form.append(
      "file",
      new Blob([bytes], { type: file.contentType || "application/octet-stream" }),
      file.filename,
    );
    const res = await this.rest("/api/uploads", { method: "POST", form });
    return res?.fileId ?? null;
  }

  /**
   * A URL anybody holding it can read the file from, for twelve hours.
   *
   * The token has to be in the query string: this URL is handed to Discord as a
   * webhook's `avatar_url` and fetched by Discord, not by us, so there is no
   * request of ours to put a header on. Without it every read comes back 401
   * and the picture silently does not appear.
   *
   * @param {string} fileId
   * @param {{ thumb?: boolean, download?: boolean }} [options]
   */
  fileUrl(fileId, options = {}) {
    if (!this.fileToken && !this.warnedAboutFileToken) {
      this.warnedAboutFileToken = true;
      log(
        "GRYT",
        `${this.host} has not sent a file token, so avatars and attachments will not load. Is the server older than file tokens?`,
      );
    }

    const params = new URLSearchParams();
    if (this.fileToken) params.set("t", this.fileToken);
    if (options.thumb) params.set("thumb", "1");
    if (options.download) params.set("download", "1");

    const query = params.toString();
    return `${this.restBase}/api/uploads/files/${fileId}${query ? `?${query}` : ""}`;
  }

  /**
   * Recent messages in a channel.
   *
   * Over the socket rather than `/api/messages`, because `chat:history` comes
   * back enriched — sender nicknames and attachment metadata — and the REST
   * route hands back the raw rows, which would bridge every backfilled message
   * as "Unknown" with no files.
   *
   * @param {string} conversationId
   */
  async fetchMessages(conversationId, limit = 50) {
    const history = await new Promise((resolve) => {
      if (!this.socket) {
        resolve(null);
        return;
      }

      const onHistory = (payload) => {
        if (payload?.conversation_id !== conversationId) return;
        clearTimeout(timer);
        this.socket?.off("chat:history", onHistory);
        resolve(payload.items ?? []);
      };
      const timer = setTimeout(() => {
        this.socket?.off("chat:history", onHistory);
        resolve(null);
      }, 15_000);

      this.socket.on("chat:history", onHistory);
      this.socket.emit("chat:fetch", {
        conversationId,
        limit: Math.min(limit, 200),
      });
    });

    if (history) return history.map((raw) => new GrytMessage(this, raw));

    // The raw rows are worse than nothing only if they are silently worse, so
    // say so and carry on.
    log("GRYT", `chat:fetch timed out on ${this.host}, falling back to REST.`);
    const res = await this.rest(
      `/api/messages/${encodeURIComponent(conversationId)}?limit=${Math.min(limit, 200)}`,
    );
    return (res?.items ?? []).map((raw) => new GrytMessage(this, raw));
  }

  /**
   * Keep a message around for the next reply that quotes it.
   *
   * @param {any} raw
   */
  remember(raw) {
    if (!raw?.message_id) return;
    this.recentMessages.set(`${raw.conversation_id}:${raw.message_id}`, raw);
    if (this.recentMessages.size > 500) {
      const oldest = this.recentMessages.keys().next().value;
      this.recentMessages.delete(oldest);
    }
  }

  /**
   * @param {string} conversationId
   * @param {string} messageId
   */
  async fetchMessage(conversationId, messageId) {
    const cached = this.recentMessages.get(`${conversationId}:${messageId}`);
    if (cached) return new GrytMessage(this, cached);

    const messages = await this.fetchMessages(conversationId, 100);
    for (const message of messages) this.remember(message.raw);
    return messages.find((x) => x.id === messageId) ?? null;
  }

  async listWebhooks() {
    const res = await this.rest("/api/webhooks");
    return res?.items ?? [];
  }

  /**
   * @param {{ channelId: string, displayName: string, avatarFileId?: string | null }} options
   */
  async createWebhook(options) {
    return this.rest("/api/webhooks", {
      method: "POST",
      body: {
        channel_id: options.channelId,
        display_name: options.displayName,
        ...(options.avatarFileId ? { avatar_file_id: options.avatarFileId } : {}),
      },
    });
  }

  /** @param {string} webhookId */
  async deleteWebhook(webhookId) {
    return this.rest(`/api/webhooks/${webhookId}`, { method: "DELETE" });
  }

  /**
   * Post through a webhook. No token needed: the URL is the credential.
   *
   * @param {string} webhookId
   * @param {string} webhookToken
   * @param {{ text?: string, display_name?: string, avatar_url?: string, cards?: any[] }} payload
   * @returns {Promise<{ message_id: string, conversation_id: string, warnings: any[] } | null>}
   */
  async postWebhook(webhookId, webhookToken, payload) {
    const result = await this.rest(
      `/api/webhooks/${webhookId}/${webhookToken}`,
      { method: "POST", body: payload, auth: false },
    );
    if (result?.warnings?.length) {
      log("GRYT", `Webhook ${webhookId} warnings:`, result.warnings);
    }
    return result;
  }

  async listEmojis() {
    try {
      const res = await this.rest("/api/emojis", { auth: false });
      return Array.isArray(res) ? res : (res?.items ?? []);
    } catch {
      return [];
    }
  }

  /**
   * @param {{ data: Buffer, name: string, contentType?: string }} emoji
   */
  async createEmoji(emoji) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([emoji.data], { type: emoji.contentType || "image/png" }),
      `${emoji.name}.png`,
    );
    form.append("name", emoji.name);
    return this.rest("/api/emojis", { method: "POST", form });
  }

  /** @param {string} name */
  emojiUrl(name) {
    return `${this.restBase}/api/emojis/img/${encodeURIComponent(name)}`;
  }

  /** @param {string} serverUserId */
  member(serverUserId) {
    return this.members.get(serverUserId) ?? null;
  }

  /** The bot's own member entry, once the member list has been round. */
  me() {
    return this.serverUserId ? this.members.get(this.serverUserId) : null;
  }

  async stop() {
    try {
      await this.bot?.stop();
    } catch {}
  }
}

/**
 * Every Gryt server Grytcord is on, behind one event stream.
 *
 * The Discord side is one client for many guilds; a Gryt bot is one connection
 * per server, so this is the piece that makes the two halves the same shape.
 */
export class GrytClient extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, GrytServerConnection>} */
    this.servers = new Map();
    /** Which server a channel is on, so a channel id alone is enough to route. */
    this.channelIndex = new Map();
    /** @type {import("@gryt/bot").BotIdentity | null} */
    this.identity = null;
    this.readyAt = null;
  }

  get user() {
    const first = [...this.servers.values()].find((x) => x.serverUserId);
    return first
      ? { id: first.serverUserId, username: Config.GrytNickname }
      : null;
  }

  /** Whether at least one Gryt server is joined. */
  isReady() {
    return [...this.servers.values()].some((x) => x.ready);
  }

  /** @param {string} host */
  server(host) {
    return this.servers.get(host) ?? null;
  }

  /** Where a channel lives, or null when it isn't one of ours. */
  resolveChannel(channelId) {
    const host = this.channelIndex.get(channelId);
    if (host) {
      const server = this.servers.get(host);
      if (server) return { server, channel: server.channels.get(channelId) };
    }
    for (const server of this.servers.values()) {
      const channel = server.channels.get(channelId);
      if (channel) {
        this.channelIndex.set(channelId, server.host);
        return { server, channel };
      }
    }
    return null;
  }

  /** The server a bridged ChannelMap row points at. */
  serverFor(channelMap) {
    const host = channelMap?.grytHost;
    if (host && this.servers.has(host)) return this.servers.get(host);
    const resolved = this.resolveChannel(channelMap?.grytChannelId);
    if (resolved) return resolved.server;
    for (const server of this.servers.values()) {
      if (server.guildId && server.guildId === channelMap?.grytGuildId)
        return server;
    }
    return null;
  }

  /** The server whose id is `guildId`. */
  guild(guildId) {
    for (const server of this.servers.values()) {
      if (server.guildId === guildId) return server;
    }
    return null;
  }

  async login() {
    const hosts = (Config.GrytServers ?? []).filter((x) => x?.host);
    if (hosts.length === 0) {
      log(
        "GRYT",
        "No Gryt servers configured. Add one to GrytServers in config.js.",
      );
      return;
    }

    // One key for every server: the same bot, known by the same id everywhere.
    this.identity = await loadIdentity(Config.GrytIdentityPath);
    log("GRYT", `Bot identity ${this.identity.subject}`);

    for (const entry of hosts) {
      const connection = new GrytServerConnection(this, entry);
      this.servers.set(entry.host, connection);
      await connection.start(this.identity);
    }

    this.readyAt = new Date();
  }

  async destroy() {
    for (const server of this.servers.values()) await server.stop();
  }
}

/**
 * What changed between two reaction snapshots, as one entry per person per
 * emoji. `chat:reaction` carries the whole message, so this is where "somebody
 * added 🎉" comes from.
 *
 * @param {Map<string, Set<string>>} previous
 * @param {Map<string, Set<string>>} current
 * @returns {{ action: "add" | "remove", src: string, serverUserId: string }[]}
 */
function diffReactions(previous, current) {
  const changes = [];

  for (const [src, users] of current) {
    const before = previous.get(src) ?? new Set();
    for (const user of users) {
      if (!before.has(user)) changes.push({ action: "add", src, serverUserId: user });
    }
  }

  for (const [src, users] of previous) {
    const after = current.get(src) ?? new Set();
    for (const user of users) {
      if (!after.has(user))
        changes.push({ action: "remove", src, serverUserId: user });
    }
  }

  return changes;
}

/**
 * The bot's own id, read out of the token the server just issued it. Not
 * verified, and it does not need to be: nothing is authorised on it here, it
 * only answers "did I write this message".
 *
 * @param {string} accessToken
 */
function readSelfId(accessToken) {
  try {
    const [, payload] = String(accessToken).split(".");
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8",
      ),
    );
    return json.serverUserId ?? null;
  } catch {
    return null;
  }
}
