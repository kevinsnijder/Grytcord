import { Op } from "sequelize";
import { ChannelMap, MessageMap } from "../db/index.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import { replyTo } from "../utils/Compat.js";
import { log } from "../utils/Logger.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "unbridge",
  description: "Unbridge the current channel",
  requireElevated: true,
  async run(params, message, discordClient, grytClient) {
    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: [
          { grytChannelId: message.channelId },
          { discordChannelId: message.channelId },
        ],
      },
    });

    if (!channelMap) {
      if (BridgeMap.has(message.channelId)) {
        BridgeMap.delete(message.channelId);
        await replyTo(message, "Cancelled bridging request.");
        return;
      }

      await replyTo(message, "This channel is already unbridged.");
      return;
    }

    const discordWebhookId = channelMap.get("discordWebhookId");
    if (discordWebhookId) {
      try {
        await discordClient.deleteWebhook(discordWebhookId, {
          token: channelMap.get("discordWebhookToken"),
        });
      } catch (e) {
        log("DISCORD", "Could not delete the Discord bridge webhook", e);
      }
    }

    const grytWebhookId = channelMap.get("grytWebhookId");
    if (grytWebhookId) {
      const server = grytClient.serverFor(channelMap.get());
      try {
        await server?.deleteWebhook(grytWebhookId);
      } catch (e) {
        log("GRYT", "Could not delete the Gryt bridge webhook", e);
      }
    }

    await MessageMap.destroy({ where: { channelMapId: channelMap.get("id") } });
    await channelMap.destroy();

    await replyTo(message, "Successfully unbridged!");
  },
};

export default command;
