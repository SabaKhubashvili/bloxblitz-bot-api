import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { DiscordNotificationService } from 'src/utils/discord_webhook.util';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

@Module({
  controllers: [BotController],
  providers: [PrismaService,ConfigService,BotService, DiscordNotificationService],
})
export class BotModule {}
