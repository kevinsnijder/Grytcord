const Config = {
  // The Gryt servers this bot connects to.
  // `host` is the server's address ("chat.example.com" or "localhost:5001").
  // `botToken` is optional: it's a single-use claim token from a registration an
  // admin set up in advance. Without it, the bot knocks and waits for an admin to
  // approve it in Server settings > Bots (no restart needed, the approval is live).
  GrytServers: [
    {
      host: "chat.example.com",
      // botToken: "",
      // Only loopback is assumed to be plain http. A server on a LAN address
      // without TLS needs this, or both halves of the bot try https and fail.
      // secure: false,
    },
  ],

  // The name the bot shows up as in the Gryt member list.
  GrytNickname: "Grytcord",

  // One line shown to the admin who approves the bot.
  GrytDescription: "Bridges channels between Discord and this server.",

  // Where the bot's Gryt identity key lives. THE FILE IS THE BOT: keep it and the
  // bot keeps its id, name, role and history across restarts. Lose it and the
  // server sees a stranger knocking, holding nothing. In Docker that means a volume.
  GrytIdentityPath: "/data/gryt-bot-identity.json",

  // The path for the bot's data directory. Probably do not touch if you're using Docker.
  DataFolderPath: "/data",

  // The database encryption token. If you're just running a instance for yourself
  // you don't really need to set this.
  // NOTE: Only applies to SQLite. Ignored when PostgresConnectionString is set.
  DatabaseEncryptionToken: "",

  // Optional. When set, PostgreSQL is used instead of SQLite.
  // When empty/unset, SQLite (DataFolderPath + "/grytcord.db") is used.
  // The DatabaseEncryptionToken is ignored in Postgres mode, and
  // `pnpm run migrate:to-postgres` can copy your existing SQLite data
  // (decrypting it first if needed) into Postgres.
  // Example: "postgres://user:password@localhost:5432/grytcord"
  // PostgresConnectionString: "",

  // The Discord bot token
  DiscordBotToken: "DISCORD_BOT_TOKEN",

  // The Discord client ID
  DiscordClientId: "0000000000000000000",

  // The admin account IDs (Discord user IDs and/or Gryt server user IDs).
  // Allows accessing admin commands, and also allows verifying bridging
  // without having Manage Server permissions.
  AdminAccountIds: ["0000000000000000000"],

  // Gryt roles that count as "can configure the bridge" on the Gryt side.
  // Compared case-insensitively against a member's roles.
  GrytElevatedRoles: ["owner", "admin"],

  // The start line of the per-server bio of the bot on Discord.
  DiscordBioStart: "",

  // The footer of every embed sent by Grytcord. Optional.
  EmbedFooterContent: "",

  // The categories that the bot will log, remove any that you don't need.
  // Categories: GRYT, DISCORD, DB, META, DEBUG
  LoggingCategories: ["GRYT", "DISCORD", /*'DB',*/ "META"],

  // The list of MOTDs for the bot. If not specified or it is empty, it'll be disabled.
  // Examples:
  //  { text: "MOTD 1!" }
  //  { text: "MOTD 2!", emoji: "✉️" },
  Motds: [],

  // The prefix of the bot
  BotPrefix: "gc!",

  // Bridge from one side, with no approval on the other.
  //
  // Off by default because the two-sided handshake is what stops somebody
  // bridging your channel into a server you have never heard of. Turn it on
  // when you own both ends, which is the usual self-hosted case.
  //
  // With it on:
  //  - `bridge <channelId> [direction]` and `bridgeall` take effect immediately;
  //    `setup`, `setupall` and `verify` still work if you prefer them
  //  - a bridge made from Discord posts NOTHING in the Discord channel: the
  //    command gets a ✅ reaction instead of a reply. Failures still reply,
  //    because a failure you cannot see is worse than a message you did not want
  AutoVerifyBridges: false,

  // Max attachment size (in bytes) Grytcord will try to carry from Discord to
  // Gryt. Gryt's own per-file limit is a server setting; this is just the point
  // where Grytcord stops trying and posts a link instead.
  MaxAttachmentBytes: 25_000_000,

  // Healthcheck. Returns 200 when Discord and at least one Gryt server are online,
  // otherwise 503. Used by Docker HEALTHCHECK / compose healthcheck.
  // Set HealthcheckEnabled to false to disable.
  // HealthcheckEnabled: true,
  // HealthcheckPort: 8080,
  // HealthcheckHost: "0.0.0.0",
};

export default Config;
