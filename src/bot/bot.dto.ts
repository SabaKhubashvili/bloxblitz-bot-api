import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class UsernameQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(244)
  username: string;
  @IsString()
  @IsNotEmpty()
  @MaxLength(244)
  botId: string;
}
export class PetDTO {
  @IsString()
  @IsNotEmpty()
  @MaxLength(244)
  name: string;
  @IsString()
  @IsNotEmpty()
  @MaxLength(244)
  inGameName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(644)
  petInGameId: string;

  @IsBoolean()
  is_neon: boolean;

  @IsBoolean()
  is_mega: boolean;

  @IsBoolean()
  is_flyable: boolean;

  @IsBoolean()
  is_rideable: boolean;
}
export class SucesfullDepositDTO {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => PetDTO)
  pets: PetDTO[];

  @IsInt()
  ownerBotId: number;
}
export class SucesfullWithdrawDTO {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsInt()
  ownerBotId: number;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  itemIds: string[];
}
export class WithdrawDeclineDTO {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsInt()
  ownerBotId: number;
}
