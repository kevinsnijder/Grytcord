import { Sequelize } from "sequelize-typescript";
import Config from "../utils/ConfigHandler.js";
import { log } from "../utils/Logger.js";
import { DataTypes, Model } from "sequelize";
import DefaultConfig from "../utils/ConfigHandler.js";
import sqlite3 from "@journeyapps/sqlcipher";

export const isPostgres =
  !!Config.PostgresConnectionString &&
  Config.PostgresConnectionString.length > 0;

/** @type {import("sequelize").Sequelize} */
let sequelize;

if (isPostgres) {
  if (DefaultConfig.DatabaseEncryptionToken) {
    console.warn(
      "[DB] DatabaseEncryptionToken is set but PostgresConnectionString is also set. The encryption token is ignored in Postgres mode.",
    );
  }
  sequelize = new Sequelize(Config.PostgresConnectionString, {
    dialect: "postgres",
    logging: (msg) => log("DB", msg),
  });
  await sequelize.query("SELECT 1;");
} else {
  sequelize = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: Config.DataFolderPath + "/grytcord.db",
    logging: (msg) => log("DB", msg),
    password: !!DefaultConfig.DatabaseEncryptionToken
      ? DefaultConfig.DatabaseEncryptionToken
      : undefined,
  });

  if (DefaultConfig.DatabaseEncryptionToken) {
    await sequelize.query("PRAGMA cipher_compatibility = 4;");
    await sequelize.query(
      `PRAGMA key = ${sequelize.escape(Config.DatabaseEncryptionToken)};`,
    );
  }

  await sequelize.query("PRAGMA wal_checkpoint(TRUNCATE);");
  await sequelize.query("VACUUM;");
}

class ChannelMap extends Model {}
class MessageMap extends Model {}
class UserConfig extends Model {}
class GuildMap extends Model {}

GuildMap.init(
  {
    guildId: { type: DataTypes.STRING, allowNull: false },
    guildType: { type: DataTypes.ENUM("gryt", "discord"), allowNull: false },
    errorReaction: {
      type: DataTypes.STRING,
      defaultValue: "⛓️‍💥",
      allowNull: true,
    },
    errorLoggingChannelId: { type: DataTypes.STRING, allowNull: true },
    errorLoggingPlatform: {
      type: DataTypes.ENUM("gryt", "discord"),
      allowNull: true,
    },
    botPrefix: {
      type: DataTypes.STRING,
      defaultValue: DefaultConfig.BotPrefix,
    },
    typingEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  { sequelize, modelName: "GuildMap" },
);

ChannelMap.init(
  {
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookToken: { type: DataTypes.STRING, allowNull: false },
    // The Gryt server this channel lives on. One Grytcord can bridge several.
    grytHost: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    grytGuildId: { type: DataTypes.STRING, allowNull: false },
    grytChannelId: { type: DataTypes.STRING, allowNull: false },
    grytWebhookId: { type: DataTypes.STRING, allowNull: false },
    grytWebhookToken: { type: DataTypes.STRING, allowNull: false },
    bridgeType: {
      type: DataTypes.ENUM("discord2gryt", "gryt2discord", "both"),
      allowNull: false,
      defaultValue: "both",
    },
    grytGuildMapId: {
      type: DataTypes.INTEGER,
      field: "GrytGuildMapId",
      references: { model: GuildMap, key: "id" },
    },
    discordGuildMapId: {
      type: DataTypes.INTEGER,
      field: "DiscordGuildMapId",
      references: { model: GuildMap, key: "id" },
    },
  },
  { sequelize, modelName: "ChannelMap" },
);

MessageMap.init(
  {
    messageSource: {
      type: DataTypes.ENUM("discord", "gryt"),
      allowNull: false,
    },
    discordMessageId: { type: DataTypes.STRING, allowNull: false },
    grytMessageId: { type: DataTypes.STRING, allowNull: false },
    discordReplyId: { type: DataTypes.STRING, allowNull: true },
    grytReplyId: { type: DataTypes.STRING, allowNull: true },
    authorId: { type: DataTypes.STRING, allowNull: false },
    // How the Gryt copy was posted. A webhook message keeps the author's name
    // and picture but cannot be edited; a bot-sent one can be edited and can
    // carry files. Handlers read this to know which is which.
    grytSentVia: {
      type: DataTypes.ENUM("webhook", "bot"),
      allowNull: false,
      defaultValue: "webhook",
    },
    channelMapId: {
      type: DataTypes.INTEGER,
      field: "ChannelMapId",
      references: { model: ChannelMap, key: "id" },
    },
  },
  { sequelize, modelName: "MessageMap" },
);

UserConfig.init(
  {
    userType: { type: DataTypes.ENUM("discord", "gryt"), allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    doNotBridgePrefix: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
  },
  { sequelize, modelName: "UserConfig" },
);

MessageMap.belongsTo(ChannelMap, {
  foreignKey: "channelMapId",
  as: "channelMap",
});
ChannelMap.hasMany(MessageMap, {
  foreignKey: "channelMapId",
  as: "messageMaps",
});
ChannelMap.belongsTo(GuildMap, {
  foreignKey: "discordGuildMapId",
  as: "discordGuildMap",
});
ChannelMap.belongsTo(GuildMap, {
  foreignKey: "grytGuildMapId",
  as: "grytGuildMap",
});
GuildMap.hasMany(ChannelMap, {
  foreignKey: "discordGuildMapId",
  as: "discordChannelMaps",
});
GuildMap.hasMany(ChannelMap, {
  foreignKey: "grytGuildMapId",
  as: "grytChannelMaps",
});

export { sequelize, ChannelMap, MessageMap, UserConfig, GuildMap };
