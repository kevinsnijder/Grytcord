import { ChannelType, PermissionsBitField } from "discord.js";
import { checkGrytPermissions } from "../utils/CheckBotPerms.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "probe",
  description: "Probe all channels",
  requireElevated: true,
  async run(params, message, discordClient, grytClient) {
    if (!message.guildId) {
      await replyTo(message, "This command can only be used in a server.");
      return;
    }

    const lines = [];

    if (isGryt(message)) {
      const server = message.server;
      const perms = checkGrytPermissions(server);

      lines.push(`Server: ${server.name} (${server.host})`);
      lines.push(`Role: ${server.info?.role || "member"}`);
      lines.push(`Permissions: ${server.permissions.join(", ") || "none"}`);
      if (perms.missingCritical.length > 0) {
        lines.push(`Missing (critical): ${perms.missingCritical.join(", ")}`);
      }
      if (perms.missingOptional.length > 0) {
        lines.push(`Missing (optional): ${perms.missingOptional.join(", ")}`);
      }
      lines.push("");
      lines.push("Channels:");

      // Gryt permissions are per-server rather than per-channel for a bot, so
      // a channel here is either visible or it is not.
      for (const channel of server.channels.values()) {
        lines.push(`#${channel.name} (${channel.id}) [${channel.type}]`);
      }
    } else {
      const guild = await discordClient.guilds.fetch(message.guildId);
      const me = await guild.members.fetchMe();
      const channels = await guild.channels.fetch();

      for (const channel of channels.values()) {
        if (
          channel?.type !== ChannelType.GuildText &&
          channel?.type !== ChannelType.GuildVoice
        )
          continue;
        const perms = me.permissionsIn(channel);
        lines.push(
          `#${channel.name} (${channel.id}): ${new PermissionsBitField(perms).toArray().join(", ")}`,
        );
      }
    }

    await replyTo(message, {
      files: [{ name: "probed.txt", data: Buffer.from(lines.join("\n")) }],
    });
  },
};

export default command;
