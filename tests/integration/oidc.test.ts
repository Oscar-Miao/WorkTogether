import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/api/src/application.js';

test('OIDC 验证 PKCE、浏览器 state、签名与 nonce，并且只连接已存在的团队账号', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'fixture-key';
  jwk.alg = 'ES256';
  let issuer = '',
    mode: 'valid' | 'nonce' | 'unknown' = 'valid';
  const grants = new Map<string, { nonce: string; challenge: string }>();
  const provider = createServer(async (req, res) => {
    const json = (v: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(v));
    };
    if (req.url === '/.well-known/openid-configuration') {
      json({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
      });
      return;
    }
    if (req.url === '/jwks') {
      json({ keys: [jwk] });
      return;
    }
    if (req.url === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw),
        grant = grants.get(body.get('code') || '');
      if (
        !grant ||
        createHash('sha256')
          .update(body.get('code_verifier') || '')
          .digest('base64url') !== grant.challenge
      ) {
        res.writeHead(403);
        json({ error: 'invalid_grant' });
        return;
      }
      const token = await new SignJWT({
        email: mode === 'unknown' ? 'outsider@example.invalid' : 'oidc@team.test',
        email_verified: true,
        nonce: mode === 'nonce' ? 'wrong-nonce' : grant.nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' })
        .setSubject(mode === 'unknown' ? 'unknown-subject' : 'fixture-subject')
        .setIssuer(issuer)
        .setAudience('fixture-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      json({ id_token: token });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  issuer = 'http://127.0.0.1:' + (provider.address() as any).port;
  vi.stubEnv('OIDC_ISSUER', issuer);
  vi.stubEnv('OIDC_CLIENT_ID', 'fixture-client');
  vi.stubEnv('OIDC_CLIENT_SECRET', '');
  vi.stubEnv('COORDINATOR_ENABLED', 'false');
  await mkdir('.local/reports/oidc', { recursive: true });
  const dataDir = await mkdtemp(resolve('.local/reports/oidc/run-'));
  const app = await createApplication({
    dataDir,
    databaseUrl: undefined,
    ownerEmail: 'oidc@team.test',
    ownerPassword: 'OIDC-test-' + randomUUID(),
    production: false,
    webOrigin: 'http://127.0.0.1:5173',
  });
  await app.app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.app.getHttpServer().address().port;
  async function start() {
    const r = await fetch(base + '/api/v3/auth/oidc/start', { redirect: 'manual' });
    expect(r.status).toBe(302);
    const target = new URL(r.headers.get('location')!);
    const state = target.searchParams.get('state')!;
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    grants.set(state, {
      nonce: target.searchParams.get('nonce')!,
      challenge: target.searchParams.get('code_challenge')!,
    });
    return { state, cookie: r.headers.get('set-cookie')!.split(';')[0] };
  }
  async function callback(login: { state: string; cookie: string }, cookie = login.cookie) {
    return fetch(
      base + '/api/v3/auth/oidc/callback?state=' + login.state + '&code=' + login.state,
      { redirect: 'manual', headers: { Cookie: cookie } },
    );
  }
  try {
    const first = await start();
    const success = await callback(first);
    expect(success.status).toBe(302);
    const cookie = success.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(base + '/api/v2/bootstrap', { headers: { Cookie: cookie } })).status).toBe(
      200,
    );
    expect((await callback(first)).status).toBe(403);
    const second = await start();
    expect((await callback(second, 'ta_oidc_state=other-browser')).status).toBe(403);
    mode = 'nonce';
    const badNonce = await callback(second);
    expect(badNonce.status).toBe(403);
    expect(JSON.stringify(await badNonce.json())).toContain('OIDC_NONCE_DENIED');
    mode = 'unknown';
    const third = await start();
    const outsider = await callback(third);
    expect(outsider.status).toBe(403);
    expect(JSON.stringify(await outsider.json())).toContain('OIDC_ACCOUNT_REQUIRED');
    expect((await app.services.db.query('SELECT count(*)::int AS n FROM users'))[0].n).toBe(1);
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    vi.unstubAllEnvs();
  }
}, 60000);
