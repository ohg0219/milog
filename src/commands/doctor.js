import { discoverProfiles, resolvePrefix } from '../aws/profiles.js';
import { resolveCredentials, accountIdFrom } from '../aws/credentials.js';
import { createLogsClient, makeCounters } from '../aws/client.js';
import { listLogGroups } from '../aws/groups.js';
import { stateDir } from '../state/paths.js';
import { ui } from '../util/out.js';
import { version } from '../version.js';
import { latestVersion, isNewer } from '../update.js';
import { appPackages } from '../config.js';

/** 열을 맞추는 데만 쓴다 — 라벨은 전부 ASCII·한글 고정 폭이라 단순 padEnd 로 충분하다. */
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

/**
 * 환경 진단. 웹이 안 뜨는 이유를 터미널에서 알 수 있는 유일한 경로라
 * CLI 를 걷어낸 뒤에도 이것만은 남긴다.
 */
export async function doctor(values) {
  const check = async (label, fn) => {
    try {
      const r = await fn();
      ui.line(`  ✓ ${pad(label, 20)} ${r ?? ''}`);
      return true;
    } catch (e) {
      ui.error(`  ✗ ${pad(label, 20)} ${e.message}`);
      return false;
    }
  };

  ui.line('milog 환경 진단\n');

  const cur = await version();
  await check('milog', async () => {
    const latest = await latestVersion();
    if (!latest) return `${cur} (최신 버전 확인 실패 — 오프라인이거나 차단됨)`;
    return isNewer(latest, cur) ? `${cur} → 새 버전 ${latest} 있음` : `${cur} (최신)`;
  });

  await check('Node', async () => {
    const [maj] = process.versions.node.split('.').map(Number);
    if (maj < 22) throw new Error(`${process.versions.node} — 22 이상이 필요합니다.`);
    return process.versions.node;
  });

  // 한글이 U+FFFD 로 깨지지 않는지 눈으로 확인하는 자리다.
  // 아무 한글이나 되므로 업무 용어는 쓰지 않는다.
  await check('한글 출력', async () => '한글이 깨지지 않으면 정상 (가나다 ABC 123)');

  const pkgs = appPackages();
  await check('스택 강조 패키지', async () =>
    (pkgs.length ? pkgs.join(', ') : '(미설정 — MILOG_APP_PACKAGES 로 내 코드를 강조할 수 있습니다)'));

  const prefix = resolvePrefix(values.profilePrefix);
  let list = [];
  await check('AWS 프로필', async () => {
    const { profiles: p, total } = await discoverProfiles({ prefix });
    list = p;
    if (!p.length) {
      throw new Error(prefix
        ? `'${prefix}' 로 시작하는 프로필 없음 (전체 ${total}개)`
        : '~/.aws/config 에 프로필이 없습니다 (aws configure sso)');
    }
    return p.map((x) => x.name).join(', ');
  });

  if (!list.length) return 1;
  const profile = list.find((p) => p.name === values.profile) ?? list[0];

  let ctxOk = false;
  await check(`자격증명 (${profile.name})`, async () => {
    const { provider, credentials } = await resolveCredentials(profile, { autoLogin: false });
    const counters = makeCounters();
    const client = createLogsClient({
      region: profile.region, profile: profile.name, credentials: provider, counters,
    });
    const { groups: g } = await listLogGroups(client, {
      profile: profile.name, region: profile.region, refresh: true,
    });
    const acct = accountIdFrom(credentials, profile, g);
    ctxOk = true;
    return `계정 ****${acct.accountId.slice(-4)} (${acct.source}) · 로그 그룹 ${g.length}개`;
  });

  ui.line(`\n  상태 디렉터리  ${stateDir()}`);
  return ctxOk ? 0 : 1;
}
