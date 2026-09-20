import Config from "./ConfigHandler.js";
import { ChannelMap } from "../db/index.js";
import { log } from "./Logger.js";

/**
 * Keep the bot's per-server Discord bio saying what it is doing here.
 *
 * Gryt has no equivalent: a member's profile there is a nickname and a picture,
 * so there is nothing to write this on.
 *
 * @param {import("discord.js").Guild} guild
 */
export default async function changeBotBio(guild) {
  if (!guild) return;

  try {
    const count = await ChannelMap.count({
      where: { discordGuildId: guild.id },
    });

    await guild.members.editMe({
      bio:
        (Config.DiscordBioStart ? Config.DiscordBioStart + "\n\n" : "") +
        `Currently bridging ${count} channel${count === 1 ? "" : "s"} of this server to Gryt`,
    });
  } catch (e) {
    log("DISCORD", `Could not update the bot's bio on ${guild.id}`, e);
  }
}
