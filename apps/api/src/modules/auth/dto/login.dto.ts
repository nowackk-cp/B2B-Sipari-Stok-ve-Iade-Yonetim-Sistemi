import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com', description: 'Account email (case-insensitive).' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ description: 'Account password.', format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
