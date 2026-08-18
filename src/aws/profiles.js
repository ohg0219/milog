import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { MilogError } from '../util/errors.js';

// 기본은 '필터 없음' 이다. 특정 조직 이름을 도구에 박아 두면 다른 데서 못 쓴다.
// 프로필이 많아 고르기 번거로우면 MILOG_PROFILE_PREFIX 나 --profile-prefix 로 좁힌다.
export const DEFAULT_PROFILE_PREFIX = '';

export const configPath = () =>
  process.env.AWS_CONFIG_FILE || path.join(homedir(), '.aws', 'config');

/**
 * [profile X] 바로 위의 # 주석을 사람이 읽는 라벨로 쓴다.
 * SDK 의 ini 파서는 주석을 파싱 전에 잘라버려서(parseIni 가 [;#] 로 split) 이 정보를
 * 살릴 수 없다. 값은 SDK 로더에 맡기고 라벨만 따로 한 번 더 읽는다.
 * 실패해도 라벨이 비는 것뿐이라 절대 던지지 않는다.
 */
async function readProfileLabels(file) {
  const labels = new Map();
  let pending = null;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return labels;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue; // 빈 줄은 라벨을 지우지 않는다

    const comment = /^[#;]\s*(.*)$/.exec(line);
    if (comment) {
      if (comment[1].trim()) pending = comment[1].trim();
      continue;
    }
    const section = /^\[\s*profile\s+(?:"([^"]+)"|'([^']+)'|([^\]]+?))\s*\]$/.exec(line);
    if (section) {
      const name = section[1] ?? section[2] ?? section[3];
      if (pending) labels.set(name, pending);
      pending = null;
      continue;
    }
    pending = null; // 다른 섹션 헤더나 key=value 는 라벨을 끊는다
  }
  return labels;
}

export function resolvePrefix(flagPrefix) {
  if (flagPrefix != null) return flagPrefix;
  if (process.env.MILOG_PROFILE_PREFIX != null) return process.env.MILOG_PROFILE_PREFIX;
  return DEFAULT_PROFILE_PREFIX;
}

export async function discoverProfiles({ prefix = DEFAULT_PROFILE_PREFIX } = {}) {
  const { configFile, credentialsFile } = await loadSharedConfigFiles({ ignoreCache: true });
  const labels = await readProfileLabels(configPath());

  // ~/.aws/credentials 에만 있는 프로필(SSO 아닌 정적 키)도 포함한다.
  const merged = { ...credentialsFile, ...configFile };

  const all = Object.entries(merged)
    // sso-session 섹션은 'sso-session.<이름>' 으로 그대로 넘어온다 — 프로필이 아니다.
    .filter(([name]) => !name.startsWith('sso-session.'))
    .filter(([name]) => !name.startsWith('services.'))
    .map(([name, s]) => ({
      name,
      accountId: s.sso_account_id ?? '',
      region: s.region ?? '',
      roleName: s.sso_role_name ?? '',
      ssoSession: s.sso_session ?? '',
      isSso: Boolean(s.sso_session || s.sso_start_url),
      label: labels.get(name) ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const p = String(prefix ?? '').toLowerCase();
  const matched = p ? all.filter((x) => x.name.toLowerCase().startsWith(p)) : all;
  return { profiles: matched, total: all.length, prefix };
}

export async function findProfile(nameOrFragment, { prefix } = {}) {
  const { profiles, total } = await discoverProfiles({ prefix });
  if (profiles.length === 0) {
    throw new MilogError(
      `'${prefix}' 로 시작하는 AWS 프로필이 없습니다 (전체 ${total}개).`,
      { hint: 'aws configure sso 로 프로필을 만들거나 --profile-prefix 를 확인하세요.' },
    );
  }
  if (!nameOrFragment) return { profiles, exact: null };

  const exact = profiles.find((x) => x.name === nameOrFragment);
  if (exact) return { profiles, exact };

  const frag = String(nameOrFragment).toLowerCase();
  const hits = profiles.filter((x) => x.name.toLowerCase().includes(frag));
  if (hits.length === 1) return { profiles, exact: hits[0] };
  if (hits.length === 0) {
    throw new MilogError(
      `프로필을 찾을 수 없습니다: ${nameOrFragment}`,
      { hint: `쓸 수 있는 프로필: ${profiles.map((x) => x.name).join(', ')}` },
    );
  }
  return { profiles: hits, exact: null };
}

/**
 * 리전 우선순위. 클라이언트를 만들기 전에 필요하다 — 로그 그룹 캐시 키의 일부다.
 * 옛 도구의 `aws configure get region` 서브프로세스는 loadSharedConfigFiles 가
 * 같은 파일을 이미 읽으므로 불필요하다.
 */
export function resolveRegion({ flagRegion, profile }) {
  const r = flagRegion
    || profile?.region
    || process.env.AWS_REGION
    || process.env.AWS_DEFAULT_REGION;
  if (!r) {
    throw new MilogError('리전을 결정할 수 없습니다.', { hint: '--region 으로 지정하세요.' });
  }
  return r;
}
