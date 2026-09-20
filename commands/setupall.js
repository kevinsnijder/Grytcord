import RandomString from "../utils/RandomString.js";
import { PendingSetup } from "../utils/CommandHandler.js";
import Config from "../utils/ConfigHandler.js";
import changeBotBio from "../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import {
  announceBridge,
  createBridge,
  findMatchingChannel,
  optionalPermissionWarning,
  toDirection,
} from "../utils/BridgeSetup.js";
import { editSent, isGryt, replyTo } from "../utils/Compat.js";
import { ChannelType } from "discord.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "setupall",
  description: "Set up bridging for all channels",
  requireElevated: true,
  params: "[(code)|both|discord2gryt|gryt2discord|d2g|g2d=both]",
  additionalInfo: `(code) - the code of the setup to send to the other side
both|discord2gryt|gryt2discord|d2g|g2d - the direction of the bridge, defaults to both`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);
    const directionOrCode = params[0] ?? "both";

    const botPerms = checkBotPermissions(message);
    if (!botPerms.hasAllCritical) {
      await replyTo(
        message,
        `Grytcord doesn't have these critical permissions here: ${botPerms.missingCritical.join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    const optionalWarning = optionalPermissionWarning(message);

    if (directionOrCode.length !== 6) {
      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        host: fromGryt ? message.host : undefined,
        isGryt: fromGryt,
        direction: toDirection(directionOrCode),
      });

      await replyTo(message, {
        embeds: [
          {
            title: "Bridge all channels",
            description:
              `# \`${Config.BotPrefix}setupall ${code}\`\n` +
              `Run that on the other side to bridge every channel whose name matches. The code expires in 5 minutes.${optionalWarning}`,
            ...(Config.EmbedFooterContent
              ? { footer: { text: Config.EmbedFooterContent } }
              : {}),
          },
        ],
      });
      return;
    }

    const setup = PendingSetup.get(directionOrCode);
    if (!setup) {
      await replyTo(
        message,
        `Code can't be found or is expired already. Run \`${Config.BotPrefix}setupall\` again on the other side.`,
      );
      return;
    }

    if (setup.isGryt === fromGryt) {
      await replyTo(
        message,
        "We don't support Gryt <-> Gryt or Discord <-> Discord bridges.",
      );
      PendingSetup.delete(directionOrCode);
      return;
    }

    const discordGuildId = fromGryt ? setup.guildId : message.guildId;
    const grytHost = fromGryt ? message.host : setup.host;

    const grytServer = grytClient.server(grytHost ?? "");
    if (!grytServer?.ready) {
      await replyTo(message, "Not joined to that Gryt server (yet).");
      PendingSetup.delete(directionOrCode);
      return;
    }

    let discordGuild;
    try {
      discordGuild = await discordClient.guilds.fetch(discordGuildId);
    } catch {
      discordGuild = null;
    }
    if (!discordGuild) {
      await replyTo(message, "Server not found. Maybe invite the bot?");
      PendingSetup.delete(directionOrCode);
      return;
    }

    const status = await replyTo(
      message,
      "Getting all channels and trying to bridge them...",
    );

    const grytChannels = [...grytServer.channels.values()];
    const discordChannels = [
      ...(await discordGuild.channels.fetch()).values(),
    ].filter((x) => x?.type === ChannelType.GuildText);

    let success = 0;
    let failed = 0;

    for (const discordChannel of discordChannels) {
      const match = findMatchingChannel(grytChannels, discordChannel);
      if (!match) continue;

      const result = await createBridge({
        discordChannel,
        discordClient,
        grytServer,
        grytChannelId: match.id,
        direction: setup.direction,
      });

      if (result.ok) {
        success++;
        await announceBridge({
          grytServer,
          grytChannelId: match.id,
          announceOnGryt: !fromGryt,
        });
      } else {
        failed++;
      }

      await editSent(status, {
        content: `Bridging #${discordChannel.name}...\nSuccess: ${success}, Failed: ${failed}`,
      });
    }

    await editSent(status, {
      content: `🎉 Successfully bridged ${success} channel${success === 1 ? "" : "s"} to ${fromGryt ? "Discord" : "Gryt"}!${failed > 0 ? ` (${failed} could not be bridged)` : ""}${optionalWarning}`,
    });

    await changeBotBio(discordGuild);
    PendingSetup.delete(directionOrCode);
  },
};

export default command;
