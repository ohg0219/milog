import { getSSOTokenFromFile } from '@smithy/shared-ini-file-loader';
import { makeProvider } from './credentials.js';
import { isSsoExpiry } from '../util/errors.js';

// SDK 가 토큰을 만료로 치는 여유(5분)와 맞춘다. 이보다 늦게 잡으면 확인은 통과하고
// 첫 조회에서 만료가 난다.
const EXPIRY_WINDOW_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 프로필을 로그인 단위로 묶는다.
 *
 * 로그인은 프로필이 아니라 세션 단위다 — 같은 sso_session 의 프로필은 한 번에 풀린다.
 * sso_session 이 없는 옛 형식은 토큰 캐시 키가 sso_start_url 이라 그걸로 묶는다.
 */
export function groupBySession(profiles) {
  const map = new Map();
  for (const p of profiles) {
    if (!p.isSso) continue;
    const key = p.ssoSession || p.ssoStartUrl;
    if (!key) continue;
    const g = map.get(key) ?? { key, ssoSession: p.ssoSession, profile: p, count: 0 };
    g.count += 1;
    map.set(key, g);
  }
  return [...map.values()];
}

export const sessionLabel = (g) => g.ssoSession || g.profile.name;

export const loginCommand = (g) => (g.ssoSession
  ? `aws sso login --sso-session ${g.ssoSession}`
  : `aws sso login --profile ${g.profile.name}`);

/** 실제로 자격증명을 받아 본다. 네트워크가 안 되면 막지 않고 'unknown' 으로 넘긴다. */
async function probeLive(profile) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'unknown' }), PROBE_TIMEOUT_MS);
  });
  const attempt = makeProvider(profile.name)().then(
    () => ({ state: 'valid' }),
    (err) => ({ state: isSsoExpiry(err) ? 'expired' : 'unknown' }),
  );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 세션 하나의 로그인 상태. state: valid / expired / unknown.
 *
 * 먼저 ~/.aws/sso/cache 의 토큰만 본다 — 대부분 여기서 끝나고 네트워크를 안 탄다.
 * 액세스 토큰은 1시간이면 만료되지만 refreshToken 으로 조용히 갱신되므로, 파일의
 * expiresAt 이 지났다고 바로 만료라 하면 대부분 오탐이다. 그때만 실제로 받아 본다.
 */
export async function checkSession(g, {
  readToken = getSSOTokenFromFile, probe = probeLive, now = Date.now,
} = {}) {
  let token;
  try {
    token = await readToken(g.key);
  } catch {
    return { ...g, state: 'expired' }; // 캐시 파일이 없다 — 한 번도 로그인 안 했거나 로그아웃했다
  }
  const exp = Date.parse(token?.expiresAt ?? '');
  if (Number.isFinite(exp) && exp - EXPIRY_WINDOW_MS > now()) return { ...g, state: 'valid', expiresAt: exp };
  if (!token?.refreshToken) return { ...g, state: 'expired', expiresAt: Number.isFinite(exp) ? exp : undefined };
  return { ...g, ...(await probe(g.profile)) };
}

export const checkSsoSessions = (profiles, deps) =>
  Promise.all(groupBySession(profiles).map((g) => checkSession(g, deps)));
