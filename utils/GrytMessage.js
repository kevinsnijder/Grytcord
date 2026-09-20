import { cardsToText } from "./EmbedConverter.js";

/**
 * One message on one Gryt server, in the shape the rest of Grytcord talks in.
 *
 * The server sends snake_case rows that differ a little between `chat:new`,
 * `chat:edited` and the REST history. This is the one place that knows about
 * that, so nothing downstream has to.
 */
export class GrytMessage {
  /**
   * @param {import("./GrytClient.js").GrytServerConnection} server
   * @param {any} raw
   */
  constructor(server, raw) {
    this.server = server;
    this.client = server.client;
    this.raw = raw ?? {};

    this.id = this.raw.message_id ?? "";
    this.channelId = this.raw.conversation_id ?? "";
    this.host = server.host;
    this.guildId = server.guildId;
    this.content = this.raw.text ?? "";
    this.createdAt = this.raw.created_at ? new Date(this.raw.created_at) : new Date();
    this.editedAt = this.raw.edited_at ? new Date(this.raw.edited_at) : null;
    this.replyToMessageId = this.raw.reply_to_message_id ?? null;
    this.attachments = this.raw.enriched_attachments ?? [];
    this.cards = this.raw.cards ?? [];
    this.reactions = this.raw.reactions ?? [];

    const sender = this.raw.sender_server_id ?? "";
    this.senderId = sender;
    this.isSystem = sender === "system";
    /** Webhook messages carry `webhook:<id>` as their sender. */
    this.webhookId = sender.startsWith("webhook:") ? sender.slice(8) : null;
    this.isOwn = Boolean(
      server.serverUserId && sender && sender === server.serverUserId,
    );

    const nickname = this.raw.sender_nickname ?? "Unknown";
    this.author = {
      id: sender,
      username: nickname,
      displayName: nickname,
      globalName: nickname,
      avatarFileId: this.raw.sender_avatar_file_id ?? null,
      bot: Boolean(this.raw.sender_is_bot) || Boolean(this.webhookId),
    };
  }

  /** Where the member's picture lives, if they have one. */
  get avatarURL() {
    return this.author.avatarFileId
      ? this.server.fileUrl(this.author.avatarFileId)
      : null;
  }

  get channel() {
    return this.server.channels.get(this.channelId) ?? null;
  }

  get channelName() {
    return this.channel?.name ?? this.channelId;
  }

  /** A Gryt "guild" is the server itself. */
  get guild() {
    return this.server;
  }

  get member() {
    return this.server.member(this.senderId);
  }

  /**
   * @param {string | { content?: string, embeds?: any[], files?: { name: string, data: Buffer }[] }} payload
   */
  async reply(payload) {
    return sendToGryt(this.server, this.channelId, payload, {
      replyToMessageId: this.id,
    });
  }

  /** @param {string} reactionSrc */
  async react(reactionSrc) {
    if (!reactionSrc) return;
    await this.server.setReaction(this.channelId, this.id, reactionSrc, true);
  }

  /** @param {string} text */
  async edit(text) {
    await this.server.editMessage(this.channelId, this.id, text);
  }

  async delete() {
    await this.server.deleteMessage(this.channelId, this.id);
  }
}

/**
 * Post into a Gryt channel as the bot.
 *
 * Cards are a webhook's trick, not a bot's, so embeds handed to this are drawn
 * as text. Files are uploaded first and attached, which is the only way they
 * survive: an upload nothing points at is swept within the hour.
 *
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {string} channelId
 * @param {string | { content?: string, embeds?: any[], files?: { name: string, data: Buffer }[] }} payload
 * @param {{ replyToMessageId?: string | null }} [options]
 * @returns {Promise<GrytMessage | { id: string | null, channelId: string }>}
 */
export async function sendToGryt(server, channelId, payload, options = {}) {
  const normalized = typeof payload === "string" ? { content: payload } : payload ?? {};

  let text = normalized.content ?? "";
  if (normalized.embeds?.length) {
    const rendered = cardsToText(normalized.embeds);
    if (rendered) text = text ? `${text}\n\n${rendered}` : rendered;
  }

  /** @type {string[]} */
  const attachments = [];
  const wantedFiles = normalized.files ?? [];
  for (const file of wantedFiles) {
    try {
      const fileId = await server.uploadFile({
        data: file.data,
        filename: file.name,
        contentType: file.contentType,
      });
      if (fileId) attachments.push(fileId);
    } catch {
      // A file that will not upload must not take the message with it.
    }
  }

  if (wantedFiles.length > 0 && attachments.length === 0) {
    const names = wantedFiles.map((x) => x.name).join(", ");
    const note = `-# could not upload ${names} — does the bot have attach_files here?`;
    text = text ? `${text}\n${note}` : note;
  }

  // The server refuses a message that is neither text nor attachments.
  if (!text && attachments.length === 0) text = "​";

  const messageId = await server.sendMessage(channelId, {
    text,
    attachments,
    replyToMessageId: options.replyToMessageId ?? null,
  });

  return {
    platform: "gryt",
    id: messageId,
    channelId,
    server,
    /** So a caller can edit what it just posted, the way discord.js lets you. */
    edit: async (next) => {
      if (!messageId) return;
      const nextPayload = typeof next === "string" ? { content: next } : next ?? {};
      let nextText = nextPayload.content ?? "";
      if (nextPayload.embeds?.length) {
        const rendered = cardsToText(nextPayload.embeds);
        if (rendered) nextText = nextText ? `${nextText}\n\n${rendered}` : rendered;
      }
      if (!nextText) return;
      await server.editMessage(channelId, messageId, nextText);
    },
    delete: async () => {
      if (messageId) await server.deleteMessage(channelId, messageId);
    },
  };
}
