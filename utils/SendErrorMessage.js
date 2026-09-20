import { GuildMap } from "../db/index.js";
import { log } from "./Logger.js";
import { genMsgLink } from "./GenMsgLink.js";
import { isGryt, sendTo } from "./Compat.js";
import { isBridgeHealthDegraded, recordBridgeFailure } from "./BridgeHealth.js";

/**
 * A message that did not make it across says so where it was written, with a
 * reaction, and in the server's error channel when one is set.
 *
 * The reaction stops once a bridge has failed enough times in a row: a bridge
 * that is down should not also spend its life reacting to every message.
 *
 * @param {any} message
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 * @param {any} error
 */
export async function sendErrorMessage(
  message,
  discordClient,
  grytClient,
  error,
) {
  const guildId = message?.guildId ?? "";
  recordBridgeFailure(guildId);
  const suppressReaction = isBridgeHealthDegraded(guildId);

  const guildMap = await GuildMap.findOne({ where: { guildId } });

  try {
    const channelId = guildMap?.get("errorLoggingChannelId");
    const platform = guildMap?.get("errorLoggingPlatform");

    if (channelId && platform) {
      const card = {
        title: "Error occurred while bridging a message",
        color: 0xef4444,
        fields: [
          {
            name: "Message",
            value: `${message?.author?.displayName ?? message?.author?.username ?? "?"} (${await genMsgLink(
              message,
            ).catch(() => "?")}): ${message?.content ?? ""}`.slice(0, 1024),
            inline: false,
          },
          {
            name: "Stack trace",
            value: `${error}`.slice(0, 1024),
            inline: false,
          },
        ],
      };

      if (platform === "gryt") {
        const resolved = grytClient.resolveChannel(channelId);
        if (resolved) {
          await sendTo(
            { platform: "gryt", server: resolved.server, channelId },
            { embeds: [card] },
          );
        }
      } else {
        const channel = await discordClient.channels.fetch(channelId);
        await sendTo({ platform: "discord", channel }, { embeds: [card] });
      }
    }

    if (!suppressReaction) {
      const reaction = guildMap?.get("errorReaction") ?? "⛓️‍💥";
      if (reaction) await message.react(reaction);
    }
  } catch {
    // Reporting the failure must never become a second failure.
  }

  log(
    isGryt(message) ? "GRYT" : "DISCORD",
    `An error occurred on ${await genMsgLink(message).catch(() => "?")}`,
    error,
  );
}
