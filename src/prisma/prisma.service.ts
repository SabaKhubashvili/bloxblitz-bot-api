import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { makeRetryExtension } from './extensions/retryPrisma.extension';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Create a pg Pool instance
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      connectionTimeoutMillis: 5000,

    });

    // Create the adapter with the pool
    const adapter = new PrismaPg(pool);

    super({
      adapter,
      log: ['query', 'error', 'warn']
    });
  }

  async onModuleInit() {
    // Apply retry extension first
    Object.assign(this, this.$extends(makeRetryExtension(this)));
    await this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async connectWithRetry(maxRetries = 5): Promise<void> {
    let attempt = 0;
    const baseDelay = 2000;

    while (attempt < maxRetries) {
      attempt++;
      try {
        await this.$connect();
        this.logger.log('✅ Connected to database via Prisma adapter');
        return;
      } catch (err: any) {
        this.logger.error(`❌ DB connection failed (attempt ${attempt}/${maxRetries}): ${err.message}`);
        
        if (attempt >= maxRetries) throw err;

        const delay = baseDelay * attempt;
        this.logger.warn(`⏳ Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  // Optional helper for safe queries
  async safeQuery<T>(callback: () => Promise<T>): Promise<T> {
    let attempt = 0;
    const maxRetries = 3;

    while (true) {
      try {
        return await callback();
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) throw err;
        this.logger.warn(`Retrying failed query (${attempt}/${maxRetries})...`);
      }
    }
  }
}