import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Cancel-order command DTO (Order Draft Foundation). A DRAFT cancel has no stock
 * effect, so the reason is optional here (it becomes mandatory for the
 * APPROVED/PREPARING cancellations in a later slice). Recorded in the
 * order_status_history transition and the business audit.
 */
export class CancelOrderDto {
  @ApiPropertyOptional({ nullable: true, example: 'Customer changed their mind.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
