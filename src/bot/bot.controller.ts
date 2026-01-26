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

  constructor(private readonly botService: BotService) {}

  // XOR decryption helper (simpler alternative)
  private xorDecrypt(data: string, key: string): string {
    try {
      const decoded = Buffer.from(data, 'base64').toString('binary');
      let result = '';
      
      for (let i = 0; i < decoded.length; i++) {
        const keyByte = key.charCodeAt(i % key.length);
        const dataByte = decoded.charCodeAt(i);
        result += String.fromCharCode(dataByte ^ keyByte);
      }
      
      return result;
    } catch (error) {
      this.logger.error('XOR Decryption failed:', error);
      throw new HttpException(
        {
          success: false,
          message: 'Invalid data format',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Extract real data from analytics-style payload
  private extractRealData(payload: any): any {
    try {
      // Data is hidden in custom_properties
      if (!payload.custom_properties) {
        throw new Error('Missing custom_properties');
      }

      const customProps = payload.custom_properties;
      
      // Decrypt the actual data
      const encryptedData = customProps.i_data || customProps.payload;
      const decryptedJson = this.xorDecrypt(
        encryptedData,
        process.env.XOR_KEY!
      );

      return JSON.parse(decryptedJson);
    } catch (error) {
      this.logger.error('Failed to extract real data:', error);
      throw new HttpException(
        {
          success: false,
          message: 'Invalid payload structure',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Verify analytics-style headers
  private verifyAnalyticsHeaders(headers: any): boolean {
    const requiredHeaders = [
      'x-client-version',
      'x-session-id',
      'x-request-id'
    ];

    return requiredHeaders.every(header => headers[header]);
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
        `IP ${ip} blocked for 30 minutes due to multiple auth failures`,
      );
    }

    this.failedAuthAttempts.set(ip, record);
  }

  private checkRateLimit(ip: string): boolean {
    const now = new Date();
    const record = this.failedAuthAttempts.get(ip);

    if (!record) {
      return false;
    }

    if (record.blockedUntil && record.blockedUntil > now) {
      return true;
    }

    if (record.blockedUntil && record.blockedUntil <= now) {
      record.count = 0;
      record.blockedUntil = null;
      this.failedAuthAttempts.set(ip, record);
    }

    return false;
  }

  @Get('query')
  async getWithdrawingItems(@Query() query: any, @Headers() headers: any) {
    try {
      // Verify it looks like analytics request
      if (!this.verifyAnalyticsHeaders(headers)) {
        throw new HttpException(
          { success: false, message: 'Invalid request headers' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Extract real query params from obfuscated structure
      const username = query.p_id || query.player_id;
      const botId = parseInt(query.s_id || query.session_id);

      if (!username || !botId) {
        throw new HttpException(
          { success: false, message: 'Missing required parameters' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const items = await this.botService.getWithdrawingItems(username, botId);
      
      if (items === null) {
        return {
          status: 'success',
          event_id: this.generateEventId(),
          data: {
            type: 'query_result',
            found: false,
            reason: 'entity_not_found'
          }
        };
      } else {
        // Return in analytics format
        return {
          status: 'success',
          event_id: this.generateEventId(),
          processed_at: Date.now(),
          data: {
            type: 'query_result',
            found: true,
            has_items: items.length > 0,
            items: items
          }
        };
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.error('Error fetching query data:', err);
      throw new HttpException(
        {
          status: 'error',
          message: 'Query processing failed',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Changed from /bot/deposit to /api/v1/events/collect
  @Post('collect')
  async handleDepositSuccess(
    @Body() body: any,
    @Headers() headers: any,
    @Req() request: Request,
  ) {
    try {
      const clientIp: string =
        (request.headers['x-real-ip'] as string) ||
        (request.headers['cf-connecting-ip'] as string) ||
        (request.headers['x-forwarded-for'] as string) ||
        'unknown';

      // Check rate limit
      if (this.checkRateLimit(clientIp)) {
        const record = this.failedAuthAttempts.get(clientIp);
        if (record && record.blockedUntil) {
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

      // Verify analytics headers
      if (!this.verifyAnalyticsHeaders(headers)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          { status: 'error', message: 'Invalid request format' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Verify API key (now in X-API-Key header)
      const apiKey = headers['x-api-key'];
      const expectedKey = process.env.BOT_API_KEY!;
      

      if (!apiKey || !this.verifyApiKey(apiKey, expectedKey)) {
        this.recordFailedAttempt(clientIp);
        this.logger.error(`
          Unauthorized attempt!
          IP: ${clientIp}
          Headers: ${JSON.stringify(headers)}
        `);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      // Extract real data from analytics payload
      const realData = this.extractRealData(body);

      // Map to expected DTO structure
      const depositData: SucesfullDepositDTO = {
        username: realData.username,
        pets: realData.pets,
        ownerBotId: realData.ownerBotId
      };

      const result = await this.botService.processDeposit(depositData);
      
      // Return in analytics format
      return {
        status: 'success',
        event_id: this.generateEventId(),
        processed_at: Date.now(),
        message: 'Events processed successfully',
        data: result,
      };
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      this.logger.error('Error processing collect event:', err);
      throw new HttpException(
        {
          status: 'error',
          message: 'Event processing failed',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Changed from /bot/withdraw to /api/v1/events/dispatch
  @Post('dispatch')
  async handleWithdrawSuccess(
    @Body() body: any,
    @Headers() headers: any,
    @Req() request: Request,
  ) {
    try {
      const clientIp: string =
        (request.headers['x-real-ip'] as string) ||
        (request.headers['cf-connecting-ip'] as string) ||
        (request.headers['x-forwarded-for'] as string) ||
        'unknown';

      if (this.checkRateLimit(clientIp)) {
        const record = this.failedAuthAttempts.get(clientIp);
        if (record && record.blockedUntil) {
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

      const apiKey = headers['x-api-key'];
      const expectedKey = process.env.BOT_API_KEY!;

      if (!apiKey || !this.verifyApiKey(apiKey, expectedKey)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const realData = this.extractRealData(body);

      const withdrawData: SucesfullWithdrawDTO = {
        username: realData.username,
        ownerBotId: realData.ownerBotId,
        itemIds: realData.itemIds
      };

      const result = await this.botService.processWithdraw(withdrawData);
      
      return {
        status: 'success',
        event_id: this.generateEventId(),
        processed_at: Date.now(),
        message: 'Events dispatched successfully',
        data: result,
      };
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      this.logger.error('Error processing dispatch event:', err);
      throw new HttpException(
        {
          status: 'error',
          message: 'Event processing failed',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Changed from /bot/withdraw_decline to /api/v1/events/cancel
  @Post('cancel')
  async handleWithdrawDecline(
    @Body() body: any,
    @Headers() headers: any,
    @Req() request: Request,
  ) {
    try {
      const clientIp: string =
        (request.headers['x-real-ip'] as string) ||
        (request.headers['cf-connecting-ip'] as string) ||
        (request.headers['x-forwarded-for'] as string) ||
        'unknown';

      if (this.checkRateLimit(clientIp)) {
        const record = this.failedAuthAttempts.get(clientIp);
        if (record && record.blockedUntil) {
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

      const apiKey = headers['x-api-key'];
      const expectedKey = process.env.BOT_API_KEY!;

      if (!apiKey || !this.verifyApiKey(apiKey, expectedKey)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const realData = this.extractRealData(body);

      const declineData: WithdrawDeclineDTO = {
        username: realData.username,
        ownerBotId: realData.ownerBotId
      };

      const result = await this.botService.processWithdrawDecline(declineData);
      
      return {
        status: 'success',
        event_id: this.generateEventId(),
        processed_at: Date.now(),
        message: 'Event cancelled successfully',
        data: result,
      };
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      this.logger.error('Error processing cancel event:', err);
      throw new HttpException(
        {
          status: 'error',
          message: 'Event processing failed',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Helper methods
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private verifyApiKey(provided: string, expected: string): boolean {
    // Time-based verification to prevent timing attacks
    const providedHash = crypto
      .createHash('sha256')
      .update(provided)
      .digest('hex');
    const expectedHash = crypto
      .createHash('sha256')
      .update(expected)
      .digest('hex');
    
    return providedHash === expectedHash;
  }
}