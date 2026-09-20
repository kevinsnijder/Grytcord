import { Events as DiscordEvents, Routes as DiscordRoutes } from "discord.js";
import { MessageMap } from "../db/index.js";
import { log } from "./Logger.js";
import {
  discordReactionToGryt,
  grytReactionToDiscord,
} from "./EmojiStickerParser.js";
import { sendBridgeInfo } from "./MessageBridgeInfo.js";

/**
 * Reactions, both ways.
 *
 * Neither side can react *as* somebody else, so a reaction crossing is the
 * bot's own: several people reacting with the same emoji arrive as one. Gryt
 * goes one further and only offers a toggle, which is why GrytClient keeps
 * track of what it has already put on a message.
 */

const INFO_EMOJI = ["information_source", "ℹ️", "ℹ"];

/**
 * @param {import("discord.js").MessageReaction | import("discord.js").PartialMessageReaction} reaction
 * @param {import("discord.js").User | import("discord.js").PartialUser} user
 * @param {"add" | "remove"} action
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
async function relayDiscordReaction(reaction, user, action, grytClient) {
  if (user.bot) return;

  const messageMap = await MessageMap.findOne({
    where: { discordMessageId: reaction.message.id },
    include: ["channelMap"],
  });
  if (!messageMap) return;

  const channelMap = messageMap.get("channelMap");
  if (!channelMap || channelMap.bridgeType === "gryt2discord") return;

  const server = grytClient.serverFor(channelMap);
  if (!server?.ready || !server.can("add_reactions")) return;

  const src = await discordReactionToGryt(reaction.emoji, server);
  if (!src) return;

  await server.setReaction(
    channelMap.grytChannelId,
    messageMap.get("grytMessageId"),
    src,
    action === "add",
  );
}

/**
 * @param {{ src: string, action: "add" | "remove", serverUserId: string }} change
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {string} grytMessageId
 * @param {import("discord.js").Client} discordClient
 */
async function relayGrytReaction(change, server, grytMessageId, discordClient) {
  // Our own toggles came from Discord in the first place.
  if (change.serverUserId === server.serverUserId) return;

  const messageMap = await MessageMap.findOne({
    where: { grytMessageId },
    include: ["channelMap"],
  });
  if (!messageMap) return;

  const channelMap = messageMap.get("channelMap");
  if (!channelMap || channelMap.bridgeType === "discord2gryt") return;

  const emoji = await grytReactionToDiscord(
    change.src,
    discordClient,
    server,
    channelMap.discordGuildId,
  );
  if (!emoji) return;

  const route = `${DiscordRoutes.channelMessageReaction(
    channelMap.discordChannelId,
    messageMap.get("discordMessageId"),
    encodeURIComponent(emoji),
  )}/@me`;

  if (change.action === "add") {
    await discordClient.rest.put(route);
  } else {
    await discordClient.rest.delete(route);
  }
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export function setupReactionHandling(discordClient, grytClient) {
  discordClient.on(DiscordEvents.MessageReactionAdd, async (reaction, user) => {
    if (INFO_EMOJI.includes(reaction.emoji.name ?? "")) {
      try {
        await reaction.remove();
        await sendBridgeInfo(
          await reaction.message.fetch(),
          user,
          discordClient,
          grytClient,
        );
      } catch {}
      return;
    }

    relayDiscordReaction(reaction, user, "add", grytClient).catch((e) =>
      log("GRYT", `Discord→Gryt reaction relay failed: ${e}`),
    );
  });

  discordClient.on(DiscordEvents.MessageReactionRemove, (reaction, user) => {
    relayDiscordReaction(reaction, user, "remove", grytClient).catch((e) =>
      log("GRYT", `Discord→Gryt reaction remove relay failed: ${e}`),
    );
  });

  grytClient.on("reaction", async ({ server, message, changes }) => {
    for (const change of changes ?? []) {
      if (INFO_EMOJI.includes(change.src) && change.action === "add") {
        try {
          await sendBridgeInfo(message, change, discordClient, grytClient);
        } catch {}
        continue;
      }

      relayGrytReaction(change, server, message.id, discordClient).catch((e) =>
        log("DISCORD", `Gryt→Discord reaction relay failed: ${e}`),
      );
    }
  });
}
