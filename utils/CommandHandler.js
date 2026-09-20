import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExpiryMap from "expiry-map";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { checkManageServerPerms } from "./CheckManageServerPerms.js";
import { isGryt, replyTo } from "./Compat.js";

/** Bridge requests waiting for a `verify` on the other side. */
export let BridgeMap = new ExpiryMap(120000);

/**
 * Setup codes waiting to be typed on the other side.
 *
 * @type {ExpiryMap<string, {
 *  guildId: string,
 *  channelId: string,
 *  host?: string,
 *  isGryt: boolean,
 *  direction: "g2d" | "d2g" | "both"
 * }>}
 */
export let PendingSetup = new ExpiryMap(300000);

const COMMAND_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "commands",
);

/** @type {import('./CommandSchema.d.ts').CommandSchema[] | null} */
let commandCache = null;

/**
 * @returns {Promise<import('./CommandSchema.d.ts').CommandSchema[]>}
 */
export async function getCommands() {
  if (commandCache) return commandCache;

  const entries = fs
    .readdirSync(COMMAND_DIR)
    .filter((x) => x.endsWith(".js"));

  commandCache = await Promise.all(
    entries.map(async (x) => (await import(`../commands/${x}`)).default),
  );

  return commandCache.filter(Boolean);
}

/**
 * @param {any} message
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytClient} grytClient
 */
export async function CommandHandler(message, discordClient, grytClient) {
  if (message.author?.bot || message.webhookId) return;

  const cmdList = message.content.split(" ");
  const guildPrefix = await getGuildPrefix(message.guildId ?? "");
  const command = cmdList[0]?.startsWith(guildPrefix)
    ? cmdList[0].slice(guildPrefix.length)
    : cmdList[0]?.replace(Config.BotPrefix, "");
  const commands = await getCommands();
  let commandToRun = commands.find(
    (x) => x.name === command || x.aliases?.find((y) => y === command),
  );

  let isGrouped = false;

  if (!commandToRun) {
    const commandGroup = commands.filter((x) =>
      x.groupNames?.find((y) => y === command),
    );

    if (commandGroup.length > 0) {
      const grouped = cmdList[1];
      commandToRun = commands.find(
        (x) => x.name === grouped || x.aliases?.find((y) => y === grouped),
      );
      isGrouped = true;
    } else {
      await replyTo(message, {
        embeds: [
          {
            description: `Command \`${guildPrefix + command}\` does not exist!`,
            color: 0xef0000,
          },
        ],
      });
      return;
    }
  }

  const params = cmdList.slice(isGrouped ? 2 : 1);

  if (
    commandToRun?.requireElevated &&
    !(await checkManageServerPerms(message, discordClient))
  ) {
    await replyTo(
      message,
      `You need at least **Manage ${isGryt(message) ? "Server" : "Server"}** permissions to run this command!`,
    );
    return;
  }

  if (
    commandToRun?.requireOwner &&
    !Config.AdminAccountIds.find((x) => x === message.author.id)
  ) {
    await replyTo(message, "Only bot admins can execute this command!");
    return;
  }

  try {
    await commandToRun?.run(params, message, discordClient, grytClient);
  } catch (e) {
    log("META", `Command ${commandToRun?.name} failed`, e);
    try {
      await replyTo(message, {
        embeds: [
          {
            title: "A error has occurred while executing this command!",
            color: 0xef0000,
            fields: [{ name: "Stack trace", value: `${e}`.slice(0, 1024) }],
          },
        ],
      });
    } catch (replyError) {
      log("META", "Failed to reply with the command error:", replyError);
    }
  }
}
