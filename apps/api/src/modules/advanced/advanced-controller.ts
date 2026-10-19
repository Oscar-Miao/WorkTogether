import { Body, Controller, Get, Post, Param, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import {
  z,
  relationSchema,
  revisionSchema,
  planSchema,
  groupAgentPolicySchema,
} from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';

@Controller('api/v2')
export class AdvancedController {
  constructor(@Inject(SERVICES) private s: Services) {}
  @Post('groups/:id/lifecycle') async lifecycle(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        action: z.enum([
          'archive',
          'restore',
          'leave',
          'remove_member',
          'fork',
          'transfer_manager',
        ]),
        cutoff_seq: z.number().int().nonnegative().optional(),
        title: z.string().trim().min(1).max(100).optional(),
        reason: z.string().min(1).max(1000).optional(),
        user_id: z.string().max(100).optional(),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.advanced.groupAction(await this.s.auth.current(req, true), id, input),
    };
  }
  @Post('groups/:id/forks') async fork(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({
        cutoff_seq: z.number().int().nonnegative(),
        title: z.string().min(1).max(100),
        reason: z.string().min(1).max(1000),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.advanced.groupAction(await this.s.auth.current(req, true), id, {
        ...v,
        action: 'fork',
      }),
    };
  }
  @Post('groups/:id/agent-policy') async policy(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.s.advanced.policy(
        await this.s.auth.current(req, true),
        id,
        groupAgentPolicySchema.parse(body),
      ),
    };
  }
  @Post('groups/:id/read') async read(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z.object({ seq: z.number().int().nonnegative() }).strict().parse(body);
    return { data: await this.s.advanced.read(await this.s.auth.current(req, true), id, v.seq) };
  }
  @Get('coordination/coverage') async coverage(@Req() req: Request) {
    return { data: await this.s.advanced.coverage(await this.s.auth.current(req)) };
  }
  @Get('coordination/search') async search(@Req() req: Request, @Query('q') q: string) {
    return {
      data: await this.s.advanced.search(
        await this.s.auth.current(req),
        z.string().min(1).max(100).parse(q),
      ),
    };
  }
  @Get('coordination/events') async events(@Req() req: Request, @Query('after') after?: string) {
    return {
      data: await this.s.advanced.events(
        await this.s.auth.current(req),
        z.coerce.number().int().nonnegative().default(0).parse(after),
      ),
    };
  }
  @Get('goals/:id/coordination') async detail(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.advanced.detail(await this.s.auth.current(req), id) };
  }
  @Post('goals/:id/relations') async relation(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.s.advanced.relation(
        await this.s.auth.current(req, true),
        id,
        relationSchema.parse(body),
      ),
    };
  }
  @Post('goals/:id/handoffs') async handoff(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        to_user: z.string().min(1).max(100),
        note: z.string().trim().min(4).max(2000),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(body);
    return { data: await this.s.advanced.handoff(await this.s.auth.current(req, true), id, input) };
  }
  @Post('handoffs/:id/resolve') async resolve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z.object({ accept: z.boolean() }).strict().parse(body);
    return {
      data: await this.s.advanced.resolveHandoff(
        await this.s.auth.current(req, true),
        id,
        v.accept,
      ),
    };
  }
  @Post('goals/:id/revisions') async revision(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.s.advanced.revision(
        await this.s.auth.current(req, true),
        id,
        revisionSchema.parse(body),
      ),
    };
  }
  @Post('goals/:id/merge-proposals') async merge(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({
        target_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        target_version: z.number().int().positive(),
        reason: z.string().trim().min(4).max(2000),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.advanced.merge(
        await this.s.auth.current(req, true),
        id,
        v.target_id,
        v.expected_version,
        v.target_version,
        v.reason,
      ),
    };
  }
  @Get('governance/metrics') async metrics(@Req() req: Request) {
    return { data: await this.s.governance.metrics(await this.s.auth.current(req)) };
  }
  @Get('governance/audit') async audit(@Req() req: Request, @Query('after') after?: string) {
    return {
      data: await this.s.governance.auditLog(
        await this.s.auth.current(req),
        z.coerce.number().int().nonnegative().default(0).parse(after),
      ),
    };
  }
  @Post('artifacts/:id/validity') async validity(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({
        state: z.enum(['valid', 'stale', 'unverified']),
        reason: z.string().trim().min(4).max(1000),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.governance.validity(
        await this.s.auth.current(req, true),
        id,
        v.state,
        v.reason,
      ),
    };
  }
  @Get('execution/control') async control(@Req() req: Request) {
    await this.s.auth.current(req);
    return {
      data: {
        limits: await this.s.execution.limits(),
        leadership: await this.s.execution.leadership(),
      },
    };
  }
  @Post('execution/limits') async limits(@Req() req: Request, @Body() body: unknown) {
    const v = z
      .object({
        devices: z.number().int().min(1).max(10),
        parallel: z.number().int().min(1).max(10),
      })
      .strict()
      .parse(body);
    return {
      data: await this.s.execution.setLimits(
        await this.s.auth.current(req, true),
        v.devices,
        v.parallel,
      ),
    };
  }
  @Post('execution/node-binding') async binding(@Req() req: Request, @Body() body: unknown) {
    const v = z
      .object({ node_id: z.string().min(1), expected_epoch: z.number().int().positive() })
      .strict()
      .parse(body);
    return {
      data: await this.s.execution.bind(
        await this.s.auth.current(req, true),
        v.node_id,
        v.expected_epoch,
      ),
    };
  }
  @Post('goals/:id/plans') async plan(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.s.execution.createPlan(
        await this.s.auth.current(req, true),
        id,
        planSchema.parse(body),
      ),
    };
  }
  @Post('plans/:id/verify') async verify(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({ evidence: z.string().trim().min(8).max(2000) })
      .strict()
      .parse(body);
    return {
      data: await this.s.execution.verify(await this.s.auth.current(req, true), id, v.evidence),
    };
  }
  @Get('evaluations/coordination') async evaluations(@Req() req: Request) {
    return { data: await this.s.advanced.evaluations(await this.s.auth.current(req)) };
  }
  @Post('evaluations/coordination') async evaluate(@Req() req: Request, @Body() body: unknown) {
    const v = z
      .object({
        conversation_id: z.string().min(1),
        kind: z.enum(['duplicate', 'context', 'review', 'noise']),
        synthetic: z.boolean(),
        expected: z.string().min(1).max(100),
        actual: z.string().min(1).max(100),
        note: z.string().max(4000),
      })
      .strict()
      .parse(body);
    return { data: await this.s.advanced.evaluate(await this.s.auth.current(req, true), v) };
  }
}
