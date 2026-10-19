import { Controller, Get, Post, Body, Param, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { z } from '@team-agent/contracts';
import { SERVICES } from '../../common/tokens.js';
import type { Services } from '../../container.js';

@Controller('api/v3')
export class OrganizationController {
  constructor(@Inject(SERVICES) private s: Services) {}
  @Get('projects') async list(@Req() req: Request) {
    return { data: await this.s.organization!.list(await this.s.auth.current(req)) };
  }
  @Get('workspaces') async workspaces(@Req() req: Request) {
    return { data: await this.s.organization!.workspaces(await this.s.auth.current(req)) };
  }
  @Post('workspaces') async workspace(@Req() req: Request, @Body() body: unknown) {
    const v = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(body);
    return {
      data: await this.s.organization!.createWorkspace(
        await this.s.auth.current(req, true),
        v.name,
      ),
    };
  }
  @Post('workspaces/:id/projects') async project(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(body);
    return {
      data: await this.s.organization!.createProject(
        await this.s.auth.current(req, true),
        id,
        v.name,
      ),
    };
  }
  @Get('projects/:id/members') async members(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.organization!.members(await this.s.auth.current(req), id) };
  }
  @Post('projects/:id/members') async add(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({
        email: z.string().email(),
        role: z.enum(['admin', 'operator', 'member']).default('member'),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.organization!.addMember(
        await this.s.auth.current(req, true),
        id,
        v.email,
        v.role,
      ),
    };
  }
  @Post('projects/:id/members/:userId/remove') async remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return {
      data: await this.s.organization!.removeMember(
        await this.s.auth.current(req, true),
        id,
        userId,
      ),
    };
  }
}
