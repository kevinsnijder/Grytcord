import { GuildMap } from "../db/index.js";
import Config from "./ConfigHandler.js";

/**
 * Resolves the effective command prefix for a server.
 * Returns the server's custom prefix when one is set,
 * otherwise falls back to the global prefix from the config.
 *
 * @param {string} guildId
 * @returns {Promise<string>}
 */
export async function getGuildPrefix(guildId) {
  if (!guildId) return Config.BotPrefix;

  const guildMap = await GuildMap.findOne({
    where: {
      guildId,
    },
  });

  return guildMap?.get("botPrefix") || Config.BotPrefix;
}
