import Config from "../utils/ConfigHandler.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };
import getCommitHash from "../utils/GetCommitHash.js";
import ForkDetails from "../utils/Fork.js";
import { replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "about",
  description: "About Grytcord",
  requireElevated: false,
  async run(params, message) {
    const channels = await ChannelMap.count();

    const title = ForkDetails.isFork
      ? `${ForkDetails.forkName} ${ForkDetails.forkVersion}`
      : `Grytcord ${Package.version}`;

    await replyTo(message, {
      embeds: [
        {
          title,
          color: 0x5865f2,
          description:
            "Grytcord is a set-and-forget Discord <-> Gryt bridge." +
            (ForkDetails.isFork && ForkDetails.forkDescription
              ? `\n${ForkDetails.forkDescription}`
              : "") +
            `\n\nCurrently bridging ${channels} channel${channels === 1 ? "" : "s"}.`,
          footer: {
            text:
              `Commit ${getCommitHash()}` +
              (ForkDetails.isFork
                ? `, based on Grytcord ${Package.version}`
                : "") +
              (Config.EmbedFooterContent
                ? ` - ${Config.EmbedFooterContent}`
                : ""),
          },
        },
      ],
    });
  },
};

export default command;
