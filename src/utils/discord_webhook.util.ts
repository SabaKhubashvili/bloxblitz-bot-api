import { Injectable, Logger } from '@nestjs/common';
import { Webhook, MessageBuilder } from 'discord-webhook-node';
import { ConfigService } from '@nestjs/config';
import { Variant } from '@prisma/client';
@Injectable()
export class DiscordNotificationService {
private readonly botLoggerWebhook: Webhook;
private readonly chatLoggerWebhook: Webhook;
private readonly logger = new Logger(DiscordNotificationService.name);

constructor(private configService: ConfigService) {
  this.botLoggerWebhook = new Webhook({
    url: this.configService.get<string>('DISCORD_BOT_LOGS_WEBHOOOK') || '',
    retryOnLimit: false,
  });
}

async sendUserDepositToWebhook(
  botUsername: number,
  senderUsername: string,
  items: { petVariant: Variant[]; name: string; value: number }[],
): Promise<void> {
  try {
    const totalItems = items.length;

    const formattedItems = items
      .map((item) => {
        return `**${item.name}** (${item.value} value) ${item.petVariant}`;
      })
      .join('\n');

    const color = totalItems > 3 ? 0x00ff99 : 0x808080;

    const message = new MessageBuilder()
      .setTitle('📥 New User Deposit')
      .setColor(color)
      .setDescription(
        `
      **From:** ${senderUsername}
      **To Bot:** ${botUsername}
      **Total Pets:** ${totalItems}

      🐾 **Items:**
      ${formattedItems}
      `,
      )
      .setTimestamp()
      .setFooter('Deposit Logger');

    await this.botLoggerWebhook.send(message);
  } catch (error) {
    this.logger.warn(
      `Failed to send Discord notification of deposit: ${error.message}`,
    );
  }
}
async sendUserWithdrawToWebhook(
  botUsername: number,
  senderUsername: string,
  items: { petVariant: Variant[]; name: string }[],
): Promise<void> {
  try {
    const totalItems = items.length;

    const formattedItems = items
      .map((item) => {
        return `**${item.name}**  ${item.petVariant}`;
      })
      .join('\n');

    const color = totalItems > 3 ? 0x00ff99 : 0x808080;

    const message = new MessageBuilder()
      .setTitle('📤 User Withdrawal')
      .setColor(color)
      .setDescription(
        `
      **User:** ${senderUsername}
      **Bot:** ${botUsername}
      **Total Pets:** ${totalItems}

      🐾 **Withdrawn Pets:**
      ${formattedItems}
      `,
      )
      .setTimestamp()
      .setFooter('Withdrawal Logger');

    await this.botLoggerWebhook.send(message);
  } catch (error) {
    this.logger.warn(
      `Failed to send Discord notification of deposit: ${error.message}`,
    );
  }
}
async sendUserChatLog(
  username: string,
  content: string,
  role: string,
): Promise<void> {
  try {
    const color = 0x808080;

    const message = new MessageBuilder()
      .setTitle('💬 | New Chat Message')
      .setColor(color)
      .setDescription(
        `
      **Sender:** ${username}
      **Content:** ${content}
      **Role:** ${role}
      `,
      )
      .setTimestamp()
      .setFooter('Chat Logger');

    await this.chatLoggerWebhook.send(message);
  } catch (error) {
    this.logger.warn(
      `Failed to send Discord notification of deposit: ${error.message}`,
    );
  }
}
}
