import { DataTypes, QueryInterface } from "sequelize";
import DefaultConfig from "../utils/ConfigHandler.js";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.createTable("GuildMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
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
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.createTable("ChannelMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookToken: { type: DataTypes.STRING, allowNull: false },
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
    DiscordGuildMapId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "GuildMaps", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    GrytGuildMapId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "GuildMaps", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.createTable("MessageMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    messageSource: {
      type: DataTypes.ENUM("discord", "gryt"),
      allowNull: false,
    },
    discordMessageId: { type: DataTypes.STRING, allowNull: false },
    grytMessageId: { type: DataTypes.STRING, allowNull: false },
    discordReplyId: { type: DataTypes.STRING, allowNull: true },
    grytReplyId: { type: DataTypes.STRING, allowNull: true },
    authorId: { type: DataTypes.STRING, allowNull: false },
    grytSentVia: {
      type: DataTypes.ENUM("webhook", "bot"),
      allowNull: false,
      defaultValue: "webhook",
    },
    ChannelMapId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "ChannelMaps", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.createTable("UserConfigs", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userType: { type: DataTypes.ENUM("discord", "gryt"), allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    doNotBridgePrefix: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addIndex("ChannelMaps", ["discordChannelId"]);
  await queryInterface.addIndex("ChannelMaps", ["grytChannelId"]);
  await queryInterface.addIndex("MessageMaps", ["discordMessageId"]);
  await queryInterface.addIndex("MessageMaps", ["grytMessageId"]);
  await queryInterface.addIndex("MessageMaps", ["ChannelMapId"]);
  await queryInterface.addIndex("MessageMaps", ["discordReplyId"]);
  await queryInterface.addIndex("MessageMaps", ["grytReplyId"]);
  await queryInterface.addIndex("GuildMaps", ["guildId", "guildType"]);
  await queryInterface.addIndex("UserConfigs", ["userId", "userType"]);
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.dropTable("MessageMaps");
  await queryInterface.dropTable("ChannelMaps");
  await queryInterface.dropTable("UserConfigs");
  await queryInterface.dropTable("GuildMaps");
}
