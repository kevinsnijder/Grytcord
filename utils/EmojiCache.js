import ExpiryMap from "expiry-map";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** @type {ExpiryMap<string, Array<{ name: string, file_id: string }>>} */
const grytEmojiCache = new ExpiryMap(CACHE_TTL);

/** @type {ExpiryMap<string, Array<{ name: string, id: string, animated: boolean }>>} */
const discordEmojiCache = new ExpiryMap(CACHE_TTL);

/** @type {ExpiryMap<string, Map<string, { name: string, id: string, animated: boolean }>>} */
const botEmojiCache = new ExpiryMap(CACHE_TTL);

/**
 * @param {import("./GrytClient.js").GrytServerConnection} server
 */
export async function getGrytEmojis(server) {
  const cached = grytEmojiCache.get(server.host);
  if (cached) return cached;

  const emojis = await server.listEmojis();
  const mapped = emojis.map((x) => ({ name: x.name, file_id: x.file_id }));
  grytEmojiCache.set(server.host, mapped);
  return mapped;
}

/**
 * @param {string} guildId
 * @param {import("discord.js").Client} discordClient
 */
export async function getDiscordEmojis(guildId, discordClient) {
  const cached = discordEmojiCache.get(guildId);
  if (cached) return cached;

  const guild = await discordClient.guilds.fetch(guildId);
  const emojis = await guild.emojis.fetch();
  const mapped = [
    ...emojis
      .map((x) => ({
        name: x.name ?? "",
        id: x.id,
        animated: Boolean(x.animated),
      }))
      .values(),
  ];
  discordEmojiCache.set(guildId, mapped);
  return mapped;
}

/**
 * The bot's own application emojis, which is where Gryt emojis end up so they
 * work in every Discord server the bridge touches.
 *
 * @param {import("discord.js").Client} discordClient
 */
export async function getBotEmojis(discordClient) {
  const cached = botEmojiCache.get("app");
  if (cached) return cached;

  const fetched = await discordClient.application?.emojis.fetch();
  /** @type {Map<string, { name: string, id: string, animated: boolean }>} */
  const mapped = new Map();
  fetched?.forEach((x) =>
    mapped.set(x.id, {
      name: x.name ?? "",
      id: x.id,
      animated: Boolean(x.animated),
    }),
  );
  botEmojiCache.set("app", mapped);
  return mapped;
}

/** @param {string} host */
export function clearGrytEmojiCache(host) {
  grytEmojiCache.delete(host);
}

/** @param {string} guildId */
export function clearDiscordEmojiCache(guildId) {
  discordEmojiCache.delete(guildId);
}

export function clearBotEmojiCache() {
  botEmojiCache.delete("app");
}
