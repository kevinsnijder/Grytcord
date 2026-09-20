import { GuildMap } from "../db/index.js";
import { isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "toggletyping",
  aliases: ["typing"],
  description: "Toggle typing indicator relaying",
  requireElevated: true,
  params: "[on|off]",
  async run(params, message) {
    if (!message.guildId) {
      await replyTo(message, "This command can only be used in a server.");
      return;
    }

    const [guildMap] = await GuildMap.findOrCreate({
      where: { guildId: message.guildId },
      defaults: { guildType: isGryt(message) ? "gryt" : "discord" },
    });

    const arg = params[0]?.toLowerCase();
    const current = guildMap.get("typingEnabled") !== false;

    let enabled;
    if (arg === "on") {
      enabled = true;
    } else if (arg === "off") {
      enabled = false;
    } else if (arg) {
      await replyTo(message, "Usage: `on` or `off`.");
      return;
    } else {
      enabled = !current;
    }

    if (enabled === current) {
      await replyTo(
        message,
        `Typing indicator relaying is already ${enabled ? "enabled" : "disabled"}.`,
      );
      return;
    }

    guildMap.set("typingEnabled", enabled);
    await guildMap.save();

    await replyTo(
      message,
      `Typing indicator relaying ${enabled ? "enabled" : "disabled"}.`,
    );
  },
};

export default command;
