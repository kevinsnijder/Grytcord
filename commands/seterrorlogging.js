import Config from "../utils/ConfigHandler.js";
import { GuildMap } from "../db/index.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s"],
  name: "seterrorlogging",
  aliases: ["errlog", "err"],
  description: "Set error logging channel",
  requireElevated: true,
  params: "<channelId>",
  additionalInfo:
    "Takes a channel on the side you run it from (run it on Discord, give it a Discord channel ID).",
  async run(params, message, discordClient, grytClient) {
    if (!params[0]) {
      await replyTo(
        message,
        `Missing parameters. Usage: \`${Config.BotPrefix}guild seterrorlogging <channelId>\``,
      );
      return;
    }

    const guildMap = await GuildMap.findOne({
      where: { guildId: message.guildId },
    });

    if (!guildMap) {
      await replyTo(message, "This channel needs to be bridged first.");
      return;
    }

    const channelId = params[0];

    if (isGryt(message)) {
      const resolved = grytClient.resolveChannel(channelId);
      if (!resolved || resolved.server.host !== message.host) {
        await replyTo(message, "The bot cannot find this channel.");
        return;
      }
      guildMap.set("errorLoggingChannelId", channelId);
      guildMap.set("errorLoggingPlatform", "gryt");
    } else {
      let channel;
      try {
        channel = await discordClient.channels.fetch(channelId);
      } catch {
        channel = null;
      }

      if (!channel) {
        await replyTo(message, "The bot cannot find this channel.");
        return;
      }
      if (!channel.isSendable()) {
        await replyTo(message, "The bot cannot send messages on this channel.");
        return;
      }

      guildMap.set("errorLoggingChannelId", channel.id);
      guildMap.set("errorLoggingPlatform", "discord");
    }

    await guildMap.save();
    await replyTo(message, "Done!");
  },
};

export default command;
