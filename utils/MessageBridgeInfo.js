import { Op } from "sequelize";
import { MessageMap } from "../db/index.js";
import { genMsgLink } from "./GenMsgLink.js";
import { cardsToText, cardToDiscordEmbed } from "./EmbedConverter.js";
import { isGryt } from "./Compat.js";
import { log } from "./Logger.js";

/**
 * React with ℹ️ and the bot tells you, privately, where a bridged message
 * actually came from: which side wrote it, who wrote it, and where to find the
 * original.
 *
 * @param {any} message the message that was reacted to
 * @param {any} user the person who asked (a Discord user, or a Gryt reaction change)
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export async function sendBridgeInfo(message, user, discordClient, grytClient) {
  const messageMap = await MessageMap.findOne({
    where: {
      [Op.or]: {
        discordMessageId: message.id,
        grytMessageId: message.id,
      },
    },
    include: ["channelMap"],
  });
  if (!messageMap) return;

  const channelMap = messageMap.get("channelMap");
  if (!channelMap) return;

  const fromGryt = messageMap.get("messageSource") === "gryt";

  /** @type {any} */
  const card = {
    title: `Message ${message.id}`,
    color: 0x5865f2,
    fields: [],
  };

  if (fromGryt) {
    const server = grytClient.serverFor(channelMap);
    const original = server
      ? await server
          .fetchMessage(channelMap.grytChannelId, messageMap.get("grytMessageId"))
          .catch(() => null)
      : null;

    card.description = `Written on Gryt (${channelMap.grytHost}), in #${
      server?.channels.get(channelMap.grytChannelId)?.name ?? channelMap.grytChannelId
    }.`;
    card.fields.push({
      name: "Author",
      value: original
        ? `${original.author.username} (${original.senderId})`
        : messageMap.get("authorId"),
      inline: true,
    });
    card.fields.push({
      name: "Bridged copy",
      value: `https://discord.com/channels/${channelMap.discordGuildId}/${channelMap.discordChannelId}/${messageMap.get("discordMessageId")}`,
      inline: false,
    });
  } else {
    const original = await discordClient.channels
      .fetch(channelMap.discordChannelId)
      .then((channel) => channel?.messages?.fetch(messageMap.get("discordMessageId")))
      .catch(() => null);

    card.description = "Written on Discord.";
    card.fields.push({
      name: "Author",
      value: original
        ? `${original.author.tag} (${original.author.id})`
        : messageMap.get("authorId"),
      inline: true,
    });
    card.fields.push({
      name: "Original",
      value: `https://discord.com/channels/${channelMap.discordGuildId}/${channelMap.discordChannelId}/${messageMap.get("discordMessageId")}`,
      inline: false,
    });
    card.fields.push({
      name: "Posted on Gryt as",
      value: `${messageMap.get("grytSentVia") === "bot" ? "a bot message (carries files, can be edited)" : "a webhook message (keeps the author's name and picture)"}`,
      inline: false,
    });
  }

  try {
    if (isGryt(message)) {
      // The asker is a Gryt member: answer in a direct message, so the channel
      // stays as it was.
      const server = message.server;
      const conversationId = await server.openDm(user.serverUserId ?? user.id);
      if (!conversationId) return;
      await server.sendMessage(conversationId, {
        text: `${card.title}\n${card.description}\n\n${cardsToText([card])}`,
      });
    } else {
      const embed = cardToDiscordEmbed(card);
      embed?.setURL(await genMsgLink(message).catch(() => null));
      const dm = await user.createDM();
      await dm.send({ embeds: embed ? [embed] : [] });
    }
  } catch (e) {
    log("META", "Could not deliver bridge info", e);
  }
}
