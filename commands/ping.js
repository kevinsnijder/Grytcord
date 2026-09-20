import { Routes } from "discord.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { getDuration } from "../utils/GetDuration.js";
import { botStartingTime } from "../index.js";
import Config from "../utils/ConfigHandler.js";
import { editSent, isGryt, replyTo } from "../utils/Compat.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "ping",
  description: "...pong? (bot latency and stats)",
  aliases: ["stats", "uptime"],
  requireElevated: false,
  async run(params, message, discordClient, grytClient) {
    const now = new Date();

    const messageStart = Date.now();
    const sent = await replyTo(message, "Pinging...");
    const messageLatency = Date.now() - messageStart;

    const discordRestStart = Date.now();
    await discordClient.rest.get(Routes.currentApplication());
    const discordRestLatency = Date.now() - discordRestStart;

    const messagesBridged = await MessageMap.count();
    const channelsBridged = await ChannelMap.count();
    const discordGuildCount = discordClient.guilds.cache.size;
    const discordMemberCount = discordClient.guilds.cache.reduce(
      (acc, guild) => acc + guild.memberCount,
      0,
    );

    const grytServers = [...grytClient.servers.values()];
    const grytMemberCount = grytServers.reduce(
      (acc, server) => acc + server.members.size,
      0,
    );

    const heapMb =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;

    const discordPing =
      typeof discordClient.ws.ping === "number" && discordClient.ws.ping >= 0
        ? `${Math.round(discordClient.ws.ping)}ms`
        : "n/a";

    await editSent(sent, {
      content: "",
      embeds: [
        {
          title: "Pong!",
          description: `Bridging ${channelsBridged} channel${channelsBridged === 1 ? "" : "s"} (${messagesBridged} messages) for ${getDuration(botStartingTime, now)}`,
          fields: [
            {
              name: `${isGryt(message) ? "Gryt" : "Discord"} round-trip`,
              value: `${messageLatency}ms`,
              inline: true,
            },
            {
              name: "Discord REST",
              value: `${discordRestLatency}ms`,
              inline: true,
            },
            { name: "Discord gateway", value: discordPing, inline: true },
            { name: "Memory", value: `${heapMb} MB`, inline: true },
            {
              name: "Discord guilds",
              value: `${discordGuildCount}`,
              inline: true,
            },
            {
              name: "Gryt servers",
              value:
                grytServers
                  .map((x) => `${x.name} (${x.ready ? "online" : "offline"})`)
                  .join("\n") || "none",
              inline: true,
            },
            {
              name: "Discord members",
              value: `${discordMemberCount}`,
              inline: true,
            },
            { name: "Gryt members", value: `${grytMemberCount}`, inline: true },
          ],
          ...(Config.EmbedFooterContent
            ? { footer: { text: Config.EmbedFooterContent } }
            : {}),
        },
      ],
    });
  },
};

export default command;
