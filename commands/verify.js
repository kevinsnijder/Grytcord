import { BridgeMap } from "../utils/CommandHandler.js";
import changeBotBio from "../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import {
  announceBridge,
  createBridge,
  optionalPermissionWarning,
} from "../utils/BridgeSetup.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "verify",
  description: "Verify/approve a bridge",
  requireElevated: true,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);
    const pending = BridgeMap.get(message.channelId);

    const botPerms = checkBotPermissions(message);
    if (!botPerms.hasAllCritical) {
      await replyTo(
        message,
        `Grytcord doesn't have these critical permissions here: ${botPerms.missingCritical.join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    if (!pending) {
      await replyTo(
        message,
        "This channel isn't configured for bridging. Bridge this first before verifying.",
      );
      return;
    }

    let discordChannel;
    try {
      discordChannel = await discordClient.channels.fetch(
        pending.discordChannelId,
      );
    } catch {
      discordChannel = null;
    }
    if (!discordChannel) {
      await replyTo(message, "Discord channel not found. Maybe invite the bot?");
      return;
    }

    const grytServer = pending.grytHost
      ? grytClient.server(pending.grytHost)
      : grytClient.resolveChannel(pending.grytChannelId)?.server;
    if (!grytServer) {
      await replyTo(message, "Gryt channel not found. Is the bot approved there?");
      return;
    }

    const result = await createBridge({
      discordChannel,
      discordClient,
      grytServer,
      grytChannelId: pending.grytChannelId,
      direction: pending.direction,
    });

    BridgeMap.delete(message.channelId);

    if (!result.ok) {
      await replyTo(message, result.error ?? "Could not set the bridge up.");
      return;
    }

    // Same rule as `setup`: the Gryt side is told, the Discord side is not.
    await announceBridge({
      grytServer,
      grytChannelId: pending.grytChannelId,
      announceOnGryt: !fromGryt,
    });

    await replyTo(
      message,
      `🎉 This channel is now bridged to ${fromGryt ? "Discord" : "Gryt"}!${optionalPermissionWarning(message)}`,
    );

    if (discordChannel.guild) await changeBotBio(discordChannel.guild);
  },
};

export default command;
