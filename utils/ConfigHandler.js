import Config from "../config.js";

const DefaultConfig = {
  /** @type {{ host: string, botToken?: string }[]} */
  GrytServers: [],
  GrytNickname: "Grytcord",
  GrytDescription: "Bridges channels between Discord and this server.",
  GrytIdentityPath: "/data/gryt-bot-identity.json",
  DataFolderPath: "/data",
  DiscordBotToken: "DISCORD_BOT_TOKEN",
  DiscordClientId: "0000000000000000000",
  AdminAccountIds: ["0000000000000000000"],
  GrytElevatedRoles: ["owner", "admin"],
  EmbedFooterContent: "",
  LoggingCategories: ["GRYT", "DISCORD", "META"],
  BotPrefix: "gc!",
  AutoVerifyBridges: false,
  DiscordBioStart: "",
  DatabaseEncryptionToken: "",
  PostgresConnectionString: "",
  MaxAttachmentBytes: 25_000_000,
  /** @type {{ text: string, emoji?: string }[]} */
  Motds: [],

  HealthcheckEnabled: true,
  HealthcheckPort: 8080,
  HealthcheckHost: "0.0.0.0",

  ...Config,
};

export default DefaultConfig;
