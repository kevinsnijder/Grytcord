import { isGryt } from "./Compat.js";

/**
 * What the bot needs on Discord before a bridge will actually work.
 *
 * Webhooks carry the Gryt author's name and picture into Discord, so
 * ManageWebhooks is not optional; ManageMessages is how a delete on Gryt takes
 * the Discord copy with it.
 */
const DISCORD_CRITICAL = [
  "ViewChannel",
  "SendMessages",
  "ManageMessages",
  "ManageWebhooks",
  "EmbedLinks",
  "AttachFiles",
  "ReadMessageHistory",
  "AddReactions",
];

const DISCORD_OPTIONAL = [
  "MentionEveryone",
  "UseExternalEmojis",
  "UseExternalStickers",
  "CreatePublicThreads",
  "SendMessagesInThreads",
];

/**
 * The Gryt half. `manage_webhooks` is what `setup` needs to create the
 * per-channel webhook; without it the bridge still works, but every message
 * arrives under the bot's own name instead of the Discord author's.
 */
const GRYT_CRITICAL = ["read_messages", "send_messages", "manage_webhooks"];

const GRYT_OPTIONAL = [
  "attach_files",
  "add_reactions",
  "manage_messages",
  "edit_own_messages",
  "delete_own_messages",
  "create_invite",
];

/**
 * @param {any} message
 * @returns {{ missingGuildCritical: string[], missingCritical: string[], missingOptional: string[], hasAllCritical: boolean }}
 */
export function checkBotPermissions(message) {
  if (isGryt(message)) return checkGrytPermissions(message.server);

  const botMember = message.guild?.members?.me;
  const channel = message.channel;
  if (!botMember || !channel) {
    return {
      missingGuildCritical: [],
      missingCritical: [],
      missingOptional: [],
      hasAllCritical: true,
    };
  }

  const perms = channel.permissionsFor(botMember);
  if (!perms) {
    return {
      missingGuildCritical: [],
      missingCritical: [],
      missingOptional: [],
      hasAllCritical: true,
    };
  }

  const missingCritical = perms.missing(DISCORD_CRITICAL);
  const missingOptional = perms.missing(DISCORD_OPTIONAL);

  return {
    missingGuildCritical: [],
    missingCritical,
    missingOptional,
    hasAllCritical: missingCritical.length === 0,
  };
}

/**
 * @param {import("./GrytClient.js").GrytServerConnection | null} server
 */
export function checkGrytPermissions(server) {
  if (!server?.ready) {
    return {
      missingGuildCritical: [],
      missingCritical: [],
      missingOptional: [],
      hasAllCritical: true,
    };
  }

  const missingCritical = GRYT_CRITICAL.filter((x) => !server.can(x));
  const missingOptional = GRYT_OPTIONAL.filter((x) => !server.can(x));

  return {
    missingGuildCritical: [],
    missingCritical,
    missingOptional,
    hasAllCritical: missingCritical.length === 0,
  };
}
