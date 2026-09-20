import { GuildMap } from "../db/index.js";
import { isGryt, replyTo } from "../utils/Compat.js";
import { getGrytEmojis } from "../utils/EmojiCache.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s"],
  name: "seterrorreaction",
  description: "Set bot error emoji reaction, do not specify any to disable",
  aliases: ["setreact", "setemoji", "se"],
  params: "<emoji>",
  requireElevated: true,
  async run(params, message) {
    const wanted = params[0];

    // A custom emoji has to exist where the bot will try to use it, or every
    // failed bridge turns into a second failure.
    if (wanted && isGryt(message)) {
      const custom = /^:([A-Za-z0-9_]{2,32}):$/.exec(wanted);
      if (custom) {
        const library = await getGrytEmojis(message.server);
        if (!library.find((x) => x.name.toLowerCase() === custom[1].toLowerCase())) {
          await replyTo(message, "That emoji is not in this server's library.");
          return;
        }
      }
    } else if (wanted?.startsWith("<")) {
      const id = wanted.replace(/[<>]/g, "").split(":")[2];
      try {
        await message.guild.emojis.fetch(id);
      } catch {
        await replyTo(message, "Specified custom emoji should be on this server.");
        return;
      }
    }

    const [guildMap] = await GuildMap.findOrCreate({
      where: { guildId: message.guildId },
      defaults: { guildType: isGryt(message) ? "gryt" : "discord" },
    });

    guildMap.set("errorReaction", wanted ?? null);
    await guildMap.save();

    if (wanted) {
      await replyTo(message, `Successfully set ${wanted} as error reaction!`);
    } else {
      await replyTo(message, "Successfully disabled error reaction!");
    }
  },
};

export default command;
