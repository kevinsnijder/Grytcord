import { replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["admin", "a"],
  name: "restart",
  aliases: ["r"],
  description: "Restart bot",
  requireElevated: false,
  requireOwner: true,
  async run(params, message) {
    await replyTo(message, "Restarting...");

    process.exit(67);
  },
};

export default command;
