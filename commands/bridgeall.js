import { ChannelType } from "discord.js";
import Config from "../utils/ConfigHandler.js";
import changeBotBio from "../utils/ChangeBotBio.js";
import { checkBotPermissions } from "../utils/CheckBotPerms.js";
import {
  announceBridge,
  createBridge,
  findMatchingChannel,
  toDirection,
} from "../utils/BridgeSetup.js";
import { confirmQuietly, isGryt, replyTo } from "../utils/Compat.js";
import { log } from "../utils/Logger.js";

/**
 * `setupall` without the handshake: pair every channel whose name matches, from
 * one side, in one command. Needs AutoVerifyBridges, because nobody on the
 * other end is being asked.
 *
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "bridgeall",
  description:
    "Bridge every channel whose name matches on both sides, without asking the other side",
  requireElevated: true,
  params: "[host|discordGuildId] [both|discord2gryt|gryt2discord]",
  additionalInfo: `Needs AutoVerifyBridges in the config.

Run it on Discord and the only argument you may need is the Gryt host, and only when more than one is configured. Run it on Gryt and it wants the Discord server's ID.

Nothing is posted in the Discord channels. Run \`${"gc!"}bridgelist\` to see what it made.`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);

    if (!Config.AutoVerifyBridges) {
      await replyTo(
        message,
        `\`${Config.BotPrefix}bridgeall\` needs \`AutoVerifyBridges: true\` in config.js. Without it, use \`${Config.BotPrefix}setupall\`, which asks the other side first.`,
      );
      return;
    }

    const botPerms = checkBotPermissions(message);
    if (!botPerms.hasAllCritical) {
      await replyTo(
        message,
        `Grytcord doesn't have these critical permissions here: ${botPerms.missingCritical.join(", ")}\nPlease add those permissions to the bot first before using this command.`,
      );
      return;
    }

    const direction = toDirection(params[1]);

    // ── Which two servers ─────────────────────────────────────────
    let grytServer;
    let discordGuildId;

    if (fromGryt) {
      grytServer = message.server;
      discordGuildId = params[0];
      if (!discordGuildId) {
        await replyTo(
          message,
          `Which Discord server? Usage: \`${Config.BotPrefix}bridgeall <discordGuildId>\``,
        );
        return;
      }
    } else {
      discordGuildId = message.guildId;
      const servers = [...grytClient.servers.values()].filter((x) => x.ready);

      if (params[0]) {
        grytServer = grytClient.server(params[0]);
      } else if (servers.length === 1) {
        grytServer = servers[0];
      } else if (servers.length === 0) {
        await replyTo(message, "Not joined to any Gryt server yet.");
        return;
      } else {
        await replyTo(
          message,
          `More than one Gryt server is configured. Say which: \`${Config.BotPrefix}bridgeall <host>\`\nKnown: ${servers.map((x) => x.host).join(", ")}`,
        );
        return;
      }
    }

    if (!grytServer?.ready) {
      await replyTo(message, "Not joined to that Gryt server (yet).");
      return;
    }

    let discordGuild;
    try {
      discordGuild = await discordClient.guilds.fetch(discordGuildId);
    } catch {
      discordGuild = null;
    }
    if (!discordGuild) {
      await replyTo(message, "Discord server not found. Maybe invite the bot?");
      return;
    }

    // ── Pair them up ──────────────────────────────────────────────
    const grytChannels = [...grytServer.channels.values()];
    const discordChannels = [...(await discordGuild.channels.fetch()).values()].filter(
      (x) => x?.type === ChannelType.GuildText,
    );

    let success = 0;
    /** @type {string[]} */
    const skipped = [];

    for (const discordChannel of discordChannels) {
      const match = findMatchingChannel(grytChannels, discordChannel);
      if (!match) continue;

      const result = await createBridge({
        discordChannel,
        discordClient,
        grytServer,
        grytChannelId: match.id,
        direction,
      });

      if (result.ok) {
        success++;
        await announceBridge({
          grytServer,
          grytChannelId: match.id,
          announceOnGryt: !fromGryt,
        });
      } else {
        skipped.push(`#${discordChannel.name}: ${result.error}`);
      }
    }

    if (skipped.length > 0) {
      log("META", `bridgeall skipped ${skipped.length}:\n${skipped.join("\n")}`);
    }

    const summary =
      `🎉 Bridged ${success} channel${success === 1 ? "" : "s"} between ${discordGuild.name} and ${grytServer.name}.` +
      (skipped.length > 0
        ? ` ${skipped.length} skipped — see the log, or run \`${Config.BotPrefix}bridgelist\`.`
        : "");

    // Quiet on Discord: a ✅ on the command rather than a message in the channel.
    await confirmQuietly(message, summary);

    await changeBotBio(discordGuild);
  },
};

export default command;
