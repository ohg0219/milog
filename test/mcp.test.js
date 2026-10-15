import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/model/event.js';
import { buildTraceTree } from '../src/model/trace.js';
import { summarizeErrors, renderTrace, renderLines, trimStack, clip, details } from '../src/mcp/format.js';
import { recentChunks, isRelativeWindow, traceWindow } from '../src/mcp/tools.js';
import { dispatch } from '../src/args/parse.js';

const ev = (body, ts, group = '/app/qa-web') => normalize({ message: JSON.stringify(body), timestamp: ts }, group);

const at = (ms) => `2026-10-13T10:00:00.${String(ms).padStart(3, '0')}+09:00`;
const err = (cls, msg, ts, extra = {}) => ev({
  timestamp: at(ts % 1000), level: 'ERROR', logger: 'com.acme.Svc', message: 'fail',
  exception: { className: cls, message: msg, stackTrace: `${cls}: ${msg}\n\tat com.acme.Svc.run(Svc.java:1)` },
  context_map: { trace_id: `t${ts}`, span_id: 's' }, ...extra,
}, ts);

test('find_errors 요약: 같은 예외는 묶고 많은 순, id 가 달라도 같은 종류', () => {
  const evs = [
    err('IllegalStateException', '주문 1234567 없음', 1),
    err('IllegalStateException', '주문 7654321 없음', 2),
    err('IllegalStateException', '주문 1111111 없음', 3),
    err('NullPointerException', 'plainTxt is null', 4),
  ];
  const out = summarizeErrors(evs);
  assert.match(out, /^에러 4건 · 2종류/);
  const first = out.indexOf('[1] 3회');
  const second = out.indexOf('[2] 1회');
  assert.ok(first > 0 && second > first, out);
  assert.match(out, /NullPointerException: plainTxt is null/);
  assert.match(out, /trace: t1, t2, t3/);
});

test('find_errors 요약: 그룹별 건수를 보이고, 상한에 걸린 그룹을 이름으로 밝힌다', () => {
  const evs = [err('X', 'y', 1, {}), err('X', 'y', 2), err('Npe', 'z', 3)];
  evs[2].group = '/app/qa-quiet';
  const out = summarizeErrors(evs, { capped: ['/app/qa-web'], limit: 300 }).split('\n');
  assert.equal(out[1], '그룹별: /app/qa-web 2+ · /app/qa-quiet 1');
  assert.match(out[2], /그룹당 상한 300건에서 멈춤: \/app\/qa-web/);
});

test('find_errors 요약: 시간 예산 안에 못 끝낸 그룹을 밝힌다', () => {
  const out = summarizeErrors([], { unfinished: ['/app/qa-slow'], budgetMs: 90_000 });
  assert.match(out, /90초 안에 다 훑지 못한 그룹: \/app\/qa-slow/);
  assert.match(out, /받은 범위 안에서는 에러가 없습니다/);
});

test('find_errors 요약: 스택 첫 줄이 제목과 같으면 반복하지 않는다', () => {
  const out = summarizeErrors([err('IllegalStateException', 'boom', 1)]);
  assert.equal(out.match(/IllegalStateException: boom/g).length, 1, out);
  assert.match(out, /at com\.acme\.Svc\.run/);
});

test('trimStack: 앞 n줄 + Caused by + 앱 프레임은 살린다', () => {
  const frames = Array.from({ length: 30 }, (_, i) => `\tat org.spring.F${i}.x(F.java:${i})`);
  frames[20] = '\tat com.acme.order.OrderService.pay(OrderService.java:42)';
  const st = ['java.lang.IllegalStateException: boom', ...frames, 'Caused by: java.io.IOException: disk', '\tat java.io.F.w(F.java:1)', '\tat java.io.G.w(G.java:1)'].join('\n');
  const out = trimStack(st, 4, ['com.acme']).join('\n');
  assert.match(out, /OrderService\.pay/);
  assert.match(out, /Caused by: java\.io\.IOException: disk/);
  assert.match(out, /F\.java:1\)/); // Caused by 바로 다음 줄
  assert.doesNotMatch(out, /F10\.x/);
  assert.match(out, /… \(\+1줄\)$/);
});

test('get_trace 렌더: 들여쓰기·시작 기준 오프셋·느림·예외', () => {
  const WIDE = { timestamp: at(500), level: 'ERROR', logger: 'w', service_name: 'demo', message: 'x',
    span: { name: 'GET /orders/pay', duration_ms: 1204, status: 'ERROR' },
    span_exception: { className: 'IllegalStateException', message: '상품 없음', stackTrace: 'IllegalStateException: 상품 없음\n\tat a.B.c(B.java:1)' },
    context_map: { trace_id: 'abc', span_id: 'root' } };
  const CALL = { ...WIDE, level: 'INFO', span: { name: 'OrderService.find', duration_ms: 2 }, span_exception: undefined,
    context_map: { trace_id: 'abc', span_id: 'kid', parent_span_id: 'root' } };
  const NARR = { timestamp: at(10), level: 'INFO', logger: 'com.acme.OrderService', message: '재고 확인', context_map: { trace_id: 'abc', span_id: 'kid' } };
  const tree = buildTraceTree([ev(WIDE, 2204), ev(CALL, 1012), ev(NARR, 1011)]);
  const out = renderTrace(tree, { traceId: 'abc' });

  assert.match(out, /^trace abc · span 2개/);
  assert.match(out, /\+0ms ERROR ● GET \/orders\/pay {2}1,204ms {2}⚠느림 {2}ERROR/);
  assert.match(out, /\+10ms INFO {4}↳ OrderService\.find {2}2ms/); // 레벨 칸(5) + 들여쓰기(2)
  assert.match(out, /· INFO {2}OrderService {2}재고 확인/);
  assert.match(out, /✗ IllegalStateException: 상품 없음/);
});

test('search_logs 렌더: 시간순 줄, trace 는 바뀔 때만, 예외는 한 줄', () => {
  const line = (ms, trace, msg, extra = {}) => ev({
    timestamp: at(ms), level: 'INFO', logger: 'com.acme.OrderService', message: msg,
    context_map: { trace_id: trace, span_id: 's' }, ...extra,
  }, ms);
  const evs = [
    line(1, 'aaa', '주문 12345 접수'),
    line(2, 'aaa', '주문 12345 결제 시도'),
    line(3, 'bbb', '주문 12345 재조회', { level: 'ERROR', exception: { className: 'IllegalStateException', message: '상품 없음', stackTrace: 'x' } }),
  ];
  const out = renderLines(evs, { query: '12345', window: '1h ~ 지금' });
  assert.match(out, /^검색 "12345" · 3줄 · trace 2개 · 그룹 1개 · 1h ~ 지금/);
  assert.equal(out.match(/── trace aaa/g).length, 1);
  assert.match(out, /── trace bbb/);
  assert.match(out, /10-13 10:00:00\.001 INFO {2}OrderService {2}주문 12345 접수/);
  assert.match(out, /✗ IllegalStateException: 상품 없음/);
  assert.ok(out.indexOf('접수') < out.indexOf('결제') && out.indexOf('결제') < out.indexOf('재조회'));
});

test('search_logs 렌더: 못 찾으면 대소문자 구분을 알려 준다', () => {
  assert.match(renderLines([], { query: 'Order' }), /대소문자를 구분합니다/);
});

test('최근부터: 조각은 지금에서 거슬러 올라가며 빈틈·겹침 없이 구간을 덮는다', () => {
  const H = 3_600_000;
  const end = 1_000 * H;
  const chunks = recentChunks(end - 7 * 24 * H, end);
  assert.deepEqual(chunks[0], [end - H, end]);
  assert.deepEqual(chunks[1], [end - 6 * H, end - H]);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i][1], chunks[i - 1][0]);
  assert.equal(chunks.at(-1)[0], end - 7 * 24 * H);
  // 30일보다 길면 30일씩 이어 붙인다
  const long = recentChunks(end - 90 * 24 * H, end);
  assert.equal(long.at(-1)[0], end - 90 * 24 * H);
  // 1시간보다 짧으면 조각 하나
  assert.deepEqual(recentChunks(end - 30 * 60_000, end), [[end - 30 * 60_000, end]]);
});

test('최근부터는 날짜를 콕 집지 않았을 때만', () => {
  assert.equal(isRelativeWindow({ since: '7d' }), true);
  assert.equal(isRelativeWindow({ since: 'today' }), true);
  assert.equal(isRelativeWindow({ since: '7d', until: '1d' }), false);
  assert.equal(isRelativeWindow({ since: '2026-10-13T10:00:00+09:00' }), false);
});

test('시간이 모자라 최근부터 멈추면 어디까지 봤는지 시각으로 알린다', () => {
  const reached = new Date(2026, 9, 14, 10, 0).getTime();
  const out = renderLines([], { query: 'x', reachedMs: reached, budgetMs: 90_000, unfinished: ['/app/qa-a'] });
  assert.match(out, /90초 안에 10-14 10:00 이후만 다 훑었습니다/);
  assert.match(out, /그 직전 구간을 훑다 멈춘 그룹: \/app\/qa-a/);
  assert.match(out, /받은 범위 안에서는 찾지 못했습니다/);
});

test('span 줄: 이름을 되풀이한 메시지는 빼고, 업무 속성·플로우 단계를 싣는다', () => {
  const e = ev({
    timestamp: at(1), level: 'INFO', logger: 'com.acme.otel.WideEvent', message: 'GET /checkout, 841 ms',
    business_attributes: { orderId: 12345, 'session.ip': '10.0.0.1' },
    span: { name: 'GET /checkout', duration_ms: 841, status: 'UNSET', attributes: {
      'url.query': 'execution=e1s1', 'http.response.status_code': 200, 'http.route': '/checkout',
      'http.request.method': 'GET', 'server.address': 'shop.example', 'user_agent.original': 'Mozilla/5.0',
    } },
    context_map: { trace_id: 't', span_id: 's' },
  }, 1);
  const line = renderLines([e], { query: 'x' }).split('\n').find((l) => l.includes('GET /checkout'));
  assert.doesNotMatch(line, /GET \/checkout, 841 ms/);
  assert.match(line, /http\.response\.status_code=200 url\.query=execution=e1s1/);
  assert.match(line, /orderId=12345 session\.ip=10\.0\.0\.1/);
  assert.doesNotMatch(line, /Mozilla|server\.address/); // 들어오는 요청의 server.address 는 자기 자신
});

test('나가는 HTTP 호출은 대상 server.address 를, DB span 은 내부 엔드포인트를 안 싣는다', () => {
  const out = (attrs) => details({ attributes: attrs });
  assert.match(out({ 'http.request.method': 'POST', 'server.address': 'pay.example' }), /server\.address=pay\.example/);
  assert.equal(out({ 'db.system': 'mysql', 'server.address': 'db.internal', 'db.statement': 'SELECT 1' }), 'db.statement=SELECT 1');
});

test('clip: 상한을 넘으면 자르고 이유를 적는다', () => {
  const out = clip('가'.repeat(50), 10);
  assert.equal(out.slice(0, 10), '가'.repeat(10));
  assert.match(out, /40자를 잘랐습니다/);
});

test('mcp 명령은 공통 옵션 -p/-g 를 받는다', () => {
  const r = dispatch(['mcp', '-p', 'my-logs', '-g', 'qa-web', '-g', 'qa-api']);
  assert.equal(r.name, 'mcp');
  assert.equal(r.values.profile, 'my-logs');
  assert.deepEqual(r.values.group, ['qa-web', 'qa-api']);
});


test('trace_id 앞 8자리는 생성 시각 — 그 앞뒤만 찾는다', () => {
  const now = Date.UTC(2026, 9, 15, 3, 0, 0);
  // 6ad02bf5 = 2026-10-15T01:27:17Z (로그 시각 10:27:17+09:00 과 일치)
  const w = traceWindow('6ad02bf50ce02aefb9ec1e5587192c9d', now);
  const born = Date.UTC(2026, 9, 15, 1, 27, 17);
  assert.equal(w.startMs, born - 60_000);
  assert.equal(w.endMs, born + 30 * 60_000);
  // 방금 생긴 trace 는 지금까지만
  assert.equal(traceWindow('6ad02bf50ce02aefb9ec1e5587192c9d', born + 5_000).endMs, born + 5_000);
});

test('시각으로 읽을 수 없는 trace_id 는 쓰지 않는다', () => {
  const now = Date.UTC(2026, 9, 15);
  assert.equal(traceWindow('6ad02bf5', now), null); // 조각
  assert.equal(traceWindow('00000000aaaaaaaaaaaaaaaaaaaaaaaa', now), null); // 1970
  assert.equal(traceWindow('ffffffffaaaaaaaaaaaaaaaaaaaaaaaa', now), null); // 먼 미래
});

/** milog mcp 를 띄우고 JSON-RPC 를 주고받는다. stdout 의 모든 줄을 모아 둔다. */
function startServer(args, env = {}) {
  const entry = fileURLToPath(new URL('../bin/milog.js', import.meta.url));
  const p = spawn(process.execPath, [entry, 'mcp', ...args], {
    env: { ...process.env, MILOG_NO_UPDATE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let seq = 0;
  const lines = [];
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      try {
        const msg = JSON.parse(line);
        waiters.get(msg.id)?.(msg);
      } catch { /* 호출한 쪽에서 검사한다 */ }
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => reject(new Error(`${method} 응답 없음`)), 15_000);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = async () => {
    const r = await call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return r;
  };
  const close = async () => {
    p.stdin.end();
    await new Promise((r) => { p.once('exit', r); setTimeout(() => { p.kill(); r(); }, 3000); });
  };
  return { call, init, close, lines };
}

const assertCleanStdout = (lines) => {
  for (const l of lines.filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), `stdout 에 JSON 이 아닌 줄: ${l}`);
};

/**
 * stdio 스모크. stdout 은 JSON-RPC 전용이라 **한 줄이라도** 다른 게 섞이면 클라이언트가 끊는다.
 * 프로필을 고정하지 않으므로 AWS 는 부르지 않는다.
 */
test('stdio: initialize → tools/list, stdout 은 JSON 줄만', async () => {
  const s = startServer([]);
  try {
    const init = await s.init();
    assert.equal(init.result.serverInfo.name, 'milog');

    const list = await s.call('tools/list');
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['find_errors', 'get_trace', 'list_sources', 'search_logs']);

    // 고정하지 않았으면 profile 을 인자로 받는다
    const fe = list.result.tools.find((t) => t.name === 'find_errors');
    assert.ok(fe.inputSchema.properties.profile);
  } finally {
    await s.close();
  }
  assertCleanStdout(s.lines);
});

/**
 * SSO 만료. 진짜 만료를 기다릴 수 없으니, 토큰 캐시가 없는 SSO 프로필을 임시 설정으로 만든다.
 * 홈도 임시 폴더로 돌려 사용자의 실제 ~/.aws 를 건드리지 않는다. 네트워크는 쓰지 않는다 —
 * 토큰 파일이 없으면 SDK 가 요청 전에 실패한다.
 *
 * 서버는 떠야 하고(시작 때 AWS 를 안 부른다), 호출은 죽지 말고 로그인 명령을 담은 오류를 돌려줘야 한다.
 */
test('stdio: SSO 가 만료되면 tool 이 aws sso login 안내를 돌려준다', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'milog-sso-'));
  const config = path.join(home, 'config');
  await writeFile(config, [
    '[profile expired-sso]',
    'sso_session = milog-test-session',
    'sso_account_id = 000000000000',
    'sso_role_name = Reader',
    'region = ap-northeast-2',
    '',
    '[sso-session milog-test-session]',
    'sso_start_url = https://example.awsapps.com/start',
    'sso_region = ap-northeast-2',
    '',
  ].join('\n'));
  await writeFile(path.join(home, 'credentials'), '');

  const s = startServer(['-p', 'expired-sso', '-g', 'qa-'], {
    AWS_CONFIG_FILE: config,
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'credentials'),
    HOME: home,
    USERPROFILE: home,
    MILOG_STATE_DIR: path.join(home, 'state'),
    AWS_PROFILE: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_SESSION_TOKEN: '',
  });
  try {
    await s.init();
    const r = await s.call('tools/call', { name: 'find_errors', arguments: {} });
    assert.equal(r.result.isError, true, JSON.stringify(r));
    const msg = r.result.content[0].text;
    assert.match(msg, /자격증명이 만료되었습니다/);
    assert.match(msg, /aws sso login --sso-session milog-test-session/);
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
  assertCleanStdout(s.lines);
});

/**
 * mcp 모드는 설치를 못 하니 알리기라도 해야 한다 — 이걸로만 쓰는 사람은 터미널에서
 * milog 를 띄울 일이 없어 자동 업데이트를 영영 못 받는다.
 * 가짜 레지스트리가 99.0.0 을 말하게 하고, 안내가 세션에 **한 번만** 붙는지 본다.
 */
test('stdio: 새 버전이 있으면 첫 응답에 한 번만 알린다', async () => {
  const registry = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: '99.0.0', maintainers: [{ name: 'ohg0219' }] }));
  });
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  const home = await mkdtemp(path.join(tmpdir(), 'milog-upd-'));
  await writeFile(path.join(home, 'config'), '[profile any]\nregion = ap-northeast-2\n');

  const s = startServer([], {
    MILOG_NO_UPDATE: '',
    CI: '',
    MILOG_REGISTRY: `http://127.0.0.1:${registry.address().port}`,
    MILOG_STATE_DIR: path.join(home, 'state'),
    AWS_CONFIG_FILE: path.join(home, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'none'),
  });
  try {
    await s.init();
    let notices = 0;
    for (let i = 0; i < 4; i++) {
      // 프로필 목록만 보는 호출이라 AWS 를 부르지 않는다.
      const r = await s.call('tools/call', { name: 'list_sources', arguments: {} });
      assert.match(r.result.content[0].text, /any/);
      notices += r.result.content.filter((c) => /새 버전 99\.0\.0/.test(c.text)).length;
      await new Promise((w) => setTimeout(w, 200));
    }
    assert.equal(notices, 1);
  } finally {
    await s.close();
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
  assertCleanStdout(s.lines);
});
