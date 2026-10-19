import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServices } from './container.js';
import type { ApiConfig } from './config/config.js';
import { SERVICES } from './common/tokens.js';
import { ApiFilter } from './common/api-filter.js';
import { ids } from './common/security.js';
import { AuthController } from './modules/auth/auth-controller.js';
import { AuthService } from './modules/auth/auth-service.js';
import { AdmissionController } from './modules/organization/admission-controller.js';
import { CollaborationController } from './modules/conversations/collaboration-controller.js';
import { TaskController } from './modules/tasks/task-controller.js';
import { DeviceController } from './modules/devices/device-controller.js';

import { ChatController } from './modules/chat/chat-controller.js';
import { MaintenanceController } from './modules/maintenance/maintenance-controller.js';

import { OidcController } from './modules/auth/oidc-controller.js';
import { OidcService } from './modules/auth/oidc-service.js';
import { OrganizationService } from './modules/organization/organization-service.js';
import { OrganizationController } from './modules/organization/organization-controller.js';
import { AdvancedController } from './modules/advanced/advanced-controller.js';
import { scopedServices, requestScope } from './modules/organization/request-scope.js';
import { DomainError } from '@team-agent/domain';

export async function createApplication(overrides: Partial<ApiConfig> = {}) {
  const services = await createServices(overrides);
  services.oidc = new OidcService(services.db, services.auth, services.config);
  const organization = new OrganizationService(services);
  await organization.initialize();
  // 根身份接口不要求团队资格；默认项目业务接口同样逐请求校验显式成员关系。
  const defaultProjectAuth = new AuthService(
    services.db,
    services.config,
    async (req, mutation) => {
      const user = await services.auth.current(req, mutation);
      const scope = await organization.membership(user, 'project_default');
      return { ...user, role: scope.role === 'admin' ? 'OWNER' : 'MEMBER' };
    },
  );
  // 只替换身份边界，不复制服务对象；动态策略和维护服务仍使用当前实例。
  const defaultProjectServices = new Proxy(services, {
    get(target, property) {
      return property === 'auth' ? defaultProjectAuth : Reflect.get(target, property);
    },
  });
  const routed = scopedServices(services);
  @Module({
    controllers: [
      AuthController,
      OrganizationController,
      AdmissionController,
      OidcController,
      AdvancedController,
      ChatController,
      CollaborationController,
      TaskController,
      DeviceController,
      MaintenanceController,
    ],
    providers: [{ provide: SERVICES, useValue: routed }],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', services.config.production ? 1 : false);
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  // 路径选择的是服务实例，权限仍由根身份和项目成员关系逐请求验证。
  app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const match = /^\/p\/(prj_[a-zA-Z0-9]+)(\/(?:api\/v[12]|bridge\/v1)(?:\/.*)?)$/.exec(req.url);
    if (!req.url.startsWith('/p/')) {
      const identity =
        /^\/api\/v1\/(auth(?:\/|$)|me(?:\?|$)|invitations\/accept(?:\?|$)|health(?:\?|$)|devices\/pair(?:\?|$))/.test(
          req.url,
        );
      if (/^\/api\/v[12]\//.test(req.url) && !identity) {
        try {
          await organization.membership(await services.auth.current(req), 'project_default');
          requestScope.run(defaultProjectServices, next);
        } catch (error) {
          const e = error as DomainError;
          res.status(e.status || 500).json({
            error: {
              code: e.code || 'PROJECT_UNAVAILABLE',
              message: e instanceof DomainError ? e.message : '项目暂不可用',
            },
          });
        }
      } else next();
      return;
    }
    if (!match) {
      res.status(404).json({ error: { code: 'PROJECT_UNAVAILABLE', message: '项目路径不可用' } });
      return;
    }
    // 项目数据库只保存镜像身份；禁止在项目路径下另建账号或签发旧开户邀请。
    if (/^\/api\/v1\/(auth|invitations)(?:\/|$)/.test(match[2])) {
      res
        .status(404)
        .json({ error: { code: 'IDENTITY_ROOT_REQUIRED', message: '账号操作请使用统一登录入口' } });
      return;
    }
    try {
      const pairing = req.method === 'POST' && match[2] === '/api/v1/devices/pair';
      if (match[2].startsWith('/api/') && !pairing)
        await organization.membership(await services.auth.current(req), match[1]);
      const scoped = await organization.open(match[1]);
      req.url = match[2];
      requestScope.run(scoped, next);
    } catch (error) {
      const e = error as DomainError;
      res.status(e.status || 500).json({
        error: {
          code: e.code || 'PROJECT_UNAVAILABLE',
          message: e instanceof DomainError ? e.message : '项目暂不可用',
        },
      });
    }
  });
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const requestId = ids('req');
    res.setHeader('X-Request-ID', requestId);
    const json = res.json.bind(res);
    res.json = (body: unknown) =>
      json(body && typeof body === 'object' ? { ...body, request_id: requestId } : body);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/') || req.path.startsWith('/bridge/'))
      res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: services.config.webOrigin,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'X-CSRF-Token',
      'Idempotency-Key',
      'Last-Event-ID',
      'If-Match',
    ],
  });
  app.useGlobalFilters(new ApiFilter(services.db));
  const webDist = resolve(services.config.projectRoot, 'apps/web/dist');
  if (existsSync(webDist)) app.use(express.static(webDist, { index: 'index.html' }));
  await app.init();
  organization.attach(app.getHttpServer());
  services.gateway.attach(app.getHttpServer());
  return {
    app,
    services,
    close: async () => {
      await organization.close();
      await services.execution.close();
      await services.coordinator.close();
      services.gateway.close();
      await services.maintenance.stop();
      await app.close();
      await services.db.close();
    },
  };
}
