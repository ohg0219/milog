import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statePath, readJson, writeJsonAtomic } from './state/paths.js';
import { ui } from './util/out.js';
import { version } from './version.js';

const PKG = '@ohg0219/milog';
const REGISTRY = process.env.MILOG_REGISTRY ?? 'https://registry.npmjs.org';
const TIMEOUT_MS = 1500;
// 마지막으로 본 최신 버전. 캐시가 아니라 **오프라인 대비 기록**이다 —
// 24시간 캐시를 두었더니 방금 배포한 버전이 하루 동안 안 보였다.
const LAST_SEEN = () => statePath('update.json');

/**
 * 기대하는 게시자.
 *
 * 스코프(@ohg0219)가 계정에 영구히 묶여 있어 **이름을 남이 가져갈 수는 없다.**
 * 그래도 확인은 남긴다 — 공동 관리자가 추가되거나 소유권이 넘어가는 건 여전히 가능하고,
 * 이 패키지는 설치되면 AWS 자격증명이 있는 PC 에서 스스로 새 코드를 깔기 때문이다.
 *
 * npm 계정명이다 — package.json 의 author 와 다를 수 있다(레지스트리가 돌려주는 건 계정명).
 * 소유자를 넘기거나 공동 관리자를 추가하면 이 값도 같이 고쳐야 자동 업데이트가 계속 돈다.
 */
const EXPECTED_MAINTAINER = process.env.MILOG_EXPECTED_MAINTAINER ?? 'ohg0219';

/** 자기 자신이 npm 전역 설치본인가. git 클론·개발 중이면 덮어쓰면 안 된다. */
function installedFromNpm() {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    return here.replace(/\\/g, '/').includes(`node_modules/${PKG}/`);
  } catch { return false; }
}

/**
 * 업데이트 경로를 아예 타지 않아야 하는 상황.
 * 하나라도 걸리면 **네트워크 호출조차 하지 않는다.**
 */
export function updateDisabled() {
  // 방금 업데이트하고 다시 띄운 프로세스다. 또 확인하면 무한히 자기를 재실행한다.
  if (process.env.MILOG_UPDATED === '1') return '이번 실행에서 이미 업데이트했습니다';
  if (process.env.MILOG_NO_UPDATE === '1') return '사용자가 껐습니다 (MILOG_NO_UPDATE=1)';
  if (process.env.CI) return 'CI 환경';
  if (!process.stdout.isTTY) return '터미널이 아님';
  if (!installedFromNpm()) return 'npm 전역 설치본이 아님';
  return null;
}

/** '2.10.0' > '2.9.0' 을 문자열 비교로 틀리지 않게 — 숫자 단위로 본다. */
export function isNewer(a, b) {
  const p = (v) => String(v ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * 레지스트리에서 최신 버전과 게시자를 읽는다. 실패는 전부 조용히 null —
 * 로그를 보러 온 사람에게 npm 이 안 된다고 떠들 이유가 없다.
 */
async function fetchLatest() {
  try {
    const r = await fetch(`${REGISTRY}/${encodeURIComponent(PKG)}/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.version) return null;
    return {
      version: d.version,
      maintainers: (d.maintainers ?? []).map((m) => m?.name ?? String(m)).filter(Boolean),
    };
  } catch { return null; }
}

/**
 * 실행할 때마다 레지스트리를 본다. 배포한 게 다음 실행에 바로 퍼져야 하기 때문이다.
 * 조회는 1.5초 타임아웃이고 실패하면 마지막으로 본 값으로 물러난다 — 오프라인에서도 안 막힌다.
 */
async function getLatest() {
  const fresh = await fetchLatest();
  if (!fresh) {
    const last = await readJson(LAST_SEEN());
    return last?.version ? last : null;
  }
  const rec = { ...fresh, at: Date.now() };
  await writeJsonAtomic(LAST_SEEN(), rec);
  return rec;
}

/** doctor 용 — 상태와 무관하게 최신 버전만 알고 싶을 때. */
export async function latestVersion() {
  return (await getLatest())?.version ?? null;
}

/**
 * **명령을 시작하기 전에** 호출한다. 새 버전이 있으면 전역 설치하고 결과를 남긴다.
 *
 * 끝난 뒤가 아니라 시작 전인 이유: 이 도구의 주 명령은 웹 서버라 **Ctrl+C 로만 끝난다.**
 * 종료 시점에 걸어 두면 신호 처리 경로를 타고 강제 종료 타이머에 잘려 영영 안 돈다
 * (실제로 그래서 한 번도 안 돌았다).
 *
 * 사용자 모르게 버전이 바뀌는 일이므로 **무엇이 설치됐는지 반드시 화면에 남긴다.**
 * 이미 돌고 있는 프로세스는 옛 코드 그대로이므로 다시 실행하라고 알린다.
 */
export async function maybeAutoUpdate() {
  if (updateDisabled()) return;

  const current = await version();
  const latest = await getLatest();
  if (!latest?.version || !isNewer(latest.version, current)) return;

  // 게시자가 바뀌었으면 설치하지 않는다 — 이름이 넘어갔을 수 있다.
  if (EXPECTED_MAINTAINER && latest.maintainers?.length
      && !latest.maintainers.includes(EXPECTED_MAINTAINER)) {
    ui.warn(`  ⚠ ${PKG} 의 게시자가 바뀌었습니다 (기대: ${EXPECTED_MAINTAINER}, 현재: ${latest.maintainers.join(', ')}).`);
    ui.warn('    자동 업데이트를 중단했습니다. 확인 전까지 설치하지 마세요.');
    return;
  }

  ui.dim(`  새 버전 ${latest.version} 설치 중…`);
  if (!await npmInstall()) {
    ui.warn(`  ✗ 자동 업데이트 실패 — npm i -g ${PKG}@latest`);
    return;                       // 옛 버전으로라도 계속 쓰게 둔다
  }
  ui.ok(`  ✓ ${latest.version} 으로 업데이트했습니다.`);
  relaunch();
}

/**
 * 새 코드로 자기 자신을 다시 띄우고 그 결과로 끝난다.
 *
 * 이게 없으면 "업데이트했습니다" 라고 해 놓고 **옛 코드로 계속 도는** 꼴이 된다 —
 * 이미 메모리에 로드된 파일은 방금 깔린 새 파일이 아니기 때문이다.
 * 진입점 경로는 그대로고 내용만 새것으로 바뀌었으므로 다시 실행하면 새 버전이 뜬다.
 */
function relaunch() {
  const entry = fileURLToPath(new URL('../bin/milog.js', import.meta.url));
  const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, MILOG_UPDATED: '1' },
  });
  // 다시 띄우지도 못했으면 죽지 말고 옛 버전으로 하려던 일을 계속한다.
  if (r.error) {
    ui.warn(`  ✗ 새 버전으로 다시 시작하지 못했습니다 — 이번 실행은 이전 버전입니다.`);
    return;
  }
  process.exit(r.status ?? 0);
}

function npmInstall() {
  return new Promise((resolve) => {
    const p = spawn('npm', ['i', '-g', `${PKG}@latest`], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    const t = setTimeout(() => { p.kill(); resolve(false); }, 120_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
