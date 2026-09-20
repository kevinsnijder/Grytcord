import { ChannelMap, GuildMap } from "../db/index.js";
import { log } from "./Logger.js";
import { sendTo } from "./Compat.js";
import { checkBotPermissions, checkGrytPermissions } from "./CheckBotPerms.js";
import { resolveDiscordParentChannel } from "./DiscordThreadResolver.js";

/**
 * Making a bridge, in one place, because `setup`, `setupall` and `verify` all
 * do exactly this and drifting copies is how one of them ends up creating a
 * webhook the others do not.
 */

/** @param {"both" | "d2g" | "g2d"} direction */
export function toBridgeType(direction) {
  if (direction === "d2g") return "discord2gryt";
  if (direction === "g2d") return "gryt2discord";
  return "both";
}

/** @param {"both" | "d2g" | "g2d"} direction */
function arrow(direction) {
  return direction === "both" ? "<->" : direction === "d2g" ? "-->" : "<--";
}

/**
 * @param {{
 *   discordChannel: any,
 *   discordClient: import("discord.js").Client,
 *   grytServer: import("./GrytClient.js").GrytServerConnection,
 *   grytChannelId: string,
 *   direction: "both" | "d2g" | "g2d",
 * }} options
 * @returns {Promise<{ ok: boolean, error?: string, channelMap?: any }>}
 */
export async function createBridge(options) {
  const { discordChannel, discordClient, grytServer, grytChannelId, direction } =
    options;

  if (!grytServer?.ready) {
    return { ok: false, error: "Not joined to that Gryt server (yet)." };
  }
  if (!grytServer.channels.has(grytChannelId)) {
    return { ok: false, error: "That Gryt channel does not exist, or the bot cannot see it." };
  }
  if (!discordChannel) {
    return { ok: false, error: "Channel not found. Maybe invite the bot?" };
  }

  const existing = await ChannelMap.findOne({
    where: { discordChannelId: discordChannel.id },
  });
  if (existing) {
    return { ok: false, error: "That Discord channel is already bridged." };
  }
  const existingGryt = await ChannelMap.findOne({
    where: { grytChannelId },
  });
  if (existingGryt) {
    return { ok: false, error: "That Gryt channel is already bridged." };
  }

  // A thread cannot own a webhook; its parent does, and the thread is named on
  // every send instead.
  const webhookChannel = await resolveDiscordParentChannel(
    discordClient,
    discordChannel,
  );
  if (!webhookChannel) {
    return { ok: false, error: "Channel not found. Maybe invite the bot?" };
  }

  let discordWebhookId = "";
  let discordWebhookToken = "";
  let grytWebhookId = "";
  let grytWebhookToken = "";

  const grytChannel = grytServer.channels.get(grytChannelId);

  try {
    if (direction !== "d2g") {
      const webhook = await webhookChannel.createWebhook({
        name: `Grytcord Bridge (${discordChannel.id} (D) ${arrow(direction)} ${grytChannelId} (G))`,
      });
      discordWebhookId = webhook.id;
      discordWebhookToken = webhook.token ?? "";
    }
  } catch (e) {
    log("DISCORD", "Could not create the Discord bridge webhook", e);
    return {
      ok: false,
      error:
        "Could not create a webhook on the Discord side. Does the bot have Manage Webhooks there?",
    };
  }

  try {
    if (direction !== "g2d") {
      const webhook = await grytServer.createWebhook({
        channelId: grytChannelId,
        displayName: "Grytcord Bridge",
      });
      grytWebhookId = webhook?.webhook_id ?? "";
      grytWebhookToken = webhook?.token ?? "";
    }
  } catch (e) {
    log("GRYT", "Could not create the Gryt bridge webhook", e);
    // Roll back the Discord webhook rather than leaving half a bridge behind.
    if (discordWebhookId) {
      try {
        await discordClient.deleteWebhook(discordWebhookId, {
          token: discordWebhookToken,
        });
      } catch {}
    }
    return {
      ok: false,
      error:
        "Could not create a webhook on the Gryt side. Does the bot have Manage webhooks there?",
    };
  }

  const [grytGuildMap] = await GuildMap.findOrCreate({
    where: { guildId: grytServer.guildId, guildType: "gryt" },
  });
  const [discordGuildMap] = await GuildMap.findOrCreate({
    where: { guildId: discordChannel.guildId, guildType: "discord" },
  });

  const channelMap = await ChannelMap.create({
    discordGuildId: discordChannel.guildId,
    discordChannelId: discordChannel.id,
    discordWebhookId,
    discordWebhookToken,
    grytHost: grytServer.host,
    grytGuildId: grytServer.guildId,
    grytChannelId,
    grytWebhookId,
    grytWebhookToken,
    bridgeType: toBridgeType(direction),
    grytGuildMapId: grytGuildMap.get("id"),
    discordGuildMapId: discordGuildMap.get("id"),
  });

  log(
    "META",
    `Bridged #${discordChannel.name} (Discord) ${arrow(direction)} #${grytChannel?.name ?? grytChannelId} (${grytServer.host})`,
  );

  return { ok: true, channelMap };
}

/**
 * Say so in the channel that did not ask for it.
 *
 * Only on the Gryt side: a bridge being switched on should not put a message
 * into a Discord channel where everybody can see it.
 *
 * @param {{
 *   grytServer: import("./GrytClient.js").GrytServerConnection,
 *   grytChannelId: string,
 *   announceOnGryt: boolean,
 * }} options
 */
export async function announceBridge(options) {
  // The Discord half of this is deliberately missing, not forgotten.
  if (!options.announceOnGryt) return;

  const warnings = checkGrytPermissions(options.grytServer);
  const warningText =
    warnings.missingOptional.length > 0
      ? `\n> The bot is missing these optional permissions here: ${warnings.missingOptional.join(", ")}. Some things might not bridge properly.`
      : "";

  try {
    await sendTo(
      {
        platform: "gryt",
        server: options.grytServer,
        channelId: options.grytChannelId,
      },
      { content: `🎉 This channel is now bridged to Discord!${warningText}` },
    );
  } catch (e) {
    log("GRYT", "Could not post the bridge announcement", e);
  }
}

/**
 * The "you are missing X" line a setup command adds to its reply.
 *
 * @param {any} message
 */
export function optionalPermissionWarning(message) {
  const perms = checkBotPermissions(message);
  if (perms.missingOptional.length === 0) return "";
  return `\n\n> ⚠️ The bot is missing these optional permissions here: ${perms.missingOptional.join(", ")}. Some things might not bridge properly.`;
}
