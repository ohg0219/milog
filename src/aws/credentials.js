import { spawn } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-providers';
import { isSsoExpiry, MilogError } from '../util/errors.js';
import { ui } from '../util/out.js';

/**
 * fromIni 를 쓴다 (fromNodeProviderChain 아님).
 *
 * 체인은 AWS_ACCESS_KEY_ID/AWS_SESSION_TOKEN 환경변수를 먼저 본다. 사용자가 셸에
 * 남겨둔 낡은 키가 있으면 메뉴에서 고른 프로필을 조용히 덮어써서, 엉뚱한 계정에
 * 물어보고 AccessDenied 를 받는다. 원인을 찾기 거의 불가능한 부류의 사고다.
 * fromIni 는 프로필이 선언한 방식(sso_session / source_profile / credential_process)을
 * 그대로 따르고 환경변수는 무시한다.
 */
export const makeProvider = (profile) => fromIni({ profile, ignoreCache: true });

const SAFE_PROFILE = /^[\w.@+=/#:-]+$/;

export function awsSsoLogin(profileName, ssoSession) {
  // sso_session 이 있으면 세션 단위로 로그인한다 — 같은 세션의 프로필들이 한 번에 풀린다.
  const args = ssoSession
    ? ['sso', 'login', '--sso-session', ssoSession]
    : ['sso', 'login', '--profile', profileName];

  for (const a of args) {
    if (!SAFE_PROFILE.test(a) && !a.startsWith('--') && a !== 'sso' && a !== 'login') {
      return Promise.resolve({ ok: false, code: -1, unsafe: true });
    }
  }

  return new Promise((resolve) => {
    const child = spawn('aws', args, {
      stdio: 'inherit', // 브라우저 인증 코드를 보여주려면 TTY 를 그대로 넘겨야 한다
      shell: process.platform === 'win32', // aws.cmd 를 PATHEXT 로 찾으려면 필요
    });
    child.on('error', () => resolve({ ok: false, code: -1, spawnFailed: true }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/**
 * 자격증명 해석. 만료면 aws sso login 을 한 번만 시도하고 재시도한다.
 * 반환된 provider 는 클라이언트에 그대로 넘겨 자동 갱신을 태운다.
 */
export async function resolveCredentials(profile, { autoLogin = true } = {}) {
  let provider = makeProvider(profile.name);
  try {
    return { credentials: await provider(), provider };
  } catch (err) {
    if (!autoLogin || !isSsoExpiry(err)) throw err;

    ui.warn(`자격증명이 만료되었습니다 → aws sso login (${profile.ssoSession || profile.name})`);
    ui.dim(String(err.message).split('\n')[0]);

    const r = await awsSsoLogin(profile.name, profile.ssoSession);
    if (r.spawnFailed) {
      throw new MilogError('aws CLI 를 찾을 수 없어 SSO 로그인을 할 수 없습니다.', {
        exitCode: 3,
        hint: `AWS CLI v2 를 설치하거나 먼저 실행하세요: aws sso login --sso-session ${profile.ssoSession || profile.name}`,
      });
    }
    if (!r.ok) {
      throw new MilogError(`aws sso login 이 실패했습니다 (exit ${r.code}).`, { exitCode: 3 });
    }

    // 반드시 새로 만든다. fromIni 는 memoize 되고, smithy 의 파일 읽기도 경로별로
    // 프로세스 수명 동안 캐시된다 — 옛 provider 는 로그인 이전 상태를 그대로 준다.
    provider = makeProvider(profile.name);
    return { credentials: await provider(), provider };
  }
}

/**
 * 계정 ID.
 *
 * 이 SDK 버전의 SSO 자격증명 객체에는 accountId 가 없다(실측: accessKeyId,
 * secretAccessKey, sessionToken, expiration, $source 뿐). 그래서 우선순위는:
 *   1) DescribeLogGroups 가 준 로그 그룹 ARN 에서 뽑기 — 실제 API 가 말한 계정이라
 *      config 의 sso_account_id 보다 정확하고, 추가 호출도 STS 의존성도 없다
 *   2) 자격증명 객체 (미래 SDK 가 채워줄 경우)
 *   3) config 의 sso_account_id
 */
export function accountIdFrom(credentials, profile, groups = []) {
  const fromArn = groups.map((g) => String(g.arn ?? '').split(':')[4]).find((a) => /^\d{12}$/.test(a));
  if (fromArn) return { accountId: fromArn, source: 'arn' };

  const fromCreds = credentials?.accountId;
  if (/^\d{12}$/.test(String(fromCreds ?? ''))) return { accountId: fromCreds, source: 'credentials' };

  if (/^\d{12}$/.test(String(profile?.accountId ?? ''))) {
    return { accountId: profile.accountId, source: 'config' };
  }
  throw new MilogError('계정 ID 를 알아낼 수 없습니다.', {
    hint: '프로필에 sso_account_id 가 있는지 확인하세요.',
  });
}
