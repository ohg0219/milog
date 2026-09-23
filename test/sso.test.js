import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBySession, checkSession, loginCommand } from '../src/aws/sso.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
const p = (name, extra) => ({ name, isSso: true, ssoSession: '', ssoStartUrl: '', ...extra });

test('같은 sso_session 의 프로필은 한 번만 확인한다', () => {
  const groups = groupBySession([
    p('a', { ssoSession: 's1' }),
    p('b', { ssoSession: 's1' }),
    p('c', { ssoStartUrl: 'https://x.awsapps.com/start' }),
    { name: 'static', isSso: false },
  ]);
  assert.equal(groups.length, 2, '정적 키 프로필은 빠져야 한다');
  assert.equal(groups[0].count, 2);
  assert.equal(loginCommand(groups[0]), 'aws sso login --sso-session s1');
  assert.equal(loginCommand(groups[1]), 'aws sso login --profile c', '옛 형식은 프로필로 로그인한다');
});

const [g] = groupBySession([p('a', { ssoSession: 's1' })]);
const noProbe = () => { throw new Error('네트워크를 타면 안 된다'); };

test('토큰이 살아 있으면 네트워크 없이 유효', async () => {
  const r = await checkSession(g, {
    now: () => NOW, probe: noProbe,
    readToken: async () => ({ expiresAt: new Date(NOW + HOUR).toISOString() }),
  });
  assert.equal(r.state, 'valid');
});

test('캐시 파일이 없으면 로그인 필요', async () => {
  const r = await checkSession(g, {
    now: () => NOW, probe: noProbe,
    readToken: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(r.state, 'expired');
});

test('만료 5분 전이면 이미 만료로 본다 — SDK 와 같은 여유', async () => {
  const r = await checkSession(g, {
    now: () => NOW, probe: noProbe,
    readToken: async () => ({ expiresAt: new Date(NOW + 60_000).toISOString() }),
  });
  assert.equal(r.state, 'expired');
});

/** 액세스 토큰은 1시간이면 만료된다. 파일만 보고 판정하면 거의 매번 오탐이다. */
test('만료됐어도 refreshToken 이 있으면 실제로 받아 보고 판정한다', async () => {
  let probed = 0;
  const r = await checkSession(g, {
    now: () => NOW,
    readToken: async () => ({ expiresAt: new Date(NOW - HOUR).toISOString(), refreshToken: 'r' }),
    probe: async () => { probed += 1; return { state: 'valid' }; },
  });
  assert.equal(probed, 1);
  assert.equal(r.state, 'valid');
});
