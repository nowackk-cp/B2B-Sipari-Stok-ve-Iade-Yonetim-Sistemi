import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthSessionView, MessageView, SessionView, UserProfileView } from '@b2b/contracts';
import { AppConfigService } from '../../common/config/app-config.service';
import { requestMeta } from '../../common/http/request-meta';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/auth/principal';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from './cookies/refresh-cookie';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const GENERIC_FORGOT_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email + password.' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionView> {
    const result = await this.auth.login(dto.email, dto.password, requestMeta(req));
    setRefreshCookie(res, this.config, result.refreshToken);
    return result.body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token.' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionView> {
    const presented = readRefreshToken(req, this.config, dto.refreshToken);
    const result = await this.auth.refresh(presented, requestMeta(req));
    setRefreshCookie(res, this.config, result.refreshToken);
    return result.body;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current session and clear the refresh cookie.' })
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageView> {
    const presented = readRefreshToken(req, this.config, dto.refreshToken);
    await this.auth.logout(presented, requestMeta(req));
    clearRefreshCookie(res, this.config);
    return { message: 'Logged out.' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all of the current user’s sessions.' })
  async logoutAll(
    @CurrentUser() principal: AuthPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageView> {
    await this.auth.logoutAll(principal, requestMeta(req));
    clearRefreshCookie(res, this.config);
    return { message: 'All sessions revoked.' };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the current user’s active sessions.' })
  async sessions(@CurrentUser() principal: AuthPrincipal): Promise<SessionView[]> {
    return this.auth.listSessions(principal);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one of the current user’s sessions.' })
  async revokeSession(
    @CurrentUser() principal: AuthPrincipal,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.revokeSession(principal, sessionId, requestMeta(req));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user’s profile.' })
  async me(@CurrentUser() principal: AuthPrincipal): Promise<UserProfileView> {
    return this.auth.getProfile(principal);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the authenticated user’s password.' })
  async changePassword(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<MessageView> {
    await this.auth.changePassword(
      principal,
      dto.currentPassword,
      dto.newPassword,
      requestMeta(req),
    );
    return { message: 'Password changed.' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link (always a generic response).' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request): Promise<MessageView> {
    await this.auth.forgotPassword(dto.email, requestMeta(req));
    return { message: GENERIC_FORGOT_MESSAGE };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a password reset with a single-use token.' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<MessageView> {
    await this.auth.resetPassword(dto.token, dto.newPassword, requestMeta(req));
    return { message: 'Password has been reset.' };
  }
}
