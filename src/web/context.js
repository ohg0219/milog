import { discoverProfiles, resolvePrefix, resolveRegion } from '../aws/profiles.js';
import { resolveCredentials } from '../aws/credentials.js';
import { createLogsClient, makeCounters } from '../aws/client.js';
import { listLogGroups, resolveGroupNames } from '../aws/groups.js';
import { MAX_GROUPS } from '../config.js';
import { MilogError, isSsoExpiry } from '../util/errors.js';

export async function findProfileExact(profileName) {
  const { profiles } = await discoverProfiles({ prefix: resolvePrefix(undefined) });
  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) throw new MilogError(`알 수 없는 프로필: ${profileName ?? '(없음)'}`, { exitCode: 400 });
  return profile;
}

/**
 * 프로필 → 자격증명 → 클라이언트 → 로그 그룹 목록까지. 그룹 '선택' 은 하지 않는다.
 * 브라우저가 목록을 받아 고르는 단계에서 쓴다.
 */
export async function buildBase({ profileName, region: flagRegion, refresh = false }) {
  const profile = await findProfileExact(profileName);
  const region = resolveRegion({ flagRegion, profile });

  let provider;
  let credentials;
  try {
    // autoLogin: false — 서버에는 TTY 가 없어 `aws sso login` 의 브라우저 인증 흐름을
    // 태울 수 없다. 만료되면 터미널에서 직접 하라고 안내한다.
    ({ provider, credentials } = await resolveCredentials(profile, { autoLogin: false }));
  } catch (err) {
    if (isSsoExpiry(err)) {
      throw new MilogError('자격증명이 만료되었습니다.', {
        exitCode: 401,
        hint: `터미널에서 먼저 실행하세요: aws sso login --sso-session ${profile.ssoSession || profile.name}`,
      });
    }
    throw err;
  }

  const counters = makeCounters();
  const client = createLogsClient({ region, profile: profile.name, credentials: provider, mode: 'oneshot', counters });
  const { groups: allGroups, cached, at } = await listLogGroups(client, { profile: profile.name, region, refresh });

  return { profile, region, credentials, provider, client, counters, allGroups, cached, at };
}

/**
 * 조회에 쓸 컨텍스트. buildContext 와 같은 모양이지만 **절대 묻지 않는다.**
 *
 * CLI 의 buildContext 는 프로필·그룹이 모호하면 readline 프롬프트를 띄운다. 서버에는
 * TTY 가 없으니 그 경로로 가면 안 되고, 브라우저가 목록에서 정확한 이름을 골라 보내므로
 * 모호할 일도 없다. 모호하면 400 으로 돌려보낸다.
 */
export async function buildWebContext({ profileName, region, groupNames = [], refresh = false }) {
  const base = await buildBase({ profileName, region, refresh });

  const { resolved, ambiguous } = resolveGroupNames(groupNames, base.allGroups);
  if (ambiguous.length) {
    throw new MilogError(`로그 그룹을 특정할 수 없습니다: ${ambiguous.map((a) => a.query).join(', ')}`, {
      exitCode: 400,
      hint: '브라우저에서 목록으로 고르세요.',
    });
  }
  if (!resolved.length) throw new MilogError('로그 그룹을 하나 이상 선택하세요.', { exitCode: 400 });
  if (resolved.length > MAX_GROUPS) {
    // FilterLogEvents API 상한이지 UI 취향이 아니다.
    throw new MilogError(`로그 그룹은 최대 ${MAX_GROUPS}개입니다 (선택 ${resolved.length}개).`, { exitCode: 400 });
  }

  return {
    ...base,
    groupNames: resolved,
    groups: resolved.map((n) => base.allGroups.find((g) => g.name === n)).filter(Boolean),
  };
}
