// src/bot/bot.controller.ts
import {
  Controller,
  Get,
  Logger,
  HttpException,
  HttpStatus,
  Query,
  Post,
  Body,
  Headers,
  Req,
} from '@nestjs/common';
import * as crypto from 'crypto';

import { BotService } from './bot.service';
import {
  SucesfullDepositDTO,
  SucesfullWithdrawDTO,
  WithdrawDeclineDTO,
} from './bot.dto';
@Controller('api/v1/events')
export class BotController {
  private readonly logger: Logger = new Logger(BotController.name);
  private failedAuthAttempts: Map<
    string,
    { count: number; blockedUntil: Date | null }
  > = new Map();

  private readonly SHARED_SECRET = 'uhsdiahdsajou8d9say7haisdjusai';
  private readonly TIME_WINDOW_SECONDS = 300; // 5 minutes

  constructor(private readonly botService: BotService) {}

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const byte = str.charCodeAt(i);
      hash = (hash * 31 + byte) >>> 0;
      hash = hash % 4294967296;
    }
    return hash.toString(16).padStart(8, '0');
  }

private generateExpectedApiKey(botId: number): string {
  const currentTime = Math.floor(Date.now() / 1000); // seconds since epoch
  const timeWindow = Math.floor(currentTime / 300);  // 5-minute window

  const keyBase = `${timeWindow}_${this.SHARED_SECRET}_${botId}`;
  const hash = this.simpleHash(keyBase);

  // Match Lua exactly: entropy uses currentTime
  const entropy = this.simpleHash(hash + currentTime.toString());

  const finalKey = (hash + entropy).substring(0, 32);

  // Logging for debugging
  this.logger.log(`Generated expected key for bot ${botId}: ${finalKey}`);
  this.logger.log(`Time window: ${timeWindow}, Current time: ${currentTime}`);
  this.logger.log(`Key base: ${keyBase}`);
  this.logger.log(`Hash: ${hash}, Entropy: ${entropy}`);

  return finalKey;
}private validateDynamicApiKey(providedKey: string, botId: number): boolean {
  const expectedKey = this.generateExpectedApiKey(botId);

  // Normalize both keys to match Lua client's 32-char format
  const normalizedClientKey = this.normalizeKey(providedKey);
  const normalizedExpectedKey = this.normalizeKey(expectedKey);

  this.logger.log(`Client sent key: ${normalizedClientKey}`);
  this.logger.log(`Expected key: ${normalizedExpectedKey}`);

  return this.constantTimeCompare(normalizedClientKey, normalizedExpectedKey);
}

private normalizeKey(key: string): string {
  return key.padEnd(14, '0');
}

private constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}


  private xorDecrypt(data: string, key: string): string {
    try {
      const decoded = Buffer.from(data, 'base64').toString('binary');
      let result = '';
      for (let i = 0; i < decoded.length; i++) {
        const keyByte = key.charCodeAt(i % key.length);
        const dataByte = decoded.charCodeAt(i);
        result += String.fromCharCode(dataByte ^ keyByte);
      }
      this.logger.log('Payload successfully XOR decrypted');
      return result;
    } catch (error) {
      this.logger.error('XOR Decryption failed:', error);
      throw new HttpException(
        { success: false, message: 'Invalid data format' },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private extractRealData(payload: any): any {
    try {
      if (!payload.custom_properties) {
        throw new Error('Missing custom_properties');
      }

      const customProps = payload.custom_properties;
      const encryptedData = customProps.i_data || customProps.payload;
      const decryptedJson = this.xorDecrypt(
        encryptedData,
        process.env.XOR_KEY!,
      );

      const data = JSON.parse(decryptedJson);
      this.logger.log(
        `Extracted real data for user: ${data.username}, bot: ${data.ownerBotId}`,
      );
      return data;
    } catch (error) {
      this.logger.error('Failed to extract real data:', error);
      throw new HttpException(
        { success: false, message: 'Invalid payload structure' },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private verifyAnalyticsHeaders(headers: any): boolean {
    const requiredHeaders = [
      'x-client-version',
      'x-session-id',
      'x-request-id',
    ];
    const valid = requiredHeaders.every((header) => headers[header]);
    if (!valid) this.logger.warn('Invalid analytics headers', headers);
    return valid;
  }

  private recordFailedAttempt(ip: string): void {
    const record = this.failedAuthAttempts.get(ip) || {
      count: 0,
      blockedUntil: null,
    };
    record.count += 1;

    if (record.count >= 3) {
      const blockUntil = new Date();
      blockUntil.setMinutes(blockUntil.getMinutes() + 30);
      record.blockedUntil = blockUntil;
      this.logger.warn(
        `IP ${ip} blocked for 30 minutes due to repeated auth failures`,
      );
    } else {
      this.logger.warn(`Failed auth attempt ${record.count} for IP ${ip}`);
    }

    this.failedAuthAttempts.set(ip, record);
  }

  private checkRateLimit(ip: string): boolean {
    const now = new Date();
    const record = this.failedAuthAttempts.get(ip);

    if (!record) return false;

    if (record.blockedUntil && record.blockedUntil > now) {
      this.logger.warn(
        `Rate limit enforced for IP ${ip} until ${record.blockedUntil}`,
      );
      return true;
    }

    if (record.blockedUntil && record.blockedUntil <= now) {
      record.count = 0;
      record.blockedUntil = null;
      this.failedAuthAttempts.set(ip, record);
      this.logger.log(`Rate limit reset for IP ${ip}`);
    }

    return false;
  }

  @Get('query')
  async getWithdrawingItems(@Query() query: any, @Headers() headers: any) {
    try {
      this.logger.log('Received query request', { query, headers });

      if (!this.verifyAnalyticsHeaders(headers)) {
        throw new HttpException(
          { success: false, message: 'Invalid request headers' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const apiKey = headers['x-api-key'];
      const botId = parseInt(query.s_id || query.session_id);
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        this.logger.warn(`Unauthorized query request for bot ${botId}`);
        throw new HttpException(
          { success: false, message: 'Invalid API key' },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const username = query.p_id || query.player_id;
      this.logger.log(
        `Fetching withdrawing items for user ${username} on bot ${botId}`,
      );

      const items = await this.botService.getWithdrawingItems(username, botId);
      this.logger.log(`Fetched items: ${items ? items.length : 0}`);

      if (!items) {
        return {
          status: 'success',
          event_id: this.generateEventId(),
          data: {
            type: 'query_result',
            found: false,
            reason: 'entity_not_found',
          },
        };
      }

      return {
        status: 'success',
        event_id: this.generateEventId(),
        processed_at: Date.now(),
        data: {
          type: 'query_result',
          found: true,
          has_items: items.length > 0,
          items,
        },
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error('Error fetching query data:', err);
      throw new HttpException(
        { status: 'error', message: 'Query processing failed' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('collect')
  async handleDepositSuccess(
    @Body() body: any,
    @Headers() headers: any,
    @Req() request: Request,
  ) {
    try {
      const clientIp =
        (request.headers['x-real-ip'] as string) ||
        (request.headers['cf-connecting-ip'] as string) ||
        (request.headers['x-forwarded-for'] as string) ||
        'unknown';
      this.logger.log(`Received deposit event from IP: ${clientIp}`, body);

      if (this.checkRateLimit(clientIp)) {
        const record = this.failedAuthAttempts.get(clientIp);
        if (record?.blockedUntil) {
          const remainingMinutes = Math.ceil(
            (record.blockedUntil.getTime() - new Date().getTime()) / 60000,
          );
          throw new HttpException(
            {
              status: 'error',
              message: `Rate limit exceeded. Retry in ${remainingMinutes} minutes.`,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      if (!this.verifyAnalyticsHeaders(headers)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          { status: 'error', message: 'Invalid request format' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const realData = this.extractRealData(body);
      const botId = realData.ownerBotId;

      const apiKey = headers['x-api-key'];
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        this.recordFailedAttempt(clientIp);
        this.logger.error(
          `Authentication failed for IP: ${clientIp}, Bot ID: ${botId}`,
        );
        throw new HttpException(
          { status: 'error', message: 'Authentication failed' },
          HttpStatus.UNAUTHORIZED,
        );
      }

      this.logger.log(
        `Processing deposit for user ${realData.username}, Bot: ${botId}`,
      );
      const depositData: SucesfullDepositDTO = {
        username: realData.username,
        pets: realData.pets,
        ownerBotId: realData.ownerBotId,
      };
      const result = await this.botService.processDeposit(depositData);

      this.logger.log(
        `Deposit processed successfully for user ${realData.username}`,
      );
      return {
        status: 'success',
        event_id: this.generateEventId(),
        processed_at: Date.now(),
        message: 'Events processed successfully',
        data: result,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error('Error processing collect event:', err);
      throw new HttpException(
        { status: 'error', message: 'Event processing failed' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private generateEventId(): string {
    return crypto.randomBytes(16).toString('hex');
  }
  // Withdraw and cancel routes can be similarly wrapped with logs:
  // - Log IP, headers, payload, validation success/failure
  // - Log start and end of service calls
  // - Log results of processing
}
