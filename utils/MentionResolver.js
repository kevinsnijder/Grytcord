/**
 * `@Name` on Gryt, turned into a real Discord mention when somebody by that
 * name is in the bridged guild.
 *
 * Nothing links a Gryt account to a Discord one, so this is a name lookup and
 * it is allowed to come up empty — in which case the text stays as it was and
 * simply reads as a name.
 */

/** @type {Map<string, { id: string, at: number }>} */
const nameCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheKey(guildId, name) {
  return `${guildId}:${name.toLowerCase()}`;
}

function trimCache() {
  if (nameCache.size <= 5000) return;
  const oldest = nameCache.keys().next().value;
  nameCache.delete(oldest);
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} name
 */
async function findMember(guild, name) {
  const key = cacheKey(guild.id, name);
  const cached = nameCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    try {
      return await guild.members.fetch(cached.id);
    } catch {
      nameCache.delete(key);
    }
  }

  let results;
  try {
    results = await guild.members.search({ query: name, limit: 5 });
  } catch {
    return null;
  }

  const wanted = name.toLowerCase();
  for (const member of results.values()) {
    const names = [member.displayName, member.user.globalName, member.user.username]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    if (names.includes(wanted)) {
      nameCache.set(key, { id: member.id, at: Date.now() });
      trimCache();
      return member;
    }
  }

  return null;
}

/**
 * @param {import("discord.js").Guild | null} guild
 * @param {string} content
 */
export async function resolveMentions(guild, content) {
  if (!guild || !content) return content;

  const mentionRegex = /(?<![\w<])@([A-Za-z0-9_.\- ]{2,32})/g;
  const skip = ["everyone", "here"];

  /** @type {Map<string, string>} */
  const wanted = new Map();
  for (const [, name] of content.matchAll(mentionRegex)) {
    const trimmed = name.trim();
    if (!trimmed || skip.includes(trimmed.toLowerCase())) continue;
    if (!wanted.has(trimmed.toLowerCase())) wanted.set(trimmed.toLowerCase(), trimmed);
  }
  if (wanted.size === 0) return content;

  /** @type {Map<string, string>} */
  const resolved = new Map();
  for (const [key, name] of wanted) {
    const member = await findMember(guild, name);
    if (member) resolved.set(key, member.id);
  }
  if (resolved.size === 0) return content;

  return content.replace(mentionRegex, (full, name) => {
    const trimmed = String(name).trim();
    if (skip.includes(trimmed.toLowerCase())) return full;
    const id = resolved.get(trimmed.toLowerCase());
    // The trailing whitespace the greedy name match may have eaten is put back.
    const tail = String(name).slice(trimmed.length);
    return id ? `<@${id}>${tail}` : full;
  });
}
