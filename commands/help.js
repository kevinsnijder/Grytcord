import Config from "../utils/ConfigHandler.js";
import { getCommands } from "../utils/CommandHandler.js";
import { getGuildPrefix } from "../utils/GetGuildPrefix.js";
import { checkManageServerPerms } from "../utils/CheckManageServerPerms.js";
import { replyTo } from "../utils/Compat.js";

/**
 * @param {string} cmd
 * @param {string[] | undefined} aliases
 * @param {string[] | undefined} grp
 * @param {string} prefix
 */
function genAliases(cmd, aliases, grp, prefix) {
  const cmds = [];
  if (grp && grp.length > 0) {
    grp.forEach((x) => {
      cmds.push("`" + prefix + x + " " + cmd + "`");
      if (aliases && aliases.length > 0) {
        aliases.forEach((y) => cmds.push("`" + prefix + x + " " + y + "`"));
      }
    });
  } else if (aliases && aliases.length > 0) {
    aliases.forEach((x) => cmds.push("`" + prefix + x + "`"));
  }
  return cmds.join(", ");
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "help",
  aliases: ["?"],
  description: "Help for Grytcord's functions",
  requireElevated: false,
  params: "[...command]",
  async run(params, message, discordClient) {
    const prefix = await getGuildPrefix(message.guildId ?? "");

    if (params[0]) {
      const found = (await getCommands()).find(
        (x) =>
          x.name === params[0] ||
          x.aliases?.includes(params[0]) ||
          (x.groupNames?.includes(params[0]) &&
            (x.name === params[1] || x.aliases?.includes(params[1]))),
      );

      if (found && !found.hideFromHelp) {
        const aliases = genAliases(
          found.name,
          found.aliases,
          found.groupNames,
          prefix,
        );
        await replyTo(message, {
          embeds: [
            {
              title: `${prefix}${found.groupNames ? found.groupNames[0] + " " : ""}${found.name}${found.params ? " " + found.params : ""}`,
              description:
                (aliases ? `Aliases: ${aliases}\n` : "") +
                found.description +
                (found.additionalInfo ? `\n\n${found.additionalInfo}` : ""),
              ...(Config.EmbedFooterContent
                ? { footer: { text: Config.EmbedFooterContent } }
                : {}),
            },
          ],
        });
      } else {
        await replyTo(message, `Cannot find command \`${params[0]}\`!`);
      }
      return;
    }

    const isBotAdmin = Config.AdminAccountIds.includes(message.author.id);
    const isServerAdmin = await checkManageServerPerms(message, discordClient);

    let cmds = (await getCommands()).filter((x) => !x.hideFromHelp);
    if (!isBotAdmin) cmds = cmds.filter((x) => !x.requireOwner);
    if (!isServerAdmin) cmds = cmds.filter((x) => !x.requireElevated);

    await replyTo(message, {
      embeds: [
        {
          title: "Grytcord",
          description:
            "Grytcord bridges a Discord channel and a Gryt channel.\n\n" +
            `Prefix is \`${prefix}\`. Configuring bridging needs Manage Server on Discord, or an admin role on Gryt.`,
          fields: cmds.map((x) => ({
            name: `${prefix}${x.groupNames ? x.groupNames[0] + " " : ""}${x.name}${x.params ? " " + x.params : ""}`,
            value: x.description,
            inline: true,
          })),
          ...(Config.EmbedFooterContent
            ? { footer: { text: Config.EmbedFooterContent } }
            : {}),
        },
      ],
    });
  },
};

export default command;
