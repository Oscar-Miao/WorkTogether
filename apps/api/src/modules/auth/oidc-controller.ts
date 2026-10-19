import { Controller, Get, Inject, Req, Res, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from '@team-agent/contracts';
import type { Services } from '../../container.js';
import { SERVICES } from '../../common/tokens.js';
@Controller('api/v3/auth/oidc')
export class OidcController {
  constructor(@Inject(SERVICES) private s: Services) {}
  @Get('status') status() {
    return { data: { enabled: this.s.oidc?.enabled || false } };
  }
  @Get('start') async start(@Res() res: Response) {
    await this.s.oidc!.start(res);
  }
  @Get('callback') async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') state: string,
    @Query('code') code: string,
  ) {
    await this.s.oidc!.callback(
      req,
      res,
      z.string().min(16).max(200).parse(state),
      z.string().min(1).max(4000).parse(code),
    );
  }
}
