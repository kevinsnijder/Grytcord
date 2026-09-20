import { Op } from "sequelize";
import { ChannelMap } from "../db/index.js";
import { replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "bridgelist",
  description: "List of bridged channels on this server",
  requireElevated: true,
  async run(params, message, discordClient, grytClient) {
    const bridges = await ChannelMap.findAll({
      where: {
        [Op.or]: {
          discordGuildId: message.guildId,
          grytGuildId: message.guildId,
        },
      },
    });

    if (bridges.length === 0) {
      await replyTo(message, "No channels are bridged here yet.");
      return;
    }

    const arrow = (type) =>
      type === "both" ? "<->" : type === "gryt2discord" ? "-->" : "<--";

    const lines = await Promise.all(
      bridges.map(async (row) => {
        const data = row.get();

        const server = grytClient.serverFor(data);
        const grytChannel = server?.channels.get(data.grytChannelId);

        let discordGuildName = "unknown";
        let discordChannelName = "unknown";
        try {
          const guild = await discordClient.guilds.fetch(data.discordGuildId);
          discordGuildName = guild.name;
          const channel = await discordClient.channels.fetch(
            data.discordChannelId,
          );
          discordChannelName = channel?.name ?? "unknown";
        } catch {}

        return (
          `${grytChannel?.name ?? "unknown"} (${data.grytChannelId}) on ${server?.name ?? data.grytHost} ` +
          `${arrow(data.bridgeType)} ` +
          `${discordChannelName} (${data.discordChannelId}) on ${discordGuildName} (${data.discordGuildId})`
        );
      }),
    );

    await replyTo(message, {
      files: [{ name: "channels.txt", data: Buffer.from(lines.join("\n")) }],
    });
  },
};

export default command;
