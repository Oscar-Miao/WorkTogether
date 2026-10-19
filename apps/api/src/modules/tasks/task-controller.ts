import { Body, Controller, Get, Inject, Param, Post, Req, Res, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { approveSchema, reasonSchema, taskInputSchema } from '@team-agent/contracts';
import { pageRequest } from '../../common/pagination.js';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';

@Controller('api/v1/tasks')
export class TaskController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get()
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const page = await this.s.history.tasks(
      await this.s.auth.current(req),
      pageRequest(query),
      query,
    );
    return { data: page.items, pagination: page.pagination };
  }
  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    return {
      data: await this.s.tasks.create(
        await this.s.auth.current(req, true),
        taskInputSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.tasks.get(await this.s.auth.current(req), id) };
  }
  @Post(':id/revisions')
  async revise(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.tasks.revise(
        await this.s.auth.current(req, true),
        id,
        taskInputSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Post(':id/approve')
  async approve(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.tasks.approve(
        await this.s.auth.current(req, true),
        id,
        approveSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Post(':id/reject')
  async reject(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.s.tasks.reject(
      await this.s.auth.current(req, true),
      id,
      reasonSchema.parse(body).reason,
    );
    return { data: { ok: true } };
  }
  @Post(':id/cancel')
  async cancel(@Req() req: Request, @Param('id') id: string) {
    return {
      data: {
        state: await this.s.tasks.cancel(
          await this.s.auth.current(req, true),
          id,
          undefined,
          req.get('idempotency-key'),
        ),
      },
    };
  }
  @Post(':id/cancel-requests')
  async requestCancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.s.tasks.requestCancel(
      await this.s.auth.current(req, true),
      id,
      reasonSchema.parse(body).reason,
    );
    return { data: { ok: true } };
  }
  @Post(':id/reconcile')
  async reconcile(@Req() req: Request, @Param('id') id: string) {
    await this.s.tasks.reconcile(await this.s.auth.current(req, true), id);
    return { data: { ok: true } };
  }
  @Post(':id/artifacts/:aid/publish')
  async publish(@Req() req: Request, @Param('id') id: string, @Param('aid') aid: string) {
    return {
      data: await this.s.tasks.publish(
        await this.s.auth.current(req, true),
        id,
        aid,
        req.get('idempotency-key'),
      ),
    };
  }
  @Get(':id/events')
  async events(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    await this.s.auth.current(req);
    await this.s.tasks.get(await this.s.auth.current(req), id);
    let cursor = Number(req.get('last-event-id') || req.query.after || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let closed = false;
    let pending = Promise.resolve();
    const flush = () => {
      pending = pending
        .then(async () => {
          if (closed) return;
          const user = await this.s.auth.current(req);
          const events = await this.s.tasks.events(user, id, cursor);
          for (const event of events) {
            res.write('id: ' + event.id + '\nevent: task\ndata: ' + JSON.stringify(event) + '\n\n');
            cursor = event.id;
          }
        })
        .catch(() => {
          res.end();
        });
    };
    this.s.tasks.changes.on('all', flush);
    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
      flush();
    }, 15000);
    flush();
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      this.s.tasks.changes.off('all', flush);
    });
  }
}
