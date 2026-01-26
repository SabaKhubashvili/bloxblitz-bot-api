// prisma/extensions/retryPrisma.extension.ts

import { Prisma } from '@prisma/client/extension';
import { PrismaService } from '../prisma.service';

export function makeRetryExtension(prismaService: PrismaService) {
  return Prisma.defineExtension({
    name: 'retryExtension',
    query: {
      $allModels: {
        async $allOperations({ operation, model, args, query }) {
          let lastError: any;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              return await query(args);
            } catch (err: any) {
              lastError = err;

              const transientErrors = [
                'P1001', // Can't reach DB
                'P1002', // Connection timed out
                'P1008', // Operations timed out
                'P1009', // Database not reachable
              ];

              if (err.code && transientErrors.includes(err.code)) {
                console.warn(
                  `⚠️ Transient DB error on ${model}.${operation}, retrying (${attempt}/3)...`
                );
                await new Promise((res) => setTimeout(res, 500 * attempt));
                continue;
              }

              if (
                err.message &&
                err.message.includes('Server has closed the connection')
              ) {
                console.warn(
                  `⚠️ DB connection closed during ${model}.${operation}, retrying (${attempt}/3)...`
                );
                await prismaService.connectWithRetry(); // 👈 Reconnect here
                continue;
              }

              throw err; // not transient → bubble up
            }
          }

          throw lastError;
        },
      },
    },
  });
}
