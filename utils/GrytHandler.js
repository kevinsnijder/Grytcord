import { Op } from "sequelize";
import { ChannelMap, MessageMap, UserConfig } from "../db/index.js";
import { CommandHandler } from "./CommandHandler.js";
import { cloudUploadAttachments } from "./CloudUpload.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { cardsToDiscordEmbeds } from "./EmbedConverter.js";
import { parseGrytEmojiToDiscord } from "./EmojiStickerParser.js";
import { parseGrytMentions } from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { resolveMentions } from "./MentionResolver.js";
import { checkPingPerms } from "./CheckManageServerPerms.js";
import { processReplyContent } from "./ProcessReplyContent.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { replyMarker } from "./BotEmojiSetup.js";
import { resolveDiscordThreadId } from "./DiscordThreadResolver.js";
import { bridgeAvatarURL, redactFileUrl } from "./AvatarUrl.js";

/**
 * Discord's own limit for a plain upload on an unboosted guild. Anything larger
 * is linked instead of carried.
 */
const DISCORD_MAX_UPLOAD = 9_500_000;

/** Past this many custom emojis, post a placeholder first. */
const EARLY_BRIDGE_EMOJI_THRESHOLD = 3;

const GRYT_EMOJI_PATTERN = /:[A-Za-z0-9_]{2,32}:/g;

/** @param {string | null} content */
function countCustomEmojis(content) {
  return (content ?? "").match(GRYT_EMOJI_PATTERN)?.length ?? 0;
}

function isDiscordUnknownMessageError(error) {
  return (
    error?.code === 10008 ||
    (error?.status === 404 && /unknown message/i.test(error?.message ?? ""))
  );
}

/** @param {string} url */
async function download(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 1) {
        log("GRYT", `Failed to download ${url}`, e);
        return null;
      }
    }
  }
  return null;
}

/**
 * @param {import("./GrytMessage.js").GrytMessage} message
 * @param {import("discord.js").Guild | null} discordGuild
 * @param {import("discord.js").Client} discordClient
 * @param {string} discordGuildId
 */
async function buildDiscordContent(
  message,
  discordGuild,
  discordClient,
  discordGuildId,
) {
  const canPing = await checkPingPerms(message, discordClient);

  const withChannels = await parseGrytMentions(message.content, message.server);
  const withMentions = await resolveMentions(discordGuild, withChannels);
  const sanitized = sanitizePings(withMentions, canPing);

  return parseGrytEmojiToDiscord(
    sanitized,
    discordClient,
    message.server,
    discordGuildId,
  );
}

/**
 * @param {import("./GrytMessage.js").GrytMessage} message
 * @param {import("./GrytClient.js").GrytClient} grytClient
 * @param {import("discord.js").Client} discordClient
 */
export async function GrytCreateMessageHandler(
  message,
  grytClient,
  discordClient,
) {
  log(
    "DEBUG",
    `GrytCreate received id=${message.id} channelId=${message.channelId} host=${message.host} senderId=${message.senderId}`,
  );

  // Ours, or the server talking to itself.
  if (message.isOwn || message.isSystem) return;

  const guildPrefix = await getGuildPrefix(message.guildId);
  if (message.content.startsWith(guildPrefix)) {
    CommandHandler(message, discordClient, grytClient);
    return;
  }

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "gryt",
      userId: message.senderId,
      doNotBridgePrefix: "__opted_out__",
    },
  });
  if (userOptOut) return;

  const channelMap = await ChannelMap.findOne({
    where: { grytChannelId: message.channelId },
    raw: true,
  });
  if (!channelMap) return;

  if (channelMap.bridgeType === "discord2gryt") {
    log("DEBUG", `GrytCreate skip id=${message.id} reason=oneWayBridge`);
    return;
  }

  // The copy Grytcord itself posted through this channel's webhook.
  if (message.webhookId && message.webhookId === channelMap.grytWebhookId) {
    log("DEBUG", `GrytCreate skip id=${message.id} reason=webhookEcho`);
    return;
  }

  let webhook;
  try {
    webhook = await discordClient.fetchWebhook(
      channelMap.discordWebhookId,
      channelMap.discordWebhookToken,
    );
  } catch (e) {
    log("DISCORD", `Could not fetch the bridge webhook for ${message.channelId}`, e);
    return;
  }

  const threadId = await resolveDiscordThreadId(
    discordClient,
    channelMap.discordChannelId,
  );

  let discordGuild = null;
  try {
    discordGuild = await discordClient.guilds.fetch(channelMap.discordGuildId);
  } catch {
    discordGuild = null;
  }

  // Settled once, because a placeholder and the message that replaces it have
  // to wear the same face: an edit cannot change it afterwards.
  const avatarURL = await bridgeAvatarURL(message);
  log(
    "AVATAR",
    `gryt->discord ${message.id} as "${message.author.displayName}" ` +
      `avatar=${avatarURL ? redactFileUrl(avatarURL) : "(none — Discord will use the webhook's own face)"}`,
  );

  // Mirroring custom emoji means downloading each one and uploading it to
  // Discord, which is slow enough to be noticed. Past a handful, post something
  // straight away and fill it in when the real thing is ready.
  let earlyMessageId = null;
  const customEmojiCount = countCustomEmojis(message.content);
  if (customEmojiCount >= EARLY_BRIDGE_EMOJI_THRESHOLD) {
    try {
      const placeholder =
        message.content.replace(GRYT_EMOJI_PATTERN, "⏳") ||
        `⏳ Bridging a message with ${customEmojiCount} custom emojis...`;
      const early = await webhook.send({
        content: placeholder,
        username: message.author.displayName || "Gryt",
        ...(avatarURL ? { avatarURL } : {}),
        allowedMentions: { parse: [] },
        ...(threadId ? { threadId } : {}),
      });
      earlyMessageId = early.id;
    } catch (e) {
      log("DISCORD", `Early bridge placeholder failed for ${message.id}`, e);
    }
  }

  const content = await buildDiscordContent(
    message,
    discordGuild,
    discordClient,
    channelMap.discordGuildId,
  );

  // ── Reply context ───────────────────────────────────────────────

  /** @type {any} */
  let messageReference = null;
  if (message.replyToMessageId) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          { grytMessageId: message.replyToMessageId },
          { discordMessageId: message.replyToMessageId },
        ],
      },
    });
    if (messageReference && messageReference.get("channelMapId") !== channelMap.id) {
      messageReference = null;
    }
  }

  let replyLine = "";
  if (messageReference) {
    const referenced = await message.server
      .fetchMessage(message.channelId, message.replyToMessageId)
      .catch(() => null);
    const preview = await processReplyContent(referenced);
    const who =
      messageReference.get("messageSource") === "discord"
        ? `<@${messageReference.get("authorId")}>`
        : `@${referenced?.author?.username ?? "someone"}`;
    replyLine =
      `-# ${replyMarker()} ${who}: ` +
      `[${preview}](<https://discord.com/channels/${channelMap.discordGuildId}/${channelMap.discordChannelId}/${messageReference.get("discordMessageId")}>)\n`;
  }

  // ── Attachments ─────────────────────────────────────────────────

  const files = [];
  const linked = [];
  for (const attachment of message.attachments ?? []) {
    const url = message.server.fileUrl(attachment.file_id, { download: true });
    const name = attachment.original_name ?? attachment.file_id;

    if ((attachment.size ?? 0) > DISCORD_MAX_UPLOAD) {
      linked.push(`[${name}](${url})`);
      continue;
    }

    const data = await download(url);
    if (!data) {
      linked.push(`[${name}](${url})`);
      continue;
    }
    files.push({ attachment: data, name });
  }

  let attachments;
  if (files.length > 0) {
    try {
      attachments = await cloudUploadAttachments(
        discordClient,
        channelMap.discordChannelId,
        files,
      );
    } catch (e) {
      log("DISCORD", "Attachment upload failed, linking instead", e);
      attachments = undefined;
      for (const file of files) {
        linked.push(file.name);
      }
    }
  }

  const linkedText = linked.length
    ? `\n-# attachments: ${linked.join(" ")}`
    : "";

  const embeds = cardsToDiscordEmbeds(message.cards);

  const body = `${replyLine}${content}${linkedText}`.trim();
  if (!body && embeds.length === 0 && !attachments?.length) return;

  const payload = {
    content: body || undefined,
    username: message.author.displayName || "Gryt",
    ...(avatarURL ? { avatarURL } : {}),
    ...(embeds.length > 0 ? { embeds } : {}),
    ...(attachments ? { attachments } : {}),
    allowedMentions: {
      parse: ["users", "roles"],
    },
    ...(threadId ? { threadId } : {}),
  };

  let sent;
  if (earlyMessageId) {
    // An edit takes the message's contents, not who appears to have sent it:
    // the name and picture were fixed when the placeholder went out.
    const { username: _username, avatarURL: _avatarURL, ...editable } = payload;
    try {
      sent = await webhook.editMessage(earlyMessageId, editable);
    } catch (e) {
      log(
        "DISCORD",
        `Could not fill in the placeholder ${earlyMessageId}, posting fresh`,
        e,
      );
      try {
        await webhook.deleteMessage(earlyMessageId, threadId ?? undefined);
      } catch {}
      sent = await webhook.send(payload);
    }
  } else {
    sent = await webhook.send(payload);
  }

  resetBridgeHealth(message.guildId);

  log(
    "DEBUG",
    `GrytCreate bridged grytId=${message.id} discordId=${sent.id} files=${files.length}`,
  );

  // What went out, and nothing about how it landed: Discord does not re-host an
  // `avatar_url`, and `author.avatar` on the message it hands back is null
  // whether the picture draws or not. Only looking at Discord answers that.
  if (avatarURL) {
    log("AVATAR", `sent ${sent.id} with avatar_url=${redactFileUrl(avatarURL)}`);
  }

  try {
    await MessageMap.create({
      messageSource: "gryt",
      discordMessageId: sent.id,
      grytMessageId: message.id,
      grytReplyId: message.replyToMessageId ?? null,
      discordReplyId: messageReference?.get("discordMessageId") ?? null,
      channelMapId: channelMap.id,
      authorId: message.senderId,
      grytSentVia: "webhook",
    });
  } catch (e) {
    log("DB", "Failed to save Gryt -> Discord message map", e);
  }
}

/**
 * @param {import("./GrytMessage.js").GrytMessage} message
 * @param {import("discord.js").Client} discordClient
 */
export async function GrytUpdateMessageHandler(message, discordClient) {
  log("DEBUG", `GrytUpdate received id=${message.id}`);
  if (message.isOwn) return;

  const existing = await MessageMap.findOne({
    where: { grytMessageId: message.id },
    include: ["channelMap"],
  });
  if (!existing) return;

  const channelMap = existing.get("channelMap");
  if (!channelMap) return;

  // Only the copies Grytcord posted through its own webhook can be edited, and
  // those are exactly the Gryt-sourced ones.
  if (existing.get("messageSource") !== "gryt") return;

  let webhook;
  try {
    webhook = await discordClient.fetchWebhook(
      channelMap.discordWebhookId,
      channelMap.discordWebhookToken,
    );
  } catch {
    return;
  }

  let discordGuild = null;
  try {
    discordGuild = await discordClient.guilds.fetch(channelMap.discordGuildId);
  } catch {
    discordGuild = null;
  }

  const content = await buildDiscordContent(
    message,
    discordGuild,
    discordClient,
    channelMap.discordGuildId,
  );
  const embeds = cardsToDiscordEmbeds(message.cards);

  if (!content && embeds.length === 0) return;

  const threadId = await resolveDiscordThreadId(
    discordClient,
    channelMap.discordChannelId,
  );

  log(
    "DEBUG",
    `GrytUpdate bridged grytId=${message.id} discordId=${existing.get("discordMessageId")}`,
  );

  try {
    await webhook.editMessage(existing.get("discordMessageId"), {
      content: content || undefined,
      ...(embeds.length > 0 ? { embeds } : {}),
      ...(threadId ? { threadId } : {}),
    });
  } catch (e) {
    if (!isDiscordUnknownMessageError(e)) {
      log("DISCORD", "Failed to edit bridged Discord message", e);
    }
  }
}

/**
 * @param {{ channelId: string, messageId: string, server: import("./GrytClient.js").GrytServerConnection }} event
 * @param {import("discord.js").Client} discordClient
 */
export async function GrytDeleteMessageHandler(event, discordClient) {
  log("DEBUG", `GrytDelete received id=${event.messageId}`);

  const existing = await MessageMap.findOne({
    where: { grytMessageId: event.messageId },
    include: ["channelMap"],
  });
  if (!existing) return;

  const channelMap = existing.get("channelMap");
  if (!channelMap) {
    await existing.destroy();
    return;
  }

  try {
    if (existing.get("messageSource") === "discord") {
      // The Discord side is somebody's own message, not a webhook's.
      const channel = await discordClient.channels.fetch(
        channelMap.discordChannelId,
      );
      const discordMessage = await channel.messages.fetch(
        existing.get("discordMessageId"),
      );
      await discordMessage.delete();
    } else {
      const webhook = await discordClient.fetchWebhook(
        channelMap.discordWebhookId,
        channelMap.discordWebhookToken,
      );
      const threadId = await resolveDiscordThreadId(
        discordClient,
        channelMap.discordChannelId,
      );
      if (threadId) {
        await webhook.deleteMessage(existing.get("discordMessageId"), threadId);
      } else {
        await webhook.deleteMessage(existing.get("discordMessageId"));
      }
    }
  } catch (e) {
    if (!isDiscordUnknownMessageError(e)) {
      log("DISCORD", "Failed to delete bridged Discord message", e);
      return;
    }
  }

  await existing.destroy();

  // Anything that was replying to it now points at nothing, so say so rather
  // than leaving a link to a message that is gone.
  const replies = await MessageMap.findAll({
    where: { grytReplyId: event.messageId },
    include: ["channelMap"],
  });

  for (const reply of replies) {
    const replyChannelMap = reply.get("channelMap");
    if (!replyChannelMap || reply.get("messageSource") !== "gryt") continue;

    try {
      const webhook = await discordClient.fetchWebhook(
        replyChannelMap.discordWebhookId,
        replyChannelMap.discordWebhookToken,
      );
      const current = await webhook.fetchMessage(reply.get("discordMessageId"));
      const withoutReplyLine = (current?.content ?? "").replace(/^-# .*\n/, "");
      await webhook.editMessage(reply.get("discordMessageId"), {
        content: `-# ${replyMarker()} *Deleted message*\n${withoutReplyLine}`,
      });
    } catch {
      // Cosmetic; a reply left pointing at a gone message is not worth an error.
    }

    reply.set("grytReplyId", null);
    reply.set("discordReplyId", null);
    await reply.save();
  }
}

/**
 * Everything one member wrote, gone at once — Gryt's version of a bulk delete.
 *
 * @param {{ server: import("./GrytClient.js").GrytServerConnection, raw: any }} event
 * @param {import("discord.js").Client} discordClient
 */
export async function GrytPurgeUserHandler(event, discordClient) {
  const serverUserId =
    event.raw?.server_user_id ?? event.raw?.serverUserId ?? null;
  if (!serverUserId) return;

  log("DEBUG", `GrytPurgeUser received userId=${serverUserId}`);

  const rows = await MessageMap.findAll({
    where: { messageSource: "gryt", authorId: serverUserId },
    include: ["channelMap"],
  });

  for (const row of rows) {
    await GrytDeleteMessageHandler(
      {
        server: event.server,
        channelId: row.get("channelMap")?.grytChannelId ?? "",
        messageId: row.get("grytMessageId"),
      },
      discordClient,
    );
  }
}

/**
 * Pins, again: Gryt has none, so there is nothing to keep in step.
 */
export async function GrytPinsUpdateHandler() {}
