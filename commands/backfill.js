import { Op } from "sequelize";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { GrytCreateMessageHandler } from "../utils/GrytHandler.js";
import { DiscordCreateMessageHandler } from "../utils/DiscordHandler.js";
import { editSent, isGryt, replyTo } from "../utils/Compat.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "backfill",
  description: "Bridge existing messages in a channel",
  requireElevated: true,
  params: "[numOfMessages=25]",
  additionalInfo: `numOfMessages = message count starting from the last message sent

Limited to 100 messages: both APIs stop there.`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);
    const wanted = Math.min(
      Math.max(Number.parseInt(params[0] || "25", 10) || 25, 1),
      100,
    );

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          discordChannelId: message.channelId,
          grytChannelId: message.channelId,
        },
      },
    });

    if (!channelMap) {
      await replyTo(
        message,
        `This channel is not bridged. Run \`${Config.BotPrefix}setup\` first, then run backfill again.`,
      );
      return;
    }

    /** @type {any[]} */
    let messages = [];
    if (fromGryt) {
      messages = await message.server.fetchMessages(message.channelId, wanted);
    } else {
      const fetched = await message.channel.messages.fetch({ limit: wanted });
      messages = [...fetched.values()];
    }

    const ids = messages.map((x) => x.id);
    const alreadyBridged = await MessageMap.findAll({
      where: {
        [Op.or]: {
          discordMessageId: { [Op.in]: ids },
          grytMessageId: { [Op.in]: ids },
        },
      },
    });

    const seen = new Set(
      alreadyBridged.flatMap((row) => [
        row.get("discordMessageId"),
        row.get("grytMessageId"),
      ]),
    );

    const pending = messages.filter((msg) => !seen.has(msg.id)).reverse();

    const status = await replyTo(
      message,
      `Getting ${pending.length} messages and trying to bridge them...`,
    );

    let success = 0;
    for (const [index, msg] of pending.entries()) {
      await editSent(status, {
        content: `Backfilling ${msg.id}... (${index + 1}/${pending.length}, ${success} successful)`,
      });

      try {
        if (fromGryt) {
          await GrytCreateMessageHandler(msg, grytClient, discordClient);
        } else {
          await DiscordCreateMessageHandler(msg, discordClient, grytClient, true);
        }
        success++;
      } catch {
        // One message that will not cross should not end the run.
      }

      await sleep(500);
    }

    await editSent(status, {
      content: `🎉 Successfully backfilled ${success} message${success === 1 ? "" : "s"} to ${fromGryt ? "Discord" : "Gryt"}!`,
    });
  },
};

export default command;
