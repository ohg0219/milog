import { createInterface } from 'node:readline/promises';
import { startWebServer } from '../web/server.js';
import { discoverProfiles, resolvePrefix } from '../aws/profiles.js';
import { checkSsoSessions, sessionLabel, loginCommand } from '../aws/sso.js';
import { awsSsoLogin } from '../aws/credentials.js';
import { ui } from '../util/out.js';

/** 시각 차이를 '2시간' 처럼. 정밀할 필요는 없고 감만 잡히면 된다. */
function fmtSpan(ms) {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간` : `${Math.round(h / 24)}일`;
}

function describeState(r) {
  if (r.state === 'valid') return r.expiresAt ? `유효 (${fmtSpan(r.expiresAt - Date.now())} 남음)` : '유효';
  if (r.state === 'unknown') return '확인 못 함 (네트워크)';
  return r.expiresAt ? `만료됨 (${fmtSpan(Date.now() - r.expiresAt)} 전)` : '로그인 필요';
}

async function confirm(question, signal) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // readline 이 TTY 의 Ctrl+C 를 가로챈다 — 그대로 두면 멈춘 채로 남으니 평소 종료 경로로 넘긴다.
  rl.on('SIGINT', () => { rl.close(); process.emit('SIGINT'); });
  try {
    const a = (await rl.question(question, { signal })).trim().toLowerCase();
    return a === '' || a === 'y' || a === 'yes' || a === 'ㅛ'; // 'ㅛ' — 한글 자판 상태로 y 를 친 경우
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * 서버를 띄우기 전에 SSO 로그인 상태를 본다.
 *
 * 서버가 뜨고 나면 사용자는 브라우저를 보고 있어 만료 안내를 놓치기 쉽고, 로그인은 어차피
 * 터미널에서 해야 한다. 아직 TTY 를 쥐고 있는 지금이 `aws sso login` 을 태울 수 있는 때다.
 * 어떤 경우에도 서버 기동을 막지 않는다 — SSO 가 아닌 프로필만 쓰는 사람도 있다.
 */
async function checkSsoBeforeStart(values, signal) {
  let results;
  try {
    const { profiles } = await discoverProfiles({ prefix: resolvePrefix(values.profilePrefix) });
    results = await checkSsoSessions(profiles);
  } catch {
    return;
  }
  const expired = results.filter((r) => r.state === 'expired');
  if (!expired.length) return;

  ui.line('');
  ui.warn('  SSO 로그인이 필요합니다');
  // 상태 문구는 한글이라 칸 폭이 2다 — length 로 맞추면 어긋난다.
  const cols = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const rows = results.map((r) => ({ r, label: sessionLabel(r), state: describeState(r) }));
  const lw = Math.max(...rows.map((x) => cols(x.label)));
  const sw = Math.max(...rows.map((x) => cols(x.state)));
  for (const { r, label, state } of rows) {
    const mark = r.state === 'valid' ? '✓' : r.state === 'expired' ? '✗' : '?';
    ui.line(`    ${mark} ${label}${' '.repeat(lw - cols(label))}   ${state}${' '.repeat(sw - cols(state))}   프로필 ${r.count}개`);
  }
  ui.line('');

  // --no-open 은 원격·자동화 환경이라는 신호다. 묻지 않고 할 일만 알려 준다.
  const interactive = process.stdin.isTTY && process.stderr.isTTY && !values.noOpen && !values.quiet;
  if (!interactive) {
    for (const r of expired) ui.warn(`  먼저 실행하세요: ${loginCommand(r)}`);
    return;
  }

  // 세션마다 묻지 않는다 — 안 쓰는 세션까지 매번 하나씩 답하게 된다. 전부 하거나 전부 건너뛴다.
  const q = expired.length === 1
    ? '  지금 로그인할까요? [Y/n] '
    : `  ${expired.length}개 세션을 모두 로그인할까요? (n = 건너뛰기) [Y/n] `;
  if (!(await confirm(q, signal))) {
    if (!signal.aborted) ui.dim('  건너뜁니다. 만료된 세션의 프로필은 조회가 실패합니다.');
    return;
  }

  for (const r of expired) {
    if (signal.aborted) return;
    ui.dim(`  → ${loginCommand(r)}`);
    const res = await awsSsoLogin(r.profile.name, r.ssoSession);
    if (res.spawnFailed) {
      ui.error('  aws CLI 를 찾을 수 없어 SSO 로그인을 할 수 없습니다.');
      ui.dim('  AWS CLI v2 를 설치한 뒤 다시 실행하세요.');
      return;
    }
    if (res.ok) ui.ok('  ✓ 로그인했습니다.');
    else ui.warn(`  로그인하지 못했습니다${res.unsafe ? ' (프로필 이름에 쓸 수 없는 문자)' : ` (exit ${res.code})`} — 그대로 진행합니다.`);
    ui.line('');
  }
}

export async function web(values, { signal }) {
  await checkSsoBeforeStart(values, signal);
  if (signal.aborted) return 130;

  const { server, url, port, openBrowser } = await startWebServer({
    port: Number(values.port ?? 0) || 0,
    open: !values.noOpen,
    idleMinutes: Number(values.idleMinutes ?? 30),
    log: (s) => ui.dim(s),
  });

  ui.line('');
  ui.ok(`  milog web  →  ${url}`);
  ui.dim('  127.0.0.1 에만 열려 있고, 토큰이 있어야 붙을 수 있습니다.');
  ui.dim('  Ctrl+C 로 종료. 브라우저 탭을 닫으면 폴링도 함께 멈춥니다.');
  ui.line('');

  if (!values.noOpen && !openBrowser()) {
    ui.warn('  브라우저를 자동으로 열지 못했습니다 — 위 주소를 직접 붙여넣으세요.');
  }

  // 서버가 살아 있는 동안 명령이 끝나지 않게 잡아 둔다.
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
    server.once('close', resolve);
  });

  await new Promise((r) => server.close(r));
  ui.dim(`  서버를 닫았습니다 (포트 ${port}).`);
  return 0;
}
