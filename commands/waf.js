import { replyTo } from "../utils/Compat.js";

const waf = ["waf", "arf", "waff", "awaf"];

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "waf",
  description: ":3",
  requireElevated: false,
  hideFromHelp: true,
  async run(params, message) {
    await replyTo(message, waf[Math.floor(Math.random() * waf.length)]);
  },
};

export default command;
