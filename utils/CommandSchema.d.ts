import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
} from "discord.js";
import type { GrytMessage } from "./GrytMessage.js";
import type { GrytClient } from "./GrytClient.js";

export type CommandSchema = {
  groupNames?: string[];
  name: string;
  aliases?: string[];
  description: string;
  requireElevated: boolean;
  requireOwner?: boolean;
  hideFromHelp?: boolean;
  params?: string;
  additionalInfo?: string;
  run: (
    params: string[],
    message: OmitPartialGroupDMChannel<DiscordMessage<boolean>> | GrytMessage,
    discordClient: DiscordClient,
    grytClient: GrytClient,
  ) => Promise<void>;
};
