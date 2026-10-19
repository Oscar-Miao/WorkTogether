import { Body, Controller, Get, Post, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  groupSchema,
  chatMessageSchema,
  policySchema,
  goalReviewSchema,
  z,
} from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
@Controller('api/v2')
export class ChatController {
  constructor(@Inject(SERVICES) private s: Services) {}
  @Get('bootstrap')
  async bootstrap(@Req() req: Request) {
    const user = await this.s.auth.current(req);
    const [groups, devices, policy, sources, memories] = await Promise.all([
      this.s.groups.list(user),
      this.s.devices.list(),
      this.s.coordinator.policy(),
      this.s.history.sources(user, { limit: 100 }),
      this.s.history.memories({ limit: 100 }),
    ]);
    return {
      data: {
        user,
        project: this.s.project
          ? { ...this.s.project, role: user.role === 'OWNER' ? 'admin' : 'member' }
          : {
              id: 'project_default',
              name: '共域协作项目',
              workspace: '共域研发空间',
            },
        groups,
        devices,
        policy: policy.policy,
        policy_version: policy.version,
        leadership: await this.s.execution.leadership(),
        coordinator: {
          engine: this.s.coordinator.model.configured ? 'model' : 'rules',
          model_configured: this.s.coordinator.model.configured,
        },
        sources: sources.items,
        memories: memories.items,
      },
    };
  }
  @Get('groups')
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const user = await this.s.auth.current(req);
    return {
      data: await this.s.groups.list(
        user,
        query.discover === 'true',
        z.coerce.number().int().min(0).max(10000).default(0).parse(query.offset),
        z.string().max(100).default('').parse(query.q),
      ),
    };
  }
  @Post('groups')
  async create(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.groups.create(
        await this.s.auth.current(req, true),
        groupSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Post('group-invites/join')
  async joinInvite(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.groups.joinInvite(
        await this.s.auth.current(req, true),
        z
          .object({ token: z.string().min(16).max(200) })
          .strict()
          .parse(body).token,
      ),
    };
  }
  @Post('groups/:id/join')
  async join(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.groups.join(await this.s.auth.current(req, true), id) };
  }
  @Post('groups/:id/invites')
  async invite(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.groups.invite(await this.s.auth.current(req, true), id) };
  }
  @Get('groups/:id/feed')
  async feed(@Req() req: Request, @Param('id') id: string, @Query('before') before?: string) {
    return {
      data: await this.s.groups.feed(
        await this.s.auth.current(req),
        id,
        before ? z.coerce.number().int().positive().parse(before) : undefined,
      ),
    };
  }
  @Post('groups/:id/messages')
  async message(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.groups.post(
        await this.s.auth.current(req, true),
        id,
        chatMessageSchema.parse(body),
      ),
    };
  }
  @Post('groups/:id/retry-observation')
  async retry(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.coordinator.retry(await this.s.auth.current(req, true), id) };
  }
  @Get('goals/:id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.coordinator.detail(await this.s.auth.current(req), id) };
  }
  @Post('goals/:id/claim')
  async claim(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const v = z.object({ version: z.number().int().positive() }).strict().parse(body);
    return {
      data: await this.s.coordinator.claim(await this.s.auth.current(req, true), id, v.version),
    };
  }
  @Post('goals/:id/complete')
  async complete(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const v = z
      .object({
        version: z.number().int().positive(),
        evidence: z.string().trim().min(4).max(1000),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.coordinator.complete(
        await this.s.auth.current(req, true),
        id,
        v.version,
        v.evidence,
      ),
    };
  }
  @Post('goals/:id/review')
  async review(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.coordinator.review(
        await this.s.auth.current(req, true),
        id,
        goalReviewSchema.parse(body),
      ),
    };
  }
  @Post('goals/:id/stop')
  async stop(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({ reason: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(body);
    return {
      data: await this.s.coordinator.stop(
        await this.s.auth.current(req, true),
        id,
        input.reason,
        req.get('idempotency-key') || '',
      ),
    };
  }
  @Post('node-policy')
  async policy(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.coordinator.setPolicy(
        await this.s.auth.current(req, true),
        policySchema.parse(body),
      ),
    };
  }
  @Get('events')
  async events(@Req() req: Request, @Res() res: Response) {
    await this.s.auth.current(req);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let closed = false;
    const refresh = () => {
      if (!closed) res.write('event: refresh\ndata: {}\n\n');
    };
    this.s.tasks.changes.on('all', refresh);
    const timer = setInterval(() => {
      void this.s.auth
        .current(req)
        .then(() => res.write(': keepalive\n\n'))
        .catch(() => res.end());
    }, 10000);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
      this.s.tasks.changes.off('all', refresh);
    });
    refresh();
  }
}
