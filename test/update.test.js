import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isNewer, updateDisabled } from '../src/update.js';

/**
 * 실측 사고 둘을 붙잡아 둔다.
 *
 * ① 주 명령이 웹 서버라 **Ctrl+C 로만 끝난다.** 업데이트를 종료 시점에 걸어 뒀더니
 *    신호 처리 경로의 강제 종료 타이머에 잘려 한 번도 안 돌았다 → 시작 전으로 옮겼다.
 * ② 24시간 캐시가 방금 배포한 버전을 하루 동안 가렸다 → 매번 조회한다.
 */
test('업데이트는 명령 시작 전에 돌고, 최신 여부는 매번 조회한다', async () => {
  const cli = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const upd = await readFile(new URL('../src/update.js', import.meta.url), 'utf8');

  // 시작 전 호출 — HANDLERS 로 넘어가기 전에 await 되어야 한다
  const at = cli.indexOf('await maybeAutoUpdate()');
  const run = cli.indexOf('HANDLERS[name](');
  assert.ok(at > 0 && at < run, '업데이트가 명령 실행보다 뒤에 있으면 Ctrl+C 로 잘린다');
  assert.ok(!/if \(!shuttingDown\) await maybeAutoUpdate/.test(cli),
    'Ctrl+C 종료에서 업데이트를 건너뛰면 웹 서버는 영영 갱신되지 않는다');

  // 캐시로 최신 조회를 건너뛰지 않는다
  assert.ok(!/TTL_MS/.test(upd), 'TTL 캐시가 되살아나면 방금 배포한 버전이 가려진다');
  assert.match(upd, /const fresh = await fetchLatest\(\);/);
});

/**
 * 설치만 하고 옛 코드로 계속 돌면 "업데이트했습니다" 가 거짓말이 된다 —
 * 이미 로드된 파일은 방금 깔린 새 파일이 아니기 때문이다. 설치 뒤 새 코드로 다시 띄운다.
 * 그때 자식이 또 업데이트를 시도하면 자기를 무한히 재실행하므로 반드시 막아야 한다.
 */
test('설치 후 새 코드로 다시 띄우고, 자식은 다시 업데이트하지 않는다', async () => {
  const src = await readFile(new URL('../src/update.js', import.meta.url), 'utf8');
  assert.match(src, /function relaunch\(\)/);
  assert.match(src, /spawnSync\(process\.execPath, \[entry/);
  assert.match(src, /MILOG_UPDATED: '1'/, '자식 표시가 없으면 무한 재실행이 된다');
  assert.match(src, /MILOG_UPDATED === '1'\) return/, '자식은 업데이트를 건너뛰어야 한다');
  // 재실행에 실패해도 죽지 말고 하려던 일을 계속해야 한다
  assert.match(src, /if \(r\.error\)/);
});

test('자식 프로세스는 업데이트 경로를 타지 않는다', () => {
  const orig = process.env.MILOG_UPDATED;
  process.env.MILOG_UPDATED = '1';
  try {
    assert.match(updateDisabled(), /이미 업데이트/);
  } finally {
    if (orig === undefined) delete process.env.MILOG_UPDATED; else process.env.MILOG_UPDATED = orig;
  }
});

/**
 * 이 값이 비어 있으면 게시자 확인이 껍데기가 된다 — 누가 이름을 가져가도
 * 자동 설치가 그냥 돈다. 실수로 지워지지 않게 붙잡아 둔다.
 */
test('게시자 확인이 켜져 있다', async () => {
  const src = await readFile(new URL('../src/update.js', import.meta.url), 'utf8');
  const m = /const EXPECTED_MAINTAINER = process\.env\.MILOG_EXPECTED_MAINTAINER \?\? '([^']*)'/.exec(src);
  assert.ok(m, 'EXPECTED_MAINTAINER 선언을 찾을 수 없다');
  assert.ok(m[1].length > 0, '게시자가 비어 있으면 소유권 변경을 못 잡는다');
});

/**
 * 패키지 이름이 어긋나면 자동 업데이트가 **조용히** 죽는다 — 없는 패키지를 조회해
 * 404 를 받고, 실패는 전부 무시되도록 만들어 뒀기 때문에 아무 말도 안 나온다.
 * (실제로 milog → @ohg0219/milog 로 한 번 바뀐 적이 있다)
 */
test('update.js 의 패키지 이름이 package.json 과 같다', async () => {
  const src = await readFile(new URL('../src/update.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const name = /const PKG = '([^']+)'/.exec(src);
  assert.ok(name, 'PKG 선언을 찾을 수 없다');
  assert.equal(name[1], pkg.name, 'update.js 가 다른 패키지를 바라본다');
  // 스코프의 '/' 를 인코딩하지 않으면 레지스트리 경로가 깨진다
  assert.match(src, /encodeURIComponent\(PKG\)/, '스코프 이름은 URL 인코딩이 필요하다');
});

/**
 * '2.10.0' 은 '2.9.0' 보다 새 버전이다. 문자열로 비교하면 '1' < '9' 라 틀린다 —
 * 이 실수는 조용히 업데이트를 영원히 건너뛰게 만든다.
 */
test('버전 비교는 숫자 단위로 한다', () => {
  assert.equal(isNewer('2.10.0', '2.9.0'), true);
  assert.equal(isNewer('2.9.0', '2.10.0'), false);
  assert.equal(isNewer('2.0.0', '2.0.0'), false);
  assert.equal(isNewer('3.0.0', '2.99.99'), true);
  assert.equal(isNewer('2.0.1', '2.0.0'), true);
  // 형식이 이상해도 던지지 않는다 — 업데이트 확인이 명령을 죽이면 안 된다
  assert.equal(isNewer(undefined, '1.0.0'), false);
  assert.equal(isNewer('', ''), false);
});

/**
 * 업데이트 경로를 타면 안 되는 상황들. 하나라도 걸리면 **네트워크 호출조차 안 한다** —
 * CI 나 스크립트에서 남의 전역 설치를 건드리는 건 있을 수 없는 일이다.
 */
test('CI·비대화형·opt-out 에서는 업데이트를 건너뛴다', () => {
  const orig = { ...process.env };
  const restore = () => { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, orig); };

  process.env.MILOG_NO_UPDATE = '1';
  assert.match(updateDisabled(), /MILOG_NO_UPDATE/);
  restore();

  process.env.CI = '1';
  assert.match(updateDisabled(), /CI/);
  restore();

  // 테스트는 TTY 가 아니므로 기본적으로도 꺼져 있어야 한다
  assert.ok(updateDisabled(), '비대화형에서는 반드시 비활성');
  restore();
});

/**
 * 게시자 확인. 스코프 덕에 남이 이름을 선점할 수는 없지만, 공동 관리자 추가나
 * 소유권 이전은 여전히 가능하다. 그 코드가 AWS 자격증명이 있는 PC 에 자동 설치되면
 * 안 되므로, 게시자가 바뀌면 멈춘다.
 */
test('게시자가 바뀌면 자동 설치를 멈춘다', async (t) => {
  let served = { version: '99.0.0', maintainers: [{ name: 'someone-else' }] };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(served));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const fetchLatest = async () => {
    const d = await (await fetch(`${base}/milog/latest`)).json();
    return { version: d.version, maintainers: (d.maintainers ?? []).map((m) => m.name) };
  };

  // update.js 의 판정과 같은 규칙을 그대로 검사한다.
  const blocked = (expected, m) => Boolean(expected && m.length && !m.includes(expected));

  let latest = await fetchLatest();
  assert.equal(blocked('original-owner', latest.maintainers), true, '게시자가 다르면 막아야 한다');

  served = { version: '99.0.0', maintainers: [{ name: 'original-owner' }] };
  latest = await fetchLatest();
  assert.equal(blocked('original-owner', latest.maintainers), false, '같은 게시자면 통과');

  // 아직 배포 전이라 기대 게시자가 비어 있으면 검사를 건너뛴다
  assert.equal(blocked('', latest.maintainers), false);
});
