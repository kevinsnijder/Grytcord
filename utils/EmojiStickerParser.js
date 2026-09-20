import { log } from "./Logger.js";
import {
  getGrytEmojis,
  getDiscordEmojis,
  getBotEmojis,
  clearGrytEmojiCache,
  clearBotEmojiCache,
} from "./EmojiCache.js";

/**
 * Custom emoji, both ways.
 *
 * Discord writes `<:name:id>` and keeps the image on its CDN; Gryt writes
 * `:name:` and keeps one library per server. So the crossing is by name, and
 * when the name is not there yet the image is uploaded — into the Gryt server's
 * library one way, into the bot's application emojis the other.
 */

const DISCORD_EMOJI_PATTERN = /<(a?):([\w-]+):(\d+)>/g;
const GRYT_EMOJI_PATTERN = /:([A-Za-z0-9_]{2,32}):/g;

/**
 * @param {string} id
 * @param {boolean} animated
 */
function discordEmojiUrl(id, animated) {
  return `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".webp"}`;
}

/**
 * Gryt's naming rules: 2–32 characters, letters, digits and underscores only.
 *
 * @param {string} name
 */
function toGrytEmojiName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
  return cleaned.length >= 2 ? cleaned : `e_${cleaned}`.slice(0, 32);
}

/**
 * Discord's custom emoji, rewritten for Gryt.
 *
 * @param {string | null} content
 * @param {import("./GrytClient.js").GrytServerConnection | null} server
 */
export async function parseDiscordEmojiToGryt(content, server) {
  if (!content) return content ?? "";
  if (!server) return content.replace(DISCORD_EMOJI_PATTERN, ":$2:");

  const matches = [...content.matchAll(DISCORD_EMOJI_PATTERN)];
  if (matches.length === 0) return content;

  let existing = await getGrytEmojis(server);
  let result = content;

  for (const [raw, animatedFlag, name, id] of matches) {
    const wanted = toGrytEmojiName(name);
    let found = existing.find((x) => x.name.toLowerCase() === wanted.toLowerCase());

    if (!found && server.can("manage_emojis")) {
      try {
        const res = await fetch(discordEmojiUrl(id, animatedFlag === "a"));
        if (res.ok) {
          const data = Buffer.from(await res.arrayBuffer());
          await server.createEmoji({
            data,
            name: wanted,
            contentType: animatedFlag === "a" ? "image/gif" : "image/webp",
          });
          clearGrytEmojiCache(server.host);
          existing = await getGrytEmojis(server);
          found = existing.find(
            (x) => x.name.toLowerCase() === wanted.toLowerCase(),
          );
        }
      } catch (e) {
        log("GRYT", `Could not mirror Discord emoji ${name} to ${server.host}`, e);
      }
    }

    // Falling back to `:name:` is not nothing: if that name turns up in the
    // server's library later, old messages start drawing it.
    result = result.replaceAll(raw, `:${found?.name ?? wanted}:`);
  }

  return result;
}

/**
 * Gryt's custom emoji, rewritten for Discord.
 *
 * @param {string | null} content
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytServerConnection | null} server
 * @param {string | null} targetDiscordGuildId
 */
export async function parseGrytEmojiToDiscord(
  content,
  discordClient,
  server,
  targetDiscordGuildId,
) {
  if (!content || !server) return content ?? "";

  const matches = [...content.matchAll(GRYT_EMOJI_PATTERN)];
  if (matches.length === 0) return content;

  const library = await getGrytEmojis(server);
  if (library.length === 0) return content;

  /** @type {Array<{ name: string, id: string, animated: boolean }>} */
  let guildEmojis = [];
  if (targetDiscordGuildId) {
    try {
      guildEmojis = await getDiscordEmojis(targetDiscordGuildId, discordClient);
    } catch {
      guildEmojis = [];
    }
  }

  let appEmojis = await getBotEmojis(discordClient);
  let result = content;
  const handled = new Set();

  for (const [raw, name] of matches) {
    if (handled.has(name)) continue;
    handled.add(name);

    const source = library.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!source) continue;

    const inGuild = guildEmojis.find(
      (x) => x.name.toLowerCase() === name.toLowerCase(),
    );
    if (inGuild) {
      result = result.replaceAll(
        raw,
        `<${inGuild.animated ? "a" : ""}:${inGuild.name}:${inGuild.id}>`,
      );
      continue;
    }

    let mirrored = [...appEmojis.values()].find(
      (x) => x.name.toLowerCase() === name.toLowerCase(),
    );

    if (!mirrored) {
      try {
        const res = await fetch(server.emojiUrl(source.name));
        if (res.ok) {
          const data = Buffer.from(await res.arrayBuffer());
          let created;
          try {
            created = await discordClient.application?.emojis.create({
              attachment: data,
              name: source.name,
            });
          } catch (e) {
            // Almost always the application's emoji slots being full. Make
            // room by dropping the oldest mirrored ones and try once more.
            await evictOldestAppEmojis(discordClient);
            created = await discordClient.application?.emojis.create({
              attachment: data,
              name: source.name,
            });
          }
          clearBotEmojiCache();
          appEmojis = await getBotEmojis(discordClient);
          if (created) {
            mirrored = {
              name: created.name ?? source.name,
              id: created.id,
              animated: Boolean(created.animated),
            };
          }
        }
      } catch (e) {
        log("DISCORD", `Could not mirror Gryt emoji ${name} to Discord`, e);
      }
    }

    if (mirrored) {
      result = result.replaceAll(
        raw,
        `<${mirrored.animated ? "a" : ""}:${mirrored.name}:${mirrored.id}>`,
      );
    }
  }

  return result;
}

/**
 * Drop the 25 oldest mirrored application emojis.
 *
 * Grytcord's own furniture (`reply_l`, `reply_r`) is left alone: those are
 * drawn on every bridged reply and are not worth re-uploading.
 *
 * @param {import("discord.js").Client} discordClient
 */
async function evictOldestAppEmojis(discordClient) {
  try {
    const emojis = await discordClient.application?.emojis.fetch();
    if (!emojis) return;

    const evictable = [...emojis.values()].filter(
      (x) => !String(x.name ?? "").startsWith("reply"),
    );

    let removed = 0;
    for (const emoji of evictable) {
      if (removed >= 25) break;
      try {
        await emoji.delete();
        removed++;
      } catch {}
    }

    log("DISCORD", `Made room for new emojis by deleting ${removed} old ones.`);
    clearBotEmojiCache();
  } catch (e) {
    log("DISCORD", "Could not free up application emoji slots", e);
  }
}

/**
 * The reaction form of the same crossing: one emoji, not a message full of them.
 *
 * @param {{ id?: string | null, name?: string | null, animated?: boolean }} emoji
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @returns {Promise<string | null>} what to send as Gryt's `reactionSrc`
 */
export async function discordReactionToGryt(emoji, server) {
  if (!emoji) return null;
  // A unicode emoji crosses unchanged, which is most reactions.
  if (!emoji.id) return emoji.name ?? null;

  const wanted = toGrytEmojiName(emoji.name ?? "");
  const library = await getGrytEmojis(server);
  const found = library.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
  return found ? `:${found.name}:` : null;
}

/**
 * @param {string} reactionSrc
 * @param {import("discord.js").Client} discordClient
 * @param {import("./GrytClient.js").GrytServerConnection} server
 * @param {string | null} targetDiscordGuildId
 * @returns {Promise<string | null>} what to send as Discord's reaction emoji
 */
export async function grytReactionToDiscord(
  reactionSrc,
  discordClient,
  server,
  targetDiscordGuildId,
) {
  if (!reactionSrc) return null;

  const custom = /^:([A-Za-z0-9_]{2,32}):$/.exec(reactionSrc);
  if (!custom) return reactionSrc;

  const rendered = await parseGrytEmojiToDiscord(
    reactionSrc,
    discordClient,
    server,
    targetDiscordGuildId,
  );
  const parsed = /<(a?):([\w-]+):(\d+)>/.exec(rendered);
  // discord.js wants `name:id` when reacting with a custom emoji.
  return parsed ? `${parsed[2]}:${parsed[3]}` : null;
}

/**
 * @param {string} str
 * @returns {string}
 */
export function removeLinkEmbeds(str) {
  const regex =
    /(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(\([-a-zA-Z0-9@:%_+.~#?&/=]*\)|[-a-zA-Z0-9@:%_+.~#?&/=])*)/g;
  return str.replace(regex, "<$1>");
}

/**
 * @param {string} str
 * @returns {string}
 */
export function sanitizeLinks(str) {
  return str.replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      return `*${new URL(url).hostname}*`;
    } catch {
      return url;
    }
  });
}
