import { GuildMap } from "../db/index.js";
import { replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["dbg", "debug"],
  name: "react",
  aliases: ["r"],
  description: "Reaction debug",
  requireElevated: false,
  requireOwner: true,
  async run(params, message) {
    const guildMap = await GuildMap.findOne({
      where: { guildId: message.guildId },
    });

    const reaction = guildMap?.get("errorReaction") ?? "⛓️‍💥";
    if (reaction) await message.react(reaction);

    await replyTo(message, "done");
  },
};

export default command;
