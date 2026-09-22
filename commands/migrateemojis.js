import Config from "../utils/ConfigHandler.js";
import { clearGrytEmojiCache } from "../utils/EmojiCache.js";
import { discordEmojiUrl, toGrytEmojiName } from "../utils/EmojiStickerParser.js";
import { editSent, isGryt, replyTo } from "../utils/Compat.js";
import { log, logError } from "../utils/Logger.js";

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Copy every custom emoji of a Discord server into a Gryt server's library,
 * skipping names Gryt already has.
 *
 * Emojis Discord has locked because the server lost boost slots come along
 * too: `available` is false on them, but the image is still on the CDN, and
 * Gryt has no boost tiers to lock them behind.
 *
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "migrateemojis",
  aliases: ["emojimigrate", "copyemojis"],
  description: "Copy every Discord emoji that Gryt does not have yet into the Gryt server",
  requireElevated: true,
  params: "[host|discordGuildId]",
  additionalInfo: `Run it on Discord and the only argument you may need is the Gryt host, and only when more than one is configured. Run it on Gryt and it wants the Discord server's ID.

Emojis are matched by name, so one Gryt already has is left alone. Emojis Discord has locked for lack of boosts are copied as well.`,
  async run(params, message, discordClient, grytClient) {
    const fromGryt = isGryt(message);

    // ── Which two servers ─────────────────────────────────────────
    let grytServer;
    let discordGuildId;

    if (fromGryt) {
      grytServer = message.server;
      discordGuildId = params[0];
      if (!discordGuildId) {
        await replyTo(
          message,
          `Which Discord server? Usage: \`${Config.BotPrefix}migrateemojis <discordGuildId>\``,
        );
        return;
      }
    } else {
      discordGuildId = message.guildId;
      const servers = [...grytClient.servers.values()].filter((x) => x.ready);

      if (params[0]) {
        grytServer = grytClient.server(params[0]);
      } else if (servers.length === 1) {
        grytServer = servers[0];
      } else if (servers.length === 0) {
        await replyTo(message, "Not joined to any Gryt server yet.");
        return;
      } else {
        await replyTo(
          message,
          `More than one Gryt server is configured. Say which: \`${Config.BotPrefix}migrateemojis <host>\`\nKnown: ${servers.map((x) => x.host).join(", ")}`,
        );
        return;
      }
    }

    if (!grytServer?.ready) {
      await replyTo(message, "Not joined to that Gryt server (yet).");
      return;
    }

    // A Gryt bot holds at most what it asked for when it was first approved, so
    // giving its role more changes nothing. A bot registered before Grytcord
    // asked for manage_emojis has to be registered again.
    if (!grytServer.can("manage_emojis")) {
      await replyTo(
        message,
        `Grytcord cannot manage emojis on ${grytServer.name}. Giving its role the permission is not enough: a Gryt bot only ever holds what it asked for when it was first approved, and this registration did not ask for manage_emojis. Remove the bot in Server settings > Bots, restart Grytcord, and approve it again with the emoji permission ticked.`,
      );
      return;
    }

    let discordGuild;
    try {
      discordGuild = await discordClient.guilds.fetch(discordGuildId);
    } catch {
      discordGuild = null;
    }
    if (!discordGuild) {
      await replyTo(message, "Discord server not found. Maybe invite the bot?");
      return;
    }

    // ── What is missing ───────────────────────────────────────────
    // Fetched fresh rather than through EmojiCache: a stale list here means
    // uploading duplicates or skipping emojis that were just deleted.
    const discordEmojis = [...(await discordGuild.emojis.fetch()).values()];
    const grytEmojis = await grytServer.listEmojis();
    const taken = new Set(grytEmojis.map((x) => String(x.name).toLowerCase()));

    /** @type {{ id: string, name: string, grytName: string, animated: boolean, available: boolean }[]} */
    const pending = [];
    let alreadyThere = 0;
    for (const emoji of discordEmojis) {
      const grytName = toGrytEmojiName(emoji.name ?? "");
      const key = grytName.toLowerCase();
      if (taken.has(key)) {
        alreadyThere++;
        continue;
      }
      // Two Discord names can clean up to the same Gryt name; the first wins
      // and the second counts as already there.
      taken.add(key);
      pending.push({
        id: emoji.id,
        name: emoji.name ?? grytName,
        grytName,
        animated: Boolean(emoji.animated),
        available: emoji.available !== false,
      });
    }

    if (pending.length === 0) {
      await replyTo(
        message,
        `Nothing to do: all ${plural(discordEmojis.length, "emoji")} of ${discordGuild.name} already exist on ${grytServer.name}.`,
      );
      return;
    }

    const status = await replyTo(
      message,
      `Copying ${plural(pending.length, "emoji")} from ${discordGuild.name} to ${grytServer.name}...`,
    );

    // ── Copy them ─────────────────────────────────────────────────
    let created = 0;
    let locked = 0;
    /** @type {string[]} */
    const failed = [];

    for (const [index, emoji] of pending.entries()) {
      if (index % 5 === 0) {
        await editSent(status, {
          content: `Copying emojis... (${index + 1}/${pending.length}, ${created} copied)`,
        });
      }

      try {
        const res = await fetch(discordEmojiUrl(emoji.id, emoji.animated));
        if (!res.ok) throw new Error(`Discord CDN answered ${res.status}`);

        await grytServer.createEmoji({
          data: Buffer.from(await res.arrayBuffer()),
          name: emoji.grytName,
          contentType: emoji.animated ? "image/gif" : "image/webp",
        });

        created++;
        if (!emoji.available) locked++;
      } catch (e) {
        failed.push(emoji.name);
        logError(
          "GRYT",
          `Could not copy Discord emoji ${emoji.name} (${emoji.id}) to ${grytServer.host}`,
          e,
        );
      }

      await sleep(300);
    }

    clearGrytEmojiCache(grytServer.host);

    if (failed.length > 0) {
      log("GRYT", `migrateemojis could not copy: ${failed.join(", ")}`);
    }

    const summary =
      `🎉 Copied ${plural(created, "emoji")} from ${discordGuild.name} to ${grytServer.name}` +
      (locked > 0 ? ` (${locked} of them locked on Discord for lack of boosts)` : "") +
      "." +
      (alreadyThere > 0 ? ` ${alreadyThere} already existed.` : "") +
      (failed.length > 0
        ? `\n${plural(failed.length, "emoji")} failed: ${failed.map((x) => `\`${x}\``).join(", ")}`.slice(0, 1500)
        : "");

    await editSent(status, { content: summary });
  },
};

export default command;
