import { Body, Controller, Get, Inject, Param, Post, Req, Res, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { messageSchema, sourceSchema, memorySchema, z } from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
import { audit, owner } from '../../common/security.js';
import { pageRequest } from '../../common/pagination.js';
import { requireGroupAccess } from '../../common/group-access.js';
import { DomainError } from '@team-agent/domain';

@Controller('api/v1')
export class CollaborationController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get('health')
  health() {
    return { data: { status: 'ok', service: 'team-agent-api' } };
  }
  @Get('project')
  async project(@Req() req: Request) {
    await this.s.auth.current(req);
    return { data: this.projectData() };
  }
  @Get('bootstrap')
  async bootstrap(@Req() req: Request) {
    const user = await this.s.auth.current(req);
    const request = { limit: 20 };
    const [conversations, tasks, sources, memories, devices, stats] = await Promise.all([
      this.s.history.conversations(request, undefined, user),
      this.s.history.tasks(user, request),
      this.s.history.sources(user, request),
      this.s.history.memories(request),
      this.s.devices.list(),
      this.s.history.taskStats(user),
    ]);
    return {
      data: {
        user,
        project: this.projectData(),
        conversations: conversations.items,
        tasks: tasks.items,
        sources: sources.items,
        memories: memories.items,
        devices,
        task_stats: stats,
        pages: {
          conversations: conversations.pagination,
          tasks: tasks.pagination,
          sources: sources.pagination,
          memories: memories.pagination,
        },
      },
    };
  }
  @Get('conversations')
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const user = await this.s.auth.current(req);
    const page = await this.s.history.conversations(pageRequest(query), query.q, user);
    return { data: page.items, pagination: page.pagination };
  }
  @Post('conversations')
  async create(@Req() req: Request, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    const input = z
      .object({ title: z.string().trim().min(1).max(100) })
      .strict()
      .parse(body);
    return { data: await this.s.collaboration.createConversation(user, input.title) };
  }
  @Get('conversations/:id/messages')
  async messages(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const user = await this.s.auth.current(req);
    await requireGroupAccess(this.s.db, user, id);
    const page = await this.s.history.messages(id, pageRequest(query));
    return { data: page.items, pagination: page.pagination };
  }
  @Post('conversations/:id/messages')
  async message(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    const input = messageSchema.parse(body);
    await requireGroupAccess(this.s.db, user, id);
    return {
      data: await this.s.collaboration.postMessage(user, id, input.body, input.client_message_id),
    };
  }
  @Get('sources')
  async sources(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const page = await this.s.history.sources(
      await this.s.auth.current(req),
      pageRequest(query),
      query.visibility,
    );
    return { data: page.items, pagination: page.pagination };
  }
  @Get('sources/:id')
  async sourceDetail(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('version') version?: string,
  ) {
    const user = await this.s.auth.current(req);
    const number = z.coerce.number().int().positive().parse(version);
    return { data: await this.s.collaboration.source(user, id, number) };
  }
  @Post('sources')
  async source(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.collaboration.createSource(
        await this.s.auth.current(req, true),
        sourceSchema.parse(body),
      ),
    };
  }
  @Post('sources/:id/versions')
  async reviseSource(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const user = await this.s.auth.current(req, true);
    const { content, version } = sourceSchema
      .pick({ content: true })
      .extend({ version: z.number().int().positive() })
      .strict()
      .parse(body);
    return { data: await this.s.collaboration.reviseSource(user, id, content, version) };
  }
  @Get('memories')
  async memories(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.s.auth.current(req);
    const page = await this.s.history.memories(pageRequest(query), query.status);
    return { data: page.items, pagination: page.pagination };
  }
  @Post('memories')
  async memory(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.collaboration.createMemory(
        await this.s.auth.current(req, true),
        memorySchema.parse(body),
      ),
    };
  }
  @Post('memories/:id/confirm')
  async confirm(@Req() req: Request, @Param('id') id: string) {
    return {
      data: await this.s.collaboration.confirmMemory(await this.s.auth.current(req, true), id),
    };
  }
  @Post('memories/:id/deprecate')
  async deprecate(@Req() req: Request, @Param('id') id: string) {
    const user = await this.s.auth.current(req, true);
    owner(user);
    const rows = await this.s.db.query(
      "UPDATE memories SET status='deprecated',version=version+1 WHERE id=$1 RETURNING *",
      [id],
    );
    if (!rows.length) throw new DomainError('NOT_FOUND', '结论不存在', 404);
    await audit(this.s.db, user.id, 'memory.deprecate', id);
    return { data: rows[0] };
  }
  @Get('members')
  async members(@Req() req: Request) {
    const user = await this.s.auth.current(req);
    owner(user);
    return {
      data: await this.s.db.query(
        'SELECT id,email,name,role,active FROM project_users ORDER BY created_at',
      ),
    };
  }
  @Post('members/:id/remove')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const user = await this.s.auth.current(req, true);
    owner(user);
    // 团队维护者只能撤销本项目资格，不能注销他人的全站账号和其他团队会话。
    await this.s.organization!.removeMember(user, this.s.project?.id || 'project_default', id);
    return { data: { ok: true } };
  }
  @Get('audit')
  async auditLog(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const page = await this.s.history.audit(await this.s.auth.current(req), pageRequest(query));
    return { data: page.items, pagination: page.pagination };
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
    const refresh = () => res.write('event: refresh\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      void this.s.auth
        .current(req)
        .then(() => res.write(': keepalive\n\n'))
        .catch(() => res.end());
    }, 15000);
    this.s.tasks.changes.on('all', refresh);
    refresh();
    req.on('close', () => {
      clearInterval(heartbeat);
      this.s.tasks.changes.off('all', refresh);
    });
  }
  private projectData() {
    return {
      id: 'project_default',
      name: 'Agent 协作平台',
      workspace: '研发工作空间',
      database_mode: this.s.db.mode,
    };
  }
}
