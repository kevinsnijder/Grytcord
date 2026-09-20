import { Op } from "sequelize";
import Config from "../utils/ConfigHandler.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import { ChannelMap } from "../db/index.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import {
  announceBridge,
  createBridge,
  optionalPermissionWarning,
  toDirection,
} from "../utils/BridgeSetup.js";
import { confirmQuietly, isGryt, replyTo, sendTo } from "../utils/Compat.js";
import changeBotBio from "../utils/ChangeBotBio.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "bridge",
  description: "Bridge a channel",
  requireElevated: true,
  params: "<channelId> [both|discord2gryt|gryt2discord]",
  additionalInfo: `The channelId parameter takes a channel ID of the other end's channel (e.g. if you're running it on Gryt, it needs a Discord channel ID).

With AutoVerifyBridges on in the config, this bridges straight away and nothing is posted in the Discord channel — the command gets a ✅ instead. With it off, the other side has to run \`verify\` within 2 minutes.

Known limits:
- Gryt has no pinned messages, so pins do not bridge
- A message posted through a Gryt webhook cannot be edited afterwards, so edits of those do not bridge
- Messages with files are posted by the bot itself on Gryt, so they show the author's name in the text rather than as the sender`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);
    const channelId = params[0];
    const direction = toDirection(params[1]);

    const botPerms = checkBotPermissions(message);
    if (!botPerms.hasAllCritical) {
      await replyTo(
        message,
        `Grytcord doesn't have these critical permissions here: ${botPerms.missingCritical.join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    if (!channelId) {
      await replyTo(
        message,
        `Missing parameters. Usage:\n\`\`\`\n${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]\n\`\`\``,
      );
      return;
    }

    // The other side's channel, whichever side that is.
    const targetIsDiscord = fromGryt;
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

    // ── One-sided: make it now ────────────────────────────────────
    if (Config.AutoVerifyBridges) {
      const discordChannelId = fromGryt ? channelId : message.channelId;
      const grytChannelId = fromGryt ? message.channelId : channelId;
      const grytServer = fromGryt ? message.server : targetServer;

      let discordChannel;
      try {
        discordChannel = await discordClient.channels.fetch(discordChannelId);
      } catch {
        discordChannel = null;
      }
      if (!discordChannel) {
        await replyTo(message, "Discord channel not found. Maybe invite the bot?");
        return;
      }

      const result = await createBridge({
        discordChannel,
        discordClient,
        grytServer,
        grytChannelId,
        direction,
      });

      // A failure still replies: one you cannot see is worse than a message
      // you did not want.
      if (!result.ok) {
        await replyTo(message, result.error ?? "Could not set the bridge up.");
        return;
      }

      await announceBridge({
        grytServer,
        grytChannelId,
        announceOnGryt: !fromGryt,
      });

      await confirmQuietly(
        message,
        `🎉 This channel is now bridged to ${fromGryt ? "Discord" : "Gryt"}!${optionalPermissionWarning(message)}`,
      );

      if (discordChannel.guild) await changeBotBio(discordChannel.guild);
      return;
    }

    // ── Two-sided: ask the other end ──────────────────────────────
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
