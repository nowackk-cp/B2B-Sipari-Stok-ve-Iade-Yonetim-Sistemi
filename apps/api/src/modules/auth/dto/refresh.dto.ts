import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Refresh request body. Browser clients send the refresh token via the HttpOnly
 * cookie and omit the body; pure API clients may pass it explicitly.
 */
export class RefreshDto {
  @ApiPropertyOptional({
    description: 'Refresh token (pure API clients; browsers use the cookie).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}
