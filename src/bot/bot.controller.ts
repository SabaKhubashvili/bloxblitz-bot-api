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

  // Shared secret for API key generation (must match Lua client)
  private readonly SHARED_SECRET = 'uhsdiahdsajou8d9say7haisdjusai';
  private readonly TIME_WINDOW_SECONDS = 300; // 5 minutes

  constructor(private readonly botService: BotService) {}

  // Simple hash matching Lua implementation
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const byte = str.charCodeAt(i);
      hash = (hash * 31 + byte) >>> 0; // Use >>> 0 to keep as 32-bit unsigned
      hash = hash % 4294967296;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // Generate expected API key for a given time window
  private generateExpectedApiKey(timeWindow: number, botId: number): string {
    const keyBase = `${timeWindow}_${this.SHARED_SECRET}_${botId}`;
    const hash = this.simpleHash(keyBase);
    
    // Get current timestamp for entropy (within same time window)
    const currentTime = timeWindow * this.TIME_WINDOW_SECONDS;
    const entropy = this.simpleHash(hash + currentTime.toString());
    
    const finalKey = (hash + entropy).substring(0, 32);
    return finalKey;
  }

  // Validate API key with time window tolerance
  private validateDynamicApiKey(providedKey: string, botId: number): boolean {
    const currentTime = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(currentTime / this.TIME_WINDOW_SECONDS);
    
    // Check current window and previous window (to handle clock skew and transitions)
    const windowsToCheck = [currentWindow, currentWindow - 1];
    
    for (const window of windowsToCheck) {
      const expectedKey = this.generateExpectedApiKey(window, botId);
      
      // Constant-time comparison to prevent timing attacks
      if (this.constantTimeCompare(providedKey, expectedKey)) {
        return true;
      }
    }
    
    return false;
  }

  // Constant-time string comparison
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  // XOR decryption helper
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
      if (!payload.custom_properties) {
        throw new Error('Missing custom_properties');
      }

      const customProps = payload.custom_properties;
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
      if (!this.verifyAnalyticsHeaders(headers)) {
        throw new HttpException(
          { success: false, message: 'Invalid request headers' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Validate dynamic API key
      const apiKey = headers['x-api-key'];
      const botId = parseInt(query.s_id || query.session_id);
      
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        throw new HttpException(
          { success: false, message: 'Invalid API key' },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const username = query.p_id || query.player_id;

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

      // Extract botId from payload for validation
      const realData = this.extractRealData(body);
      const botId = realData.ownerBotId;

      // Validate dynamic API key
      const apiKey = headers['x-api-key'];
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        this.recordFailedAttempt(clientIp);
        this.logger.error(`
          Invalid API key!
          IP: ${clientIp}
          Bot ID: ${botId}
        `);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const depositData: SucesfullDepositDTO = {
        username: realData.username,
        pets: realData.pets,
        ownerBotId: realData.ownerBotId
      };

      const result = await this.botService.processDeposit(depositData);
      
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

      const realData = this.extractRealData(body);
      const botId = realData.ownerBotId;

      const apiKey = headers['x-api-key'];
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

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

      const realData = this.extractRealData(body);
      const botId = realData.ownerBotId;

      const apiKey = headers['x-api-key'];
      if (!apiKey || !this.validateDynamicApiKey(apiKey, botId)) {
        this.recordFailedAttempt(clientIp);
        throw new HttpException(
          {
            status: 'error',
            message: 'Authentication failed',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

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
}