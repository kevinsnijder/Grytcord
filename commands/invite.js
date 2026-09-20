import { Op } from "sequelize";
import { ChannelMap } from "../db/index.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "invite",
  description: "Get an invite code from the other side",
  requireElevated: false,
  async run(params, message, discordClient, grytClient) {
    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          discordChannelId: message.channelId,
          grytChannelId: message.channelId,
          discordGuildId: message.guildId,
          grytGuildId: message.guildId,
        },
      },
    });

    if (!channelMap) {
      await replyTo(message, "This channel isn't part of a bridge.");
      return;
    }

    const data = channelMap.get();

    if (isGryt(message)) {
      let guild;
      try {
        guild = await discordClient.guilds.fetch(data.discordGuildId);
      } catch {
        guild = null;
      }
      if (!guild) {
        await replyTo(message, "Bridged Discord server not found.");
        return;
      }

      let link = "https://discord.gg/";
      if (guild.vanityURLCode) {
        link += guild.vanityURLCode;
      } else {
        const invite = await guild.invites.create(data.discordChannelId, {
          maxAge: 172800,
        });
        link += invite.code;
      }

      await replyTo(
        message,
        `Invite for **${guild.name}**${guild.vanityURLCode ? "" : " (valid for 2 days)"}: ${link}`,
      );
      return;
    }

    const server = grytClient.serverFor(data);
    if (!server?.ready) {
      await replyTo(message, "Not joined to that Gryt server (yet).");
      return;
    }

    if (!server.can("create_invite")) {
      await replyTo(
        message,
        "The bot is not allowed to create invites on that Gryt server.",
      );
      return;
    }

    const invite = await server.createInvite({ expiresInHours: 48 });
    if (!invite?.code) {
      await replyTo(message, "The Gryt server refused to create an invite.");
      return;
    }

    // Gryt is joined by address plus code rather than by following a link.
    await replyTo(
      message,
      `Invite for **${server.name}** (valid for 2 days):\nServer: \`${server.host}\`\nCode: \`${invite.code}\``,
    );
  },
};

export default command;
