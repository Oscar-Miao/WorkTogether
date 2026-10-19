import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  acceptInviteSchema,
  inviteSchema,
  loginSchema,
  registerSchema,
  changePasswordSchema,
} from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
import { originCheck } from '../../common/security.js';
@Controller('api/v1')
export class AuthController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get('auth/options') options() {
    return {
      data: {
        registration_enabled: this.s.config.registrationEnabled,
        password_min_length: this.s.auth.passwordMinLength,
      },
    };
  }
  @Post('auth/register')
  async register(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return { data: await this.s.auth.register(req, res, registerSchema.parse(body)) };
  }
  @Post('auth/change-password')
  async changePassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return { data: await this.s.auth.changePassword(req, res, changePasswordSchema.parse(body)) };
  }
  @Post('auth/login')
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const input = loginSchema.parse(body);
    return { data: await this.s.auth.login(req, res, input.email, input.password) };
  }
  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.s.auth.logout(req, res);
    return { data: { ok: true } };
  }
  @Get('me')
  async me(@Req() req: Request) {
    return { data: await this.s.auth.current(req) };
  }
  @Post('invitations')
  async invite(@Req() req: Request, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    const input = inviteSchema.parse(body);
    return { data: await this.s.auth.invite(user, input.email) };
  }
  @Post('invitations/accept')
  async accept(@Req() req: Request, @Body() body: unknown) {
    originCheck(req, this.s.config);
    const input = acceptInviteSchema.parse(body);
    await this.s.auth.accept(input.token, input.name, input.password);
    return { data: { ok: true } };
  }
}
