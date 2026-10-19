import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { teamCreateSchema, teamInvitationSchema, teamTokenSchema } from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
import { originCheck } from '../../common/security.js';
import { identityRateLimit } from '../auth/identity-rate-limit.js';

@Controller('api/v3')
export class AdmissionController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get('account') async account(@Req() req: Request) {
    const user = await this.s.auth.current(req);
    return {
      data: {
        user,
        projects: await this.s.organization!.list(user),
        workspaces: await this.s.organization!.workspaces(user),
      },
    };
  }
  @Post('teams') async create(@Req() req: Request, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    await identityRateLimit(this.s.db, 'team-create', user.id, 20);
    return {
      data: await this.s.organization!.admission.createTeam(
        user,
        teamCreateSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Post('projects/:id/invitations') async invite(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.s.organization!.admission.invite(
        await this.s.auth.current(req, true),
        id,
        teamInvitationSchema.parse(body),
      ),
    };
  }
  @Get('projects/:id/invitations') async list(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.organization!.admission.list(await this.s.auth.current(req), id) };
  }
  @Post('projects/:id/invitations/:invitation/revoke') async revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('invitation') invitation: string,
  ) {
    return {
      data: await this.s.organization!.admission.revoke(
        await this.s.auth.current(req, true),
        id,
        invitation,
      ),
    };
  }
  @Post('team-invitations/preview') async preview(@Req() req: Request, @Body() body: unknown) {
    originCheck(req, this.s.config);
    const input = teamTokenSchema.parse(body);
    await identityRateLimit(this.s.db, 'invite-preview', req.ip || 'unknown', 60);
    return { data: await this.s.organization!.admission.preview(input.token) };
  }
  @Post('team-invitations/accept') async accept(@Req() req: Request, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    const input = teamTokenSchema.parse(body);
    await identityRateLimit(this.s.db, 'invite-accept', user.id, 30);
    return { data: await this.s.organization!.admission.accept(user, input.token) };
  }
}
