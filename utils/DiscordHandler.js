import { MessageFlags, MessageType } from "discord.js";
import { Op } from "sequelize";
import truncate from "truncate";
import { ChannelMap, MessageMap, UserConfig } from "../db/index.js";
import Config from "./ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { sendErrorMessage } from "./SendErrorMessage.js";
import { discordEmbedsToCards, attachmentToCard, cardsToText } from "./EmbedConverter.js";
import { parseDiscordEmojiToGryt } from "./EmojiStickerParser.js";
import {
  attemptParseBridgedMessage,
  parseDiscordMentions,
} from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { discordUserCanPing } from "./CheckManageServerPerms.js";
import { isDiscordSpoilerAttachment } from "./SpoilerAttachments.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { processReplyContent } from "./ProcessReplyContent.js";

/** Gryt refuses anything longer, rather than trimming it. */
const GRYT_MESSAGE_LIMIT = 4000;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * How a Discord message becomes a Gryt one.
 *
 * Two ways, and the message decides which:
 *
 * - **Webhook** for the common case. It carries the author's name and picture,
 *   and Discord embeds cross as cards. It cannot carry files or be edited
 *   afterwards, because a webhook message is not anybody's to edit.
 * - **The bot itself** when there are files. `chat:send` takes real uploads and
 *   a real reply, and the bot can edit and delete its own messages later. The
 *   cost is the name: it arrives as Grytcord, with the author's name on the
 *   first line.
 *
 * Which one was used is written down on the MessageMap, because the edit and
 * delete handlers need to know.
 */

function isGrytUnknownMessageError(error) {
  const message = String(error?.message ?? error ?? "");
  return /message not found/i.test(message);
}

/** @param {string} url */
async function downloadAttachment(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? undefined,
      };
    } catch (e) {
      if (attempt === 1) {
        log("DISCORD", `Failed to download attachment ${url}`, e);
        return null;
      }
    }
  }
  return null;
}

/** @param {string} text */
function fitGrytMessage(text) {
  if (!text) return "";
  return text.length > GRYT_MESSAGE_LIMIT
    ? `${text.slice(0, GRYT_MESSAGE_LIMIT - 1)}…`
    : text;
}

/**
 * @param {import("discord.js").Message} message
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {string | null} rawContent
 * @param {import("discord.js").Client} discordClient
 */
async function buildGrytContent(message, server, rawContent, discordClient) {
  const canPing = await discordUserCanPing(
    message.guildId ?? "",
    message.author?.id ?? "",
    discordClient,
  );

  const mentioned = await parseDiscordMentions(message, rawContent, server);
  const sanitized = sanitizePings(mentioned, canPing);
  return parseDiscordEmojiToGryt(sanitized, server);
}

/**
 * The quote line a reply gets when it goes through a webhook, which has no
 * reply of its own.
 *
 * @param {any} referenced
 * @param {string} authorName
 */
async function replyQuote(referenced, authorName) {
  const preview = await processReplyContent(referenced);
  return `> ↪ **${authorName}**: ${preview}`;
}

/**
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} client
 * @param {import("./GrytClient.js").GrytClient} grytClient
 * @param {boolean} [doNotExecuteCommand]
 */
export async function DiscordCreateMessageHandler(
  message,
  client,
  grytClient,
  doNotExecuteCommand = false,
) {
  log(
    "DEBUG",
    `DiscordCreate received id=${message.id} channelId=${message.channelId} guildId=${message.guildId} authorId=${message.author?.id} type=${message.type}`,
  );

  if (
    !message.guildId ||
    message.type === MessageType.ChannelPinnedMessage ||
    message.type === MessageType.ThreadCreated
  ) {
    return;
  }

  const guildPrefix = await getGuildPrefix(message.guildId);
  if (message.content.startsWith(guildPrefix)) {
    if (doNotExecuteCommand) return;
    CommandHandler(message, client, grytClient);
    return;
  }

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: message.author.id,
      doNotBridgePrefix: "__opted_out__",
    },
  });
  if (userOptOut) {
    log("DEBUG", `DiscordCreate skip id=${message.id} reason=userOptOut`);
    return;
  }

  const channelMap = await ChannelMap.findOne({
    where: { discordChannelId: message.channelId },
    raw: true,
  });

  if (!channelMap) return;
  if (channelMap.bridgeType === "gryt2discord") {
    log("DEBUG", `DiscordCreate skip id=${message.id} reason=oneWayBridge`);
    return;
  }
  if (message.webhookId && channelMap.discordWebhookId === message.webhookId) {
    log("DEBUG", `DiscordCreate skip id=${message.id} reason=webhookEcho`);
    return;
  }

  const server = grytClient.serverFor(channelMap);
  if (!server?.ready) {
    log(
      "GRYT",
      `Not bridging ${message.id}: not joined to ${channelMap.grytHost} (yet).`,
    );
    return;
  }

  // A slash command's "thinking…" message has no content yet. Wait for the
  // real one rather than bridging an empty box.
  if (
    message.type === MessageType.ChatInputCommand &&
    message.flags.has(MessageFlags.Loading)
  ) {
    setTimeout(async () => {
      try {
        await DiscordCreateMessageHandler(message, client, grytClient, true);
      } catch (e) {
        await sendErrorMessage(message, client, grytClient, e);
      }
    }, 5000);
    return;
  }

  const bridgeContent = await attemptParseBridgedMessage(message);

  /** @type {any} */
  let messageReference = null;
  if (message.reference || bridgeContent.isBridge || bridgeContent.isProxy) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          { discordMessageId: message.reference?.messageId ?? "" },
          { discordMessageId: bridgeContent.messageData.messageId ?? "" },
          { grytMessageId: message.reference?.messageId ?? "" },
        ],
      },
    });
    if (messageReference && messageReference.get("channelMapId") !== channelMap.id) {
      messageReference = null;
    }
  }

  let forwardedMessage;
  if (
    message.reference?.type === 1 &&
    message.type !== MessageType.UserJoin &&
    message.flags?.bitfield !== MessageFlags.IsCrosspost
  ) {
    forwardedMessage = message.messageSnapshots?.first();
  }

  const source = forwardedMessage ?? message;

  const sourceContent =
    (forwardedMessage?.content ||
      bridgeContent.messageData.parsedContent ||
      source.content) ??
    "";

  const parsedContent = await buildGrytContent(
    message,
    server,
    sourceContent,
    client,
  );

  // ── The bits that hang off a message ────────────────────────────

  const stickers = [...(source.stickers?.values() ?? [])];
  const stickerText =
    stickers.length > 0
      ? stickers.map((x) => `[${x.name}](${x.url})`).join(", ")
      : "";

  const userJoin =
    message.type === MessageType.UserJoin
      ? `*@${message.author.tag} joined the bridged server*`
      : "";

  const allAttachments = [...(source.attachments?.values() ?? [])];
  const carriable = allAttachments.filter(
    (x) => x.size <= Config.MaxAttachmentBytes,
  );
  const tooBig = allAttachments.filter((x) => x.size > Config.MaxAttachmentBytes);
  const tooBigText = tooBig
    .map((x) => `[${x.name}](${x.url})`)
    .join(" ");

  const embeds = [...(source.embeds ?? [])];
  if (typeof bridgeContent.excludeEmbed === "number") {
    embeds.splice(bridgeContent.excludeEmbed, 1);
  }
  const usableEmbeds = embeds.filter(
    (x) => !x.url || !parsedContent.includes(x.url),
  );

  const authorName =
    message.member?.displayName ??
    message.author.displayName ??
    message.author.globalName ??
    message.author.username;

  const forwardedLine = forwardedMessage ? "> ↪ Forwarded" : "";

  // Whatever this is a reply to, fetched once: both routes want the name and
  // the first line of it, and the webhook route has no reply of its own.
  let referencedMessage = null;
  if (message.reference?.messageId) {
    referencedMessage = await message.channel.messages
      .fetch(message.reference.messageId)
      .catch(() => null);
  }
  const referencedName = referencedMessage
    ? (referencedMessage.member?.displayName ??
      referencedMessage.author?.displayName ??
      referencedMessage.author?.username ??
      "someone")
    : "someone";

  const interactingUser = message.interaction
    ? message.interactionMetadata?.user
    : undefined;
  const interactionLine = interactingUser
    ? `> ↪ @${interactingUser.tag} used \`/${message.interaction?.commandName}\``
    : "";

  // Files decide the route: only the bot can actually carry them. A bridge
  // whose webhook has gone (deleted by hand, or never created because the bot
  // lacked Manage webhooks) falls back to the bot rather than stopping.
  const hasWebhook = Boolean(
    channelMap.grytWebhookId && channelMap.grytWebhookToken,
  );
  const canCarryFiles =
    carriable.length > 0 && server.can("attach_files") && server.can("send_messages");
  const useBotSend = canCarryFiles || !hasWebhook;

  const bodyParts = [
    forwardedLine,
    interactionLine,
    parsedContent,
    stickerText,
    userJoin,
    tooBigText ? `-# attachments over the size limit: ${tooBigText}` : "",
  ].filter(Boolean);

  let grytMessageId = null;
  let sentVia = "webhook";

  if (useBotSend) {
    sentVia = "bot";

    /** @type {string[]} */
    const fileIds = [];
    for (const attachment of carriable) {
      const downloaded = await downloadAttachment(
        attachment.proxyURL ?? attachment.url,
      );
      if (!downloaded) continue;
      try {
        const fileId = await server.uploadFile({
          data: downloaded.data,
          filename: attachment.name,
          contentType:
            attachment.contentType ?? downloaded.contentType ?? undefined,
        });
        if (fileId) fileIds.push(fileId);
      } catch (e) {
        log("GRYT", `Upload of ${attachment.name} failed`, e);
      }
    }

    // A file that would not upload still gets a link, rather than vanishing.
    const failed = carriable.length - fileIds.length;
    const failedText =
      failed > 0
        ? `\n-# ${failed} attachment${failed === 1 ? "" : "s"} could not be uploaded: ${carriable
            .map((x) => `[${x.name}](${x.url})`)
            .join(" ")}`
        : "";

    const embedText = usableEmbeds.length
      ? cardsToText(discordEmbedsToCards(usableEmbeds))
      : "";

    // A mapped reply becomes a real Gryt reply, so it needs no quote line.
    // One we cannot map still says what it was answering.
    const replyLine =
      !messageReference && referencedMessage
        ? await replyQuote(referencedMessage, referencedName)
        : "";

    const text = fitGrytMessage(
      [`**${authorName}**`, replyLine, ...bodyParts, embedText]
        .filter(Boolean)
        .join("\n") + failedText,
    );

    grytMessageId = await server.sendMessage(channelMap.grytChannelId, {
      text,
      attachments: fileIds,
      replyToMessageId: messageReference?.get("grytMessageId") ?? null,
    });
  } else {
    // A webhook message has no reply of its own, so every reply gets the
    // quote line.
    const replyLine = referencedMessage
      ? await replyQuote(referencedMessage, referencedName)
      : "";

    const cards = discordEmbedsToCards(usableEmbeds);

    // An image can still ride along on a webhook message, as a card. Gryt
    // downloads it once and keeps its own copy, so the Discord link expiring
    // afterwards changes nothing.
    for (const attachment of carriable) {
      if (cards.length >= 10) break;
      const isImage =
        IMAGE_TYPES.includes(attachment.contentType ?? "") ||
        /\.(png|jpe?g|webp|gif)$/i.test(attachment.name ?? "");
      if (!isImage) continue;
      const card = attachmentToCard({
        name: attachment.name,
        url: attachment.url,
        spoiler: isDiscordSpoilerAttachment(attachment),
      });
      if (card) cards.push(card);
    }

    const nonImages = carriable.filter(
      (x) =>
        !IMAGE_TYPES.includes(x.contentType ?? "") &&
        !/\.(png|jpe?g|webp|gif)$/i.test(x.name ?? ""),
    );
    const nonImageText = nonImages.length
      ? `-# attachments: ${nonImages.map((x) => `[${x.name}](${x.url})`).join(" ")}`
      : "";

    const text = fitGrytMessage(
      [replyLine, ...bodyParts, nonImageText].filter(Boolean).join("\n"),
    );

    if (!text && cards.length === 0) return;

    const result = await server.postWebhook(
      channelMap.grytWebhookId,
      channelMap.grytWebhookToken,
      {
        ...(text ? { text } : {}),
        display_name: truncate(authorName, 64),
        ...(message.author.displayAvatarURL
          ? { avatar_url: message.author.displayAvatarURL({ extension: "png", size: 256 }) }
          : {}),
        ...(cards.length > 0 ? { cards } : {}),
      },
    );
    grytMessageId = result?.message_id ?? null;
  }

  if (!grytMessageId) {
    log("GRYT", `Bridged ${message.id} but never learned its Gryt id.`);
    return;
  }

  resetBridgeHealth(message.guildId);

  log(
    "DEBUG",
    `DiscordCreate bridged discordId=${message.id} grytId=${grytMessageId} via=${sentVia} files=${carriable.length}`,
  );

  try {
    await MessageMap.create({
      messageSource: "discord",
      discordMessageId: message.id,
      grytMessageId,
      grytReplyId: messageReference?.get("grytMessageId") ?? null,
      discordReplyId: message.reference?.messageId ?? null,
      channelMapId: channelMap.id,
      authorId: message.author.id,
      grytSentVia: sentVia,
    });
  } catch (e) {
    log("DB", "Failed to save Discord -> Gryt message map", e);
  }
}

/**
 * @param {any} oldMsg
 * @param {import("discord.js").Message} newMsg
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export async function DiscordUpdateMessageHandler(
  oldMsg,
  newMsg,
  discordClient,
  grytClient,
) {
  const authorId = newMsg.author?.id ?? oldMsg?.author?.id ?? "";
  log("DEBUG", `DiscordUpdate received id=${newMsg.id} authorId=${authorId}`);

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: authorId,
      doNotBridgePrefix: "__opted_out__",
    },
  });
  if (userOptOut) return;

  const existing = await MessageMap.findOne({
    where: { discordMessageId: newMsg.id },
    include: ["channelMap"],
  });
  if (!existing) return;

  const channelMap = existing.get("channelMap");
  if (!channelMap) return;

  // A webhook message belongs to the webhook, and Gryt lets nobody edit
  // somebody else's, so the copy keeps the text it was posted with. Reposting
  // it would move the message to the bottom of the channel, which is worse.
  if (existing.get("grytSentVia") !== "bot") {
    log(
      "DEBUG",
      `DiscordUpdate skip id=${newMsg.id} reason=webhookMessagesCannotBeEdited`,
    );
    return;
  }

  const server = grytClient.serverFor(channelMap);
  if (!server?.ready || !server.can("edit_own_messages")) return;

  const bridgeContent = await attemptParseBridgedMessage(newMsg);
  const parsedContent = await buildGrytContent(
    newMsg,
    server,
    bridgeContent.messageData.parsedContent || newMsg.content,
    discordClient,
  );

  const authorName =
    newMsg.member?.displayName ??
    newMsg.author?.displayName ??
    newMsg.author?.username ??
    "Unknown";

  const embeds = [...(newMsg.embeds ?? [])];
  if (typeof bridgeContent.excludeEmbed === "number") {
    embeds.splice(bridgeContent.excludeEmbed, 1);
  }
  const embedText = embeds.length
    ? cardsToText(discordEmbedsToCards(embeds))
    : "";

  const text = fitGrytMessage(
    [`**${authorName}**`, parsedContent, embedText].filter(Boolean).join("\n"),
  );
  if (!text) return;

  log(
    "DEBUG",
    `DiscordUpdate bridged discordId=${newMsg.id} grytId=${existing.get("grytMessageId")}`,
  );

  await server.editMessage(
    channelMap.grytChannelId,
    existing.get("grytMessageId"),
    text,
  );
}

/**
 * @param {any} msg
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export async function DiscordDeleteMessageHandler(msg, grytClient) {
  log("DEBUG", `DiscordDelete received id=${msg.id}`);

  const existing = await MessageMap.findOne({
    where: { discordMessageId: msg.id },
    include: ["channelMap"],
  });
  if (!existing) return;

  const channelMap = existing.get("channelMap");
  if (!channelMap) {
    await existing.destroy();
    return;
  }

  const server = grytClient.serverFor(channelMap);
  if (!server?.ready) return;

  // Deleting the bot's own copy needs `delete_own_messages`; a webhook's copy
  // is somebody else's message as far as Gryt is concerned, so that one needs
  // `manage_messages`.
  const own = existing.get("grytSentVia") === "bot";
  if (!server.can(own ? "delete_own_messages" : "manage_messages")) {
    log(
      "GRYT",
      `Cannot delete ${existing.get("grytMessageId")}: missing ${own ? "delete_own_messages" : "manage_messages"} on ${server.host}.`,
    );
    return;
  }

  try {
    await server.deleteMessage(
      channelMap.grytChannelId,
      existing.get("grytMessageId"),
    );
  } catch (e) {
    if (!isGrytUnknownMessageError(e)) {
      log("GRYT", `Failed to delete bridged Gryt message`, e);
      return;
    }
  }

  await existing.destroy();
}

/**
 * Gryt has no bulk delete, so this is the same delete, several times.
 *
 * @param {import("discord.js").ReadonlyCollection<string, any>} msgs
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export async function DiscordBulkDeleteMessageHandler(msgs, grytClient) {
  log("DEBUG", `DiscordBulkDelete received count=${msgs.size}`);

  const existing = await MessageMap.findAll({
    where: {
      discordMessageId: { [Op.in]: msgs.map((x) => x.id) },
    },
    include: ["channelMap"],
  });

  for (const row of existing) {
    const channelMap = row.get("channelMap");
    if (!channelMap) {
      await row.destroy();
      continue;
    }
    const server = grytClient.serverFor(channelMap);
    if (!server?.ready) continue;

    const own = row.get("grytSentVia") === "bot";
    if (!server.can(own ? "delete_own_messages" : "manage_messages")) continue;

    try {
      await server.deleteMessage(channelMap.grytChannelId, row.get("grytMessageId"));
    } catch (e) {
      if (!isGrytUnknownMessageError(e)) continue;
    }
    await row.destroy();
  }
}

/**
 * Pins do not cross.
 *
 * Gryt has no pinned messages — there is no event to listen for and no endpoint
 * to call — so a pin on Discord has nothing to become. Kept as a handler so the
 * wiring in index.js matches the other events, and so this is written down
 * somewhere other than a commit message.
 */
let pinNoticeShown = false;
export async function DiscordPinsUpdateHandler(channel) {
  if (pinNoticeShown) return;
  pinNoticeShown = true;
  log(
    "META",
    "Pins are not bridged: Gryt has no pinned messages. Nothing else about the bridge is affected.",
  );
}
