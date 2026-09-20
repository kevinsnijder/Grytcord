import { Op } from "sequelize";
import Config from "../utils/ConfigHandler.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import { ChannelMap } from "../db/index.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import { isGryt, replyTo, sendTo } from "../utils/Compat.js";

/** @param {string} value */
function toDirection(value) {
  const lowered = String(value ?? "both").toLowerCase();
  if (lowered.startsWith("g")) return "g2d";
  if (lowered.startsWith("d")) return "d2g";
  return "both";
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "bridge",
  description: "Bridge a channel",
  requireElevated: true,
  params: "<channelId> <both|discord2gryt|gryt2discord>",
  additionalInfo: `The channelId parameter takes a channel ID of the other end's channel (e.g. if you're running it on Gryt, it needs a Discord channel ID).

Known limits:
- Gryt has no pinned messages, so pins do not bridge
- A message posted through a Gryt webhook cannot be edited afterwards, so edits of those do not bridge
- Messages with files are posted by the bot itself on Gryt, so they show the author's name in the text rather than as the sender`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);
    const channelId = params[0];
    const typeDef = params[1];

    const botPerms = checkBotPermissions(message);
    if (!botPerms.hasAllCritical) {
      await replyTo(
        message,
        `Grytcord doesn't have these critical permissions here: ${botPerms.missingCritical.join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    if (!channelId || !typeDef) {
      await replyTo(
        message,
        `Missing parameters. Usage:\n\`\`\`\n${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]\n\`\`\``,
      );
      return;
    }

    const direction = toDirection(typeDef);

    // The other side's channel, whichever side that is.
    let targetIsDiscord = fromGryt;
    let targetChannel = null;
    let targetServer = null;

    if (targetIsDiscord) {
      try {
        targetChannel = await discordClient.channels.fetch(channelId);
      } catch {
        targetChannel = null;
      }
      if (!targetChannel?.isTextBased?.() || targetChannel.isDMBased?.()) {
        await replyTo(
          message,
          "Channel type is not a text-based channel or is a DM.",
        );
        return;
      }
    } else {
      const resolved = grytClient.resolveChannel(channelId);
      if (!resolved) {
        await replyTo(message, "Channel not found. Is the bot approved there?");
        return;
      }
      targetServer = resolved.server;
      targetChannel = resolved.channel;
      if ((targetChannel?.type ?? "text") !== "text") {
        await replyTo(message, "That Gryt channel is not a text channel.");
        return;
      }
    }

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: [
          { grytChannelId: channelId },
          { discordChannelId: channelId },
          { grytChannelId: message.channelId },
          { discordChannelId: message.channelId },
        ],
      },
    });

    if (channelMap || BridgeMap.has(channelId)) {
      await replyTo(
        message,
        `This channel is already bridged. Run \`${Config.BotPrefix}unbridge\` to unbridge, then configure it again.`,
      );
      return;
    }

    BridgeMap.set(channelId, {
      discordChannelId: fromGryt ? channelId : message.channelId,
      grytChannelId: fromGryt ? message.channelId : channelId,
      grytHost: fromGryt ? message.host : targetServer?.host,
      direction,
    });

    await replyTo(
      message,
      `Now, verify if you wanna bridge on the other end by using \`${Config.BotPrefix}verify\`! You have 2 minutes to do it or else it will expire.`,
    );

    // The request only goes out on Gryt. A Discord channel is not told that
    // somebody wants to bridge to it — you ask for it there with `verify`.
    if (!targetIsDiscord && targetServer) {
      await sendTo(
        { platform: "gryt", server: targetServer, channelId },
        {
          content:
            `Discord channel #${message.channel?.name ?? message.channelId} on ${message.guild?.name ?? "a server"} wants to bridge to this channel.\n\n` +
            `To approve the bridge, run \`${Config.BotPrefix}verify\`! If not, just ignore this message and it will be cancelled after 2 minutes.`,
        },
      );
    }
  },
};

export default command;
