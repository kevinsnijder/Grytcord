import { Op } from "sequelize";
import RandomString from "../utils/RandomString.js";
import { PendingSetup } from "../utils/CommandHandler.js";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap } from "../db/index.js";
import { discordAuthLink, grytJoinHint } from "../utils/GenAuthLink.js";
import changeBotBio from "../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import {
  announceBridge,
  createBridge,
  optionalPermissionWarning,
} from "../utils/BridgeSetup.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/** @param {string} value */
function toDirection(value) {
  const lowered = String(value ?? "both").toLowerCase();
  if (lowered.startsWith("g") || lowered === "gryt2discord") return "g2d";
  if (lowered.startsWith("d") || lowered === "discord2gryt") return "d2g";
  return "both";
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "setup",
  description: "Set up bridging",
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

    // ── Half one: hand out a code ─────────────────────────────────
    if (directionOrCode.length !== 6) {
      const channelMap = await ChannelMap.findOne({
        where: {
          [Op.or]: {
            discordChannelId: message.channelId,
            grytChannelId: message.channelId,
          },
        },
      });

      if (channelMap) {
        await replyTo(
          message,
          `This channel is already bridged. Run \`${Config.BotPrefix}unbridge\` to unbridge, then run setup again.`,
        );
        return;
      }

      const code = RandomString(6);

      PendingSetup.set(code, {
        guildId: message.guildId,
        channelId: message.channelId,
        host: fromGryt ? message.host : undefined,
        isGryt: fromGryt,
        direction: toDirection(directionOrCode),
      });

      const otherSideHint = fromGryt
        ? `Discord bot isn't there? [Invite it](${discordAuthLink(Config.DiscordClientId)})!`
        : `Gryt bot isn't there? ${grytJoinHint(
            Config.GrytServers?.[0]?.host ?? "your Gryt server",
          )}`;

      await replyTo(message, {
        embeds: [
          {
            title: "Set up Grytcord",
            description:
              `# \`${Config.BotPrefix}setup ${code}\`\n` +
              `Run that on the other side to finish setting up bridging! The code expires in 5 minutes.${optionalWarning}\n\n${otherSideHint}`,
            ...(Config.EmbedFooterContent
              ? { footer: { text: Config.EmbedFooterContent } }
              : {}),
          },
        ],
      });
      return;
    }

    // ── Half two: redeem one ──────────────────────────────────────
    const setup = PendingSetup.get(directionOrCode);
    if (!setup) {
      await replyTo(
        message,
        `Code can't be found or is expired already. Run \`${Config.BotPrefix}setup\` again on the other side.`,
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

    const discordChannelId = fromGryt ? setup.channelId : message.channelId;
    const grytChannelId = fromGryt ? message.channelId : setup.channelId;
    const grytHost = fromGryt ? message.host : setup.host;

    let discordChannel;
    try {
      discordChannel = await discordClient.channels.fetch(discordChannelId);
    } catch {
      discordChannel = null;
    }
    if (!discordChannel) {
      await replyTo(message, "Discord channel not found. Maybe invite the bot?");
      PendingSetup.delete(directionOrCode);
      return;
    }

    const grytServer = grytHost
      ? grytClient.server(grytHost)
      : grytClient.resolveChannel(grytChannelId)?.server;
    if (!grytServer) {
      await replyTo(message, "Gryt channel not found. Is the bot approved there?");
      PendingSetup.delete(directionOrCode);
      return;
    }

    const result = await createBridge({
      discordChannel,
      discordClient,
      grytServer,
      grytChannelId,
      direction: setup.direction,
    });

    PendingSetup.delete(directionOrCode);

    if (!result.ok) {
      await replyTo(message, result.error ?? "Could not set the bridge up.");
      return;
    }

    // Only the Gryt channel is told; a Discord channel is left alone on purpose.
    await announceBridge({
      grytServer,
      grytChannelId,
      announceOnGryt: !fromGryt,
    });

    await replyTo(
      message,
      `🎉 This channel is now bridged to ${fromGryt ? "Discord" : "Gryt"}!${optionalWarning}`,
    );

    if (discordChannel.guild) await changeBotBio(discordChannel.guild);
  },
};

export default command;
