import { replyTo } from "../utils/Compat.js";

const rawr = ["rawr"];

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "rawr",
  description: ":3",
  requireElevated: false,
  hideFromHelp: true,
  async run(params, message) {
    await replyTo(message, rawr[Math.floor(Math.random() * rawr.length)]);
  },
};

export default command;
