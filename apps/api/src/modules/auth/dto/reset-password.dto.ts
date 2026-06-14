import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use reset token from the reset email.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;

  @ApiProperty({
    description: 'New password (12–128 chars; policy enforced server-side).',
    format: 'password',
  })
  @IsString()
  @MaxLength(256)
  newPassword!: string;
}
