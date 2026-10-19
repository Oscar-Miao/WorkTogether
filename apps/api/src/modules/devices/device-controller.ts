import { Body, Controller, Get, Inject, Param, Post, Req, Query } from '@nestjs/common';
import type { Request } from 'express';
import {
  pairSchema,
  repositoriesSchema,
  z,
  bridgeMessageSchema,
  executionResultSchema,
} from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
@Controller()
export class DeviceController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  @Get('api/v1/devices')
  async devices(@Req() req: Request) {
    await this.s.auth.current(req);
    return { data: await this.s.devices.list() };
  }
  @Post('api/v1/pairing-codes')
  async code(@Req() req: Request) {
    return { data: await this.s.devices.pairingCode(await this.s.auth.current(req, true)) };
  }
  @Post('api/v1/devices/pair')
  async pair(@Body() body: unknown) {
    return { data: await this.s.devices.pair(pairSchema.parse(body)) };
  }
  @Post('api/v1/devices/:id/revoke')
  async revoke(@Req() req: Request, @Param('id') id: string) {
    await this.s.devices.revoke(await this.s.auth.current(req, true), id);
    this.s.gateway.disconnect(id);
    return { data: { ok: true } };
  }
  @Post('bridge/v1/challenges')
  async challenge(@Body() body: unknown) {
    const input = z
      .object({ device_id: z.string().max(100) })
      .strict()
      .parse(body);
    return { data: await this.s.devices.challenge(input.device_id) };
  }
  @Post('bridge/v1/tokens')
  async token(@Body() body: unknown) {
    const input = z
      .object({
        device_id: z.string().max(100),
        challenge_id: z.string().max(100),
        signature: z.string().max(200),
      })
      .strict()
      .parse(body);
    return { data: await this.s.devices.token(input) };
  }
  @Post('bridge/v1/stop-challenges')
  async stopChallenge(@Body() body: unknown) {
    const input = z
      .object({ device_id: z.string().max(100), attempt_id: z.string().max(100) })
      .strict()
      .parse(body);
    return { data: await this.s.devices.stopChallenge(input.device_id, input.attempt_id) };
  }
  @Post('bridge/v1/attempts/:id/stop-receipt')
  async stopReceipt(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        device_id: z.string().max(100),
        challenge_id: z.string().max(100),
        signature: z.string().max(200),
        result: executionResultSchema,
        stop_evidence: z.string().min(1).max(2000),
      })
      .strict()
      .parse(body);
    const deviceId = await this.s.devices.verifyStopReceipt({ ...input, attempt_id: id });
    await this.s.tasks.finish(deviceId, id, input.result, input.stop_evidence);
    return { data: { ok: true } };
  }
  @Post('bridge/v1/repositories')
  async repositories(@Req() req: Request, @Body() body: unknown) {
    const device = await this.s.devices.authenticate(this.bearer(req));
    const input = repositoriesSchema.parse(body);
    await this.s.devices.setRepositories(device.id, input.repositories);
    return { data: { ok: true } };
  }
  @Post('bridge/v1/attempts/:id/lease')
  async lease(@Req() req: Request, @Param('id') id: string) {
    const device = await this.s.devices.authenticate(this.bearer(req));
    return { data: await this.s.tasks.lease(device.id, id) };
  }
  @Post('bridge/v1/attempts/:id/finish')
  async finish(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const device = await this.s.devices.authenticate(this.bearer(req));
    const input = bridgeMessageSchema.parse({
      ...(body as object),
      type: 'finished',
      attempt_id: id,
    });
    if (input.type !== 'finished') throw new Error('Invalid finish');
    await this.s.tasks.finish(device.id, id, input.result, input.stop_evidence);
    return { data: { ok: true } };
  }
  @Get('bridge/v1/attempts/:id/context/:sourceId')
  async context(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('sourceId') sourceId: string,
    @Query('offset') offset?: string,
  ) {
    return {
      data: await this.s.contextReader.read(
        this.bearer(req),
        id,
        sourceId,
        offset === undefined ? 0 : Number(offset),
      ),
    };
  }
  private bearer(req: Request) {
    return req.get('authorization')?.replace(/^Bearer /, '');
  }
}
