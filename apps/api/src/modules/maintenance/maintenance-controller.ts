import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';

const cleanupSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
});
const holdSchema = cleanupSchema.extend({ hold: z.boolean() });

@Controller('api/v1/tasks')
export class MaintenanceController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get(':id/retention')
  async preview(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.s.maintenance.preview(await this.s.auth.current(req), id) };
  }
  @Post(':id/retention-hold')
  async hold(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.maintenance.hold(
        await this.s.auth.current(req, true),
        id,
        holdSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
  @Post(':id/cleanup')
  async clean(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return {
      data: await this.s.maintenance.clean(
        await this.s.auth.current(req, true),
        id,
        cleanupSchema.parse(body),
        req.get('idempotency-key'),
      ),
    };
  }
}
