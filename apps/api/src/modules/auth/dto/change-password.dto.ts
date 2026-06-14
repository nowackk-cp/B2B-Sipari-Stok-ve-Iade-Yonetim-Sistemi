import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password.', format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassword!: string;

  @ApiProperty({
    description: 'New password (12–128 chars; policy enforced server-side).',
    format: 'password',
  })
  @IsString()
  @MaxLength(256)
  newPassword!: string;
}
