//@ts-check
import {
  Client as DiscordClient,
  Events as DiscordEvents,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { Op } from "sequelize";
import Config from "./utils/ConfigHandler.js";
import { ChannelMap, GuildMap, MessageMap } from "./db/index.js";
import { GrytClient } from "./utils/GrytClient.js";
import {
  DiscordBulkDeleteMessageHandler,
  DiscordCreateMessageHandler,
  DiscordDeleteMessageHandler,
  DiscordPinsUpdateHandler,
  DiscordUpdateMessageHandler,
} from "./utils/DiscordHandler.js";
import {
  GrytCreateMessageHandler,
  GrytDeleteMessageHandler,
  GrytPurgeUserHandler,
  GrytUpdateMessageHandler,
} from "./utils/GrytHandler.js";
import { announceLogging, log, logError } from "./utils/Logger.js";
import { sendErrorMessage } from "./utils/SendErrorMessage.js";
import { discordAuthLink, grytJoinHint, renderBox } from "./utils/GenAuthLink.js";
import { setupReactionHandling } from "./utils/ReactionHandler.js";
import { setupHealthcheck } from "./utils/HealthCheck.js";
import { ensureBotEmojis } from "./utils/BotEmojiSetup.js";
import { buildDiscordUserAgentSuffix } from "./utils/UserAgent.js";
import { setPresenceUpdater } from "./utils/Presence.js";

const discordClient = new DiscordClient({
  rest: {
    timeout: 30_000,
    userAgentAppendix: buildDiscordUserAgentSuffix(),
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

export const botStartingTime = new Date();

const grytClient = new GrytClient();

/**
 * @param {{ discordChannelId?: string, grytChannelId?: string, discordGuildId?: string }} where
 */
async function destroyChannelMaps(where) {
  const channelMaps = await ChannelMap.findAll({ where, attributes: ["id"] });
  if (channelMaps.length > 0) {
    await MessageMap.destroy({
      where: { channelMapId: channelMaps.map((c) => c.get("id")) },
    });
  }
  await ChannelMap.destroy({ where });
}

/** @param {any} channelMap */
async function isTypingEnabled(channelMap) {
  const guildMaps = await GuildMap.findAll({
    where: {
      [Op.or]: [
        { guildId: channelMap.get("discordGuildId"), guildType: "discord" },
        { guildId: channelMap.get("grytGuildId"), guildType: "gryt" },
      ],
    },
  });
  return !guildMaps.some((g) => g.get("typingEnabled") === false);
}

// ── Discord ───────────────────────────────────────────────────────

discordClient.on(DiscordEvents.GuildDelete, async (guild) => {
  if (!guild.available) return;
  try {
    await destroyChannelMaps({ discordGuildId: guild.id });
    await GuildMap.destroy({ where: { guildId: guild.id } });
  } catch (e) {
    log("DB", `GuildDelete cleanup failed for guild ${guild.id}`, e);
  }
});

discordClient.on(DiscordEvents.ChannelDelete, async (chnl) => {
  try {
    await destroyChannelMaps({ discordChannelId: chnl.id });
  } catch (e) {
    log("DB", `ChannelDelete cleanup failed for discord channel ${chnl.id}`, e);
  }
});

discordClient.on(DiscordEvents.ThreadDelete, async (thread) => {
  try {
    await destroyChannelMaps({ discordChannelId: thread.id });
  } catch (e) {
    log("DB", `ThreadDelete cleanup failed for discord thread ${thread.id}`, e);
  }
});

discordClient.on(DiscordEvents.TypingStart, async (typing) => {
  if (typing.user.id === discordClient.user?.id) return;

  try {
    const channelMap = await ChannelMap.findOne({
      where: { discordChannelId: typing.channel.id },
    });
    if (!channelMap || !(await isTypingEnabled(channelMap))) return;

    const server = grytClient.serverFor(channelMap.get());
    if (!server?.ready) return;
    server.sendTyping(channelMap.get("grytChannelId"));
  } catch (e) {
    log("DISCORD", "Failed to relay typing indicator:", e);
  }
});

discordClient.on(DiscordEvents.MessageCreate, async (msg) => {
  if (msg.author.id === discordClient.user?.id) return;
  try {
    await DiscordCreateMessageHandler(msg, discordClient, grytClient);
  } catch (e) {
    await sendErrorMessage(msg, discordClient, grytClient, e);
  }
});

discordClient.on(DiscordEvents.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    await DiscordUpdateMessageHandler(oldMsg, newMsg, discordClient, grytClient);
  } catch (e) {
    await sendErrorMessage(newMsg, discordClient, grytClient, e);
  }
});

discordClient.on(DiscordEvents.MessageDelete, async (msg) => {
  try {
    await DiscordDeleteMessageHandler(msg, grytClient);
  } catch (e) {
    logError("GRYT", `Relaying the delete of Discord message ${msg.id} failed.`, e);
  }
});

discordClient.on(DiscordEvents.MessageBulkDelete, async (msgs) => {
  try {
    await DiscordBulkDeleteMessageHandler(msgs, grytClient);
  } catch (e) {
    logError("GRYT", `Relaying a Discord bulk delete of ${msgs.size} messages failed.`, e);
  }
});

discordClient.on(DiscordEvents.ChannelPinsUpdate, async (channel) => {
  try {
    await DiscordPinsUpdateHandler(channel);
  } catch (e) {
    logError("GRYT", `Handling a pin change in Discord channel ${channel.id} failed.`, e);
  }
});

// ── Gryt ──────────────────────────────────────────────────────────

grytClient.on("messageCreate", async (message) => {
  try {
    await GrytCreateMessageHandler(message, grytClient, discordClient);
  } catch (e) {
    await sendErrorMessage(message, discordClient, grytClient, e);
  }
});

grytClient.on("messageUpdate", async (message) => {
  try {
    await GrytUpdateMessageHandler(message, discordClient);
  } catch (e) {
    logError("DISCORD", `Relaying the edit of Gryt message ${message.id} failed.`, e);
  }
});

grytClient.on("messageDelete", async (event) => {
  try {
    await GrytDeleteMessageHandler(event, discordClient);
  } catch (e) {
    logError("DISCORD", `Relaying the delete of Gryt message ${event.messageId} failed.`, e);
  }
});

grytClient.on("purgeUser", async (event) => {
  try {
    await GrytPurgeUserHandler(event, discordClient);
  } catch (e) {
    logError("DISCORD", "Relaying a Gryt user purge failed.", e);
  }
});

grytClient.on("typingStart", async (event) => {
  if (event.serverUserId === event.server.serverUserId) return;

  try {
    const channelMap = await ChannelMap.findOne({
      where: { grytChannelId: event.channelId },
    });
    if (!channelMap || !(await isTypingEnabled(channelMap))) return;

    const channel = await discordClient.channels.fetch(
      channelMap.get("discordChannelId"),
    );
    if (channel && channel.isSendable()) await channel.sendTyping();
  } catch (e) {
    log("GRYT", "Failed to relay typing indicator:", e);
  }
});

grytClient.on("ready", () => {
  updatePresence();
  if (discordReady) onStartupComplete();
});

// A Gryt activity line lives on the connection, so a reconnect starts blank.
grytClient.on("rejoined", () => updatePresence());

grytClient.on("channels", (server) => {
  log("DEBUG", `${server.host}: ${server.channels.size} channels visible`);
});

// ── Startup ───────────────────────────────────────────────────────

let discordReady = false;
let firstReadyDone = false;

/**
 * Read from the database rather than counted once at startup, because the
 * number changes every time somebody bridges or unbridges something.
 * `refreshPresence()` is what those commands call.
 */
async function updatePresence() {
  try {
    const count = await ChannelMap.count();
    const text = `${Config.BotPrefix}help | bridging ${count} channel${count === 1 ? "" : "s"}`;
    discordClient.user?.setActivity(text);
    for (const server of grytClient.servers.values()) server.setActivity(text);
  } catch (e) {
    // Not worth stopping for — but a presence line stuck at zero is a symptom
    // of something else, and silence is how it stayed a mystery last time.
    logError("META", "Could not update the presence line.", e);
  }
}

/**
 * Runs once Discord is up, whether or not a Gryt server has let the bot in yet:
 * waiting at the door is the ordinary first run, and that is exactly when
 * somebody needs to be told where to go and approve it.
 */
async function onStartupComplete() {
  if (firstReadyDone) return;
  firstReadyDone = true;

  try {
    await ensureBotEmojis(discordClient);
  } catch (e) {
    log("META", "Reply emoji setup failed, replies will use a plain arrow.", e);
  }

  if (Config.Motds && Config.Motds.length > 0) {
    setInterval(() => motdLoop(), 10 * 60 * 1000);
    motdLoop();
  }

  renderBox([
    "Grytcord is up.",
    "",
    "Invite the Discord bot:",
    discordAuthLink(Config.DiscordClientId),
    "",
    ...[...grytClient.servers.values()].map((server) =>
      server.ready
        ? `Gryt: joined ${server.name} (${server.host})`
        : `Gryt: ${grytJoinHint(server.host)}`,
    ),
  ]);
}

discordClient.on(DiscordEvents.ClientReady, async () => {
  log("DISCORD", `${discordClient.user?.tag} is ready!`);
  discordReady = true;
  await updatePresence();
  onStartupComplete();
});

/** @param {unknown} error */
function isRecoverableRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;

  if (message.includes("Used disallowed intents")) {
    renderBox([
      "Message Content Intent not enabled!",
      "On the Discord Developer Portal, open the bot you created,",
      'then the Bot section, then enable "Message Content Intent".',
      "",
      "Grytcord will shut down rather than run half-blind.",
    ]);
    process.exit(0);
  }

  return [
    "WebSocket error",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "Connect Timeout Error",
    "Rate limited",
    "Missing Permissions",
    "Missing Access",
    "does not have",
    "_RateLimitError",
  ].some((needle) => message.includes(needle));
}

process.on("uncaughtException", (error) => {
  log("META", "A uncaught exception occurred.", error);

  if (isRecoverableRuntimeError(error)) {
    log("META", "Ignoring recoverable runtime error and keeping the process alive.");
    return;
  }

  try {
    discordClient.destroy();
  } catch {}
  try {
    grytClient.destroy().catch(() => {});
  } catch {}

  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("META", "A unhandled rejection occurred.", reason);

  if (isRecoverableRuntimeError(reason)) {
    log(
      "META",
      "Ignoring recoverable runtime rejection and keeping the process alive.",
    );
    return;
  }

  try {
    discordClient.destroy();
  } catch {}
  try {
    grytClient.destroy().catch(() => {});
  } catch {}

  process.exit(1);
});

function motdLoop() {
  /** @type {{ text: string, emoji?: string }[]} */
  const motds = Config.Motds;
  const motd = motds[Math.floor(Math.random() * motds.length)];
  if (!motd) return;

  const text = `${motd.emoji ? `${motd.emoji} ` : ""}${Config.BotPrefix}help | ${motd.text}`;
  discordClient.user?.setActivity(text);
  for (const server of grytClient.servers.values()) server.setActivity(text);
}

announceLogging();

setPresenceUpdater(updatePresence);
setupReactionHandling(discordClient, grytClient);
setupHealthcheck(discordClient, grytClient);

discordClient.login(Config.DiscordBotToken);
await grytClient.login();

export { discordClient, grytClient };
