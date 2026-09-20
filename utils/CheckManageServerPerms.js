import { PermissionFlagsBits } from "discord.js";
import Config from "./ConfigHandler.js";
import { isGryt } from "./Compat.js";

/**
 * Whether the person who typed the command may configure bridging here.
 *
 * On Discord that is Manage Server. Gryt does not tell a bot what another
 * member may do, so it is the member's role against `GrytElevatedRoles` —
 * which is why that setting exists.
 *
 * @param {any} message
 * @param {import("discord.js").Client} discordClient
 */
export async function checkManageServerPerms(message, discordClient) {
  if (Config.AdminAccountIds.includes(message.author?.id)) return true;

  if (isGryt(message)) {
    const member = message.server.member(message.author.id);
    if (!member) return false;
    const roles = [member.role, ...(member.roles ?? [])]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    const elevated = (Config.GrytElevatedRoles ?? []).map((x) =>
      String(x).toLowerCase(),
    );
    return roles.some((role) => elevated.includes(role));
  }

  if (!message.guildId) return false;

  let guild;
  try {
    guild = await discordClient.guilds.fetch(message.guildId);
  } catch {
    return false;
  }

  let member;
  try {
    member = await guild.members.fetch(message.author.id);
  } catch {
    return false;
  }

  return member?.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

/**
 * Whether this person's @everyone should be allowed to survive the crossing.
 *
 * @param {any} message
 * @param {import("discord.js").Client} discordClient
 */
export async function checkPingPerms(message, discordClient) {
  if (!message?.author?.id) return false;
  if (Config.AdminAccountIds.includes(message.author.id)) return true;

  if (isGryt(message)) {
    // Same reasoning as above: a bot cannot read another member's permissions,
    // so an elevated role is the closest honest answer.
    return checkManageServerPerms(message, discordClient);
  }

  if (!message.guildId) return false;

  let guild;
  try {
    guild = await discordClient.guilds.fetch(message.guildId);
  } catch {
    return false;
  }

  let member;
  try {
    member = await guild.members.fetch(message.author.id);
  } catch {
    return false;
  }

  return member?.permissions?.has(PermissionFlagsBits.MentionEveryone) ?? false;
}

/**
 * The same question for a Discord user id that did not come from a message.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {import("discord.js").Client} discordClient
 */
export async function discordUserCanPing(guildId, userId, discordClient) {
  if (!guildId || !userId) return false;
  if (Config.AdminAccountIds.includes(userId)) return true;

  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.permissions.has(PermissionFlagsBits.MentionEveryone);
  } catch {
    return false;
  }
}
