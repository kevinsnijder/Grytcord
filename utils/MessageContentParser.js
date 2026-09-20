import { ButtonStyle, ComponentType, MessageMentions } from "discord.js";
import { ChannelMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * Gryt mentions are the member's nickname after an `@`, which the server
 * matches against the member list. The markdown link form is what a webhook
 * message needs — plain text in one of those notifies nobody — and it still
 * reads as a mention in an ordinary message, so everything uses it.
 *
 * @param {string} nickname
 * @param {string} serverUserId
 */
export function grytMention(nickname, serverUserId) {
  return `[@${nickname}](mention:${serverUserId})`;
}

/**
 * Find the Gryt member a Discord user most likely is: same display name, or
 * same username. Nothing links the two accounts, so a name is all there is.
 *
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {{ displayName?: string, globalName?: string | null, username: string }} user
 */
export function findGrytMemberForUser(server, user) {
  const candidates = [user.displayName, user.globalName, user.username]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());

  for (const member of server.members.values()) {
    if (candidates.includes(String(member.nickname ?? "").toLowerCase())) {
      return member;
    }
  }
  return null;
}

/**
 * A Discord message's mentions, rewritten for Gryt.
 *
 * @param {import("discord.js").Message} message
 * @param {string | null} content
 * @param {import("./GrytClient.js").GrytServerConnection | null} server
 */
export async function parseDiscordMentions(message, content, server) {
  let res = content ?? message.content ?? "";
  if (!res) return "";
  if (!(message.mentions instanceof MessageMentions)) return res;

  const bridgedChannels = await ChannelMap.findAll({
    where: {
      discordChannelId: {
        [Op.in]: message.mentions.channels.map((x) => x.id),
      },
    },
  });

  message.mentions.channels.forEach((channel) => {
    if (channel.isDMBased?.()) return;
    const bridged = bridgedChannels.find(
      (x) => channel.id === x.get("discordChannelId"),
    );
    const grytChannel = bridged
      ? server?.channels.get(bridged.get("grytChannelId"))
      : null;
    res = res.replaceAll(
      `<#${channel.id}>`,
      `#${grytChannel?.name ?? channel.name}`,
    );
  });

  message.mentions.users.forEach((user) => {
    const member = server ? findGrytMemberForUser(server, user) : null;
    const rendered = member
      ? grytMention(member.nickname, member.serverUserId)
      : `@${user.displayName ?? user.username}`;
    res = res.replaceAll(`<@${user.id}>`, rendered);
    res = res.replaceAll(`<@!${user.id}>`, rendered);
  });

  message.mentions.roles.forEach((role) => {
    res = res.replaceAll(`<@&${role.id}>`, `@${role.name}`);
  });

  // Anything still in snowflake form points at somebody nobody here can see.
  res = res.replace(/<@&\d+>/g, "@unknown-role");
  res = res.replace(/<@!?\d+>/g, "@unknown-user");

  return res;
}

/**
 * A Gryt message's channel references, rewritten for Discord. Member mentions
 * are handled by MentionResolver, which needs the Discord guild.
 *
 * @param {string} content
 * @param {import("./GrytClient.js").GrytServerConnection} server
 */
export async function parseGrytMentions(content, server) {
  let res = content ?? "";
  if (!res) return "";

  // `[@Name](mention:id)` is how Gryt writes a mention. Flatten it to `@Name`
  // so MentionResolver can try to find that person on the Discord side.
  res = res.replace(/\[@([^\]]+)\]\(mention:[^)]+\)/g, "@$1");

  const bridged = await ChannelMap.findAll({
    where: {
      grytChannelId: {
        [Op.in]: [...server.channels.keys()],
      },
    },
  });

  for (const channel of server.channels.values()) {
    const map = bridged.find((x) => x.get("grytChannelId") === channel.id);
    if (!map) continue;
    // Gryt has no channel-link syntax of its own, so this only catches a
    // channel named in a way Discord can link back to.
    res = res.replaceAll(`#${channel.name}`, `<#${map.get("discordChannelId")}>`);
  }

  return res;
}

/**
 * Whether a Discord message is itself a bridged or proxied message, and what it
 * was replying to. Lets Grytcord chain a reply back to the right message when
 * another bridge (or PluralKit, or Tupperbox) is in the room.
 *
 * @param {import("discord.js").Message} message
 */
export async function attemptParseBridgedMessage(message) {
  const defaultResponse = {
    isBridge: false,
    isProxy: false,
    messageData: { parsedContent: message.content ?? "" },
    excludeEmbed: false,
  };

  if (!message.webhookId) return defaultResponse;

  const content = message.content ?? "";

  const contentParsers = [
    {
      type: "grytcord",
      isBridge: true,
      isProxy: false,
      regex:
        /-# <:reply_l.*\(<https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)>\)\n?/,
    },
    {
      type: "ooye",
      isBridge: true,
      isProxy: false,
      regex:
        /-# > <:L1.*>https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+).*\n?/,
    },
    {
      type: "tupperbox",
      isBridge: false,
      isProxy: true,
      regex:
        /> \[Reply to\]\(<https:\/\/discord\.com\/channels\/((?:\d+|@me))\/(\d+)\/(\d+)>.+?\n>.*\n?/,
    },
  ];

  for (const parser of contentParsers) {
    const match = parser.regex.exec(content);
    if (match) {
      const [, guildId, channelId, messageId] = match;
      if (guildId && channelId && messageId) {
        return {
          isBridge: parser.isBridge,
          isProxy: parser.isProxy,
          type: parser.type,
          messageData: {
            guildId,
            channelId,
            messageId,
            parsedContent: content.replace(parser.regex, ""),
          },
          excludeEmbed: false,
        };
      }
    }
  }

  const pluralkitReplyRegex =
    /\*\*\[Reply to:\]\(https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

  if (Array.isArray(message.embeds)) {
    for (const [i, embed] of message.embeds.entries()) {
      if (!embed.description) continue;

      const match = pluralkitReplyRegex.exec(embed.description);
      if (match) {
        const [, guildId, channelId, messageId] = match;
        if (guildId && channelId && messageId) {
          return {
            isBridge: false,
            isProxy: true,
            type: "pluralkit",
            messageData: {
              guildId,
              channelId,
              messageId,
              parsedContent: content,
            },
            excludeEmbed: i,
          };
        }
      }
    }
  }

  const boltReplyRegex = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

  if (Array.isArray(message.components)) {
    for (const row of message.components) {
      const isActionRow =
        row.type === 1 ||
        row.type === "ActionRow" ||
        row.type === ComponentType?.ActionRow;
      if (!isActionRow || !row.components?.length) continue;

      const firstBtn = row.components[0];
      const isLinkButton =
        (firstBtn.type === 2 || firstBtn.type === "Button") &&
        (firstBtn.style === 5 || firstBtn.style === ButtonStyle?.Link);

      if (isLinkButton && firstBtn.url) {
        const match = boltReplyRegex.exec(firstBtn.url);
        if (match) {
          const [, guildId, channelId, messageId] = match;
          if (guildId && channelId && messageId) {
            return {
              isBridge: true,
              isProxy: false,
              type: "bolt",
              messageData: {
                guildId,
                channelId,
                messageId,
                parsedContent: content,
              },
              excludeEmbed: false,
            };
          }
        }
      }
    }
  }

  return defaultResponse;
}
