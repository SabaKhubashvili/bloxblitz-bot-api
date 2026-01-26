// src/bot/bot.service.ts
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import {
  SucesfullDepositDTO,
  SucesfullWithdrawDTO,
  WithdrawDeclineDTO,
} from './bot.dto';

import { PrismaService } from 'src/prisma/prisma.service';
import { DiscordNotificationService } from 'src/utils/discord_webhook.util';
import { BotTradeStatus, pets, UserInventoryItemState, Variant } from '@prisma/client';



@Injectable()
export class BotService {
  private logger: Logger = new Logger(BotService.name);
  constructor(
    private prisma: PrismaService,
    private readonly discordWebhookService: DiscordNotificationService,

  ) {}

  async getWithdrawingItems(username: string, ownerBotId: number) {
    this.logger.debug(
      `Attempting to get withdrawing items for user: ${username}, botId: ${ownerBotId}`,
    );

    const user = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: username,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      this.logger.warn(`User not found: ${username}`);
      return null;
    }

    const items = await this.prisma.userInventory.updateManyAndReturn({
      where: {
        userUsername: user?.username,
        state: 'WITHDRAWING',
        owner_bot_id: ownerBotId,
        Bot: {
          banned: false,
          active: true,
          can_join: true,
        },
      },
      data: {
        botTradeStatus: BotTradeStatus.WITHDRAW_ACCEPTED,
      },
    });

    this.logger.log(
      JSON.stringify({
        message: `Retrieved ${items?.length || 0} withdrawing items for user`,
        username,
        ownerBotId,
        itemCount: items?.length || 0,
        items: JSON.stringify(items),
      }),
    );

    return items || [];
  }
  async processDeposit(data: SucesfullDepositDTO) {
    this.logger.debug(
      `Processing deposit for user: ${data.username}, botId: ${data.ownerBotId}`,
    );

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: data.username, mode: 'insensitive' } },
      select: { username: true },
    });

    if (!user) {
      this.logger.error(
        JSON.stringify({
          message: 'Deposit failed - User not found',
          username: data.username,
          ownerBotId: data.ownerBotId,
        }),
      );
      throw new UnauthorizedException();
    }

    // ✅ Fetch all pets in ONE query
    const inGameNames = data.pets.map((p) => p.inGameName);
    const petsDb: pets[] = await this.prisma.pets.findMany({
      where: { inGameName: { in: inGameNames } },
    });

    const petsMap = new Map(petsDb.map((p) => [p.inGameName, p]));

    const processedPets = data.pets.map((petData) => {
      const pet = petsMap.get(petData.inGameName);
      if (!pet) {
        this.logger.error(
          JSON.stringify({
            message: 'Pet not found in database during deposit',
            petName: petData.name,
            inGameName: petData.inGameName,
            owner_bot_id: data.ownerBotId,
            inGameId: petData.petInGameId,
            username: data.username,
          }),
        );
        return null;
      }

      const value = this.calculatePetValue(pet, {
        isMega: petData.is_mega,
        isNeon: petData.is_neon,
        isFlyable: petData.is_flyable,
        isRideable: petData.is_rideable,
      });

      const petVariant: Variant[] = [];
      if (petData.is_mega) petVariant.push(Variant.M);
      else if (petData.is_neon) petVariant.push(Variant.N);
      if (petData.is_rideable) petVariant.push(Variant.R);
      if (petData.is_flyable) petVariant.push(Variant.F);

      return {
        petId: pet.id,
        name: pet.name, // ✅ added
        inGameName: pet.inGameName, // ✅ for webhook
        value,
        userUsername: user.username,
        state: UserInventoryItemState.IDLE,
        botTradeStatus: BotTradeStatus.NONE,
        petInGameId: petData.petInGameId,
        owner_bot_id: data.ownerBotId,
        petVariant,
        updatedAt: new Date(),
      };
    });

    const validPets = processedPets.filter((p) => p !== null);

    if (validPets.length === 0) {
      return { message: 'No valid pets found in deposit' };
    }

    try {
      const result = await this.prisma.userInventory.createMany({
        data: validPets.map(({ name, inGameName, ...rest }) => rest),
        skipDuplicates: true,
      });

      // ✅ Now validPets has names for Discord
      this.discordWebhookService.sendUserDepositToWebhook(
        data.ownerBotId,
        data.username,
        validPets,
      );

      this.logger.log(
        JSON.stringify({
          message: 'Deposit successful',
          username: data.username,
          petsCreated: result.count,
          totalProcessed: validPets.length,
          pets: validPets.map((p) =>
            JSON.stringify({
              name: p.name,
              petInGameId: p.petInGameId,
              owner_bot_id: p.owner_bot_id,
            }),
          ),
        }),
      );

      return { success: true, petsCreated: result.count };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          message: 'Error saving pets to inventory',
          username: data.username,
          error: error.message,
          stack: error.stack,
        }),
      );
      throw error;
    }
  }

  private calculatePetValue(
    pet: pets,
    options: {
      isMega: boolean;
      isNeon: boolean;
      isFlyable: boolean;
      isRideable: boolean;
    },
  ): number {
    const { isMega, isNeon, isFlyable, isRideable } = options;
    let value: number;

    if (isMega) {
      if (isFlyable && isRideable) value = pet.mvalue_flyride;
      else if (isFlyable) value = pet.mvalue_fly;
      else if (isRideable) value = pet.mvalue_ride;
      else value = pet.mvalue_nopotion;
    } else if (isNeon) {
      if (isFlyable && isRideable) value = pet.nvalue_flyride;
      else if (isFlyable) value = pet.nvalue_fly;
      else if (isRideable) value = pet.nvalue_ride;
      else value = pet.nvalue_nopotion;
    } else {
      if (isFlyable && isRideable) value = pet.rvalue_flyride;
      else if (isFlyable) value = pet.rvalue_fly;
      else if (isRideable) value = pet.rvalue_ride;
      else value = pet.rvalue_nopotion;
    }

    this.logger.debug({
      message: 'Pet value calculated',
      petId: pet.id,
      petName: pet.name,
      value,
      attributes: { isMega, isNeon, isFlyable, isRideable },
    });

    return value;
  }

  async processWithdraw(data: SucesfullWithdrawDTO) {
    this.logger.debug(
      `Processing withdraw for user: ${data.username}, botId: ${data.ownerBotId}`,
    );

    const user = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: data.username,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      this.logger.error(
        JSON.stringify({
          message: 'Withdraw failed - User not found',
          username: data.username,
          ownerBotId: data.ownerBotId,
        }),
      );
      throw new UnauthorizedException();
    }

    try {
      const result = await this.prisma.userInventory.findMany({
        where: {
          userUsername: user.username,
          owner_bot_id: data.ownerBotId,
          petInGameId: {
            in: data.itemIds,
          },
        },
        select: {
          id: true,
          petVariant: true,
          pets: {
            select: {
              name: true,
            },
          },
        },
      });

      const { count } = await this.prisma.userInventory.deleteMany({
        where: {
          id: {
            in: result.map((i) => i.id),
          },
        },
      });

   

      if (count !== data.itemIds.length) {
        this.logger.warn(
          JSON.stringify({
            message: 'Not all requested items were deleted during withdraw',
            username: data.username,
            ownerBotId: data.ownerBotId,
            requested: data.itemIds.length,
            deleted: count,
            itemIds: data.itemIds,
          }),
        );
      }
      // ✅ Now validPets has names for Discord
      this.discordWebhookService.sendUserWithdrawToWebhook(
        data.ownerBotId,
        data.username,
        result.map((r) => ({ name: r.pets.name, petVariant: r.petVariant })),
      );

      return result;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          message: 'Error processing withdraw',
          username: data.username,
          ownerBotId: data.ownerBotId,
          error: error.message,
          stack: error.stack,
        }),
      );
      throw error;
    }
  }

  async processWithdrawDecline(data: WithdrawDeclineDTO) {
    this.logger.debug(`Processing withdraw decline for user: ${data.username}`);

    const user = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: data.username,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      this.logger.error(
        JSON.stringify({
          message: 'Withdraw decline failed - User not found',
          username: data.username,
        }),
      );
      throw new UnauthorizedException();
    }

    try {
      const result = await this.prisma.userInventory.updateMany({
        where: {
          userUsername: {
            equals: data.username,
            mode: 'insensitive',
          },
          state: UserInventoryItemState.WITHDRAWING,
          owner_bot_id: data.ownerBotId,
        },
        data: {
          botTradeStatus: BotTradeStatus.NONE,
        },
      });

      this.logger.log(
        JSON.stringify({
          message: 'Withdraw decline processed',
          username: data.username,
          itemsUpdated: result.count,
        }),
      );

      return result;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          message: 'Error processing withdraw decline',
          username: data.username,
          error: error.message,
          stack: error.stack,
        }),
      );
      throw error;
    }
  }
}
