import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startWebServer } from '../src/web/server.js';
import { renderPage } from '../src/web/page.js';

/**
 * 이 서버는 사용자의 AWS 자격증명으로 로그를 읽어 준다.
 * 아래 가드가 뚫리면 같은 머신의 다른 프로세스나 악성 웹페이지가 로그를 긁어갈 수 있다.
 */
test('로컬 서버 보안 가드', async (t) => {
  const { server, url, port, token } = await startWebServer({
    port: 0, open: false, idleMinutes: 0, log: () => {},
  });
  t.after(() => new Promise((r) => server.close(r)));

  const base = `http://127.0.0.1:${port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers });

  await t.test('127.0.0.1 에만 바인딩된다', () => {
    assert.equal(server.address().address, '127.0.0.1');
  });

  await t.test('토큰이 없으면 403', async () => {
    assert.equal((await get('/api/bootstrap')).status, 403);
    assert.equal((await get('/')).status, 403);
  });

  await t.test('토큰이 틀리면 403', async () => {
    assert.equal((await get('/api/bootstrap?t=nope')).status, 403);
    // 길이만 같고 값이 다른 경우도 막혀야 한다
    const wrong = token.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
    assert.equal((await get(`/api/bootstrap?t=${wrong}`)).status, 403);
  });

  await t.test('Host 가 다르면 403 — DNS rebinding 방어', async () => {
    // fetch() 는 Host 를 금지 헤더로 막아서 못 바꾼다. 원시 요청으로 보낸다.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: `/api/bootstrap?t=${token}`, headers: { Host: 'evil.com' } },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  await t.test('토큰이 맞으면 통과하고 CORS 를 열지 않는다', async () => {
    const r = await get(`/api/bootstrap?t=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const body = await r.json();
    assert.ok(Array.isArray(body.profiles));
    assert.ok(body.settings.slowWarn > 0 && body.settings.slowBad > 0);
  });

  await t.test('URL 에 토큰이 실려 있다', () => {
    assert.ok(url.includes(`t=${token}`));
    assert.ok(url.startsWith('http://127.0.0.1:'));
  });

  await t.test('없는 경로는 404', async () => {
    assert.equal((await get(`/api/nope?t=${token}`)).status, 404);
  });
});

test('페이지는 자체 완결이다 — 외부 요청이 없어야 한다', () => {
  const html = renderPage('tok');
  const external = [...html.matchAll(/https?:\/\/[^"'\s)]+/g)]
    .map((m) => m[0])
    .filter((u) => !u.startsWith('http://127.0.0.1'))
    // SVG 네임스페이스는 식별자일 뿐 가져오지 않는다 (인라인 favicon 에 필요)
    .filter((u) => u !== 'http://www.w3.org/2000/svg');
  assert.deepEqual(external, [], `외부 URL 발견: ${external.join(', ')}`);
  assert.ok(!/<script[^>]+src=/.test(html), '외부 스크립트 금지');
  // link 는 favicon 하나만, 그것도 data: 여야 한다 — 파일을 가리키면 요청이 생긴다
  const links = [...html.matchAll(/<link[^>]+href="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(links.length, 1, 'link 는 인라인 favicon 하나뿐이어야 한다');
  assert.ok(links[0].startsWith('data:image/svg+xml,'), `외부 리소스를 가리킨다: ${links[0].slice(0, 40)}`);
});

/**
 * 없으면 브라우저가 /favicon.ico 를 찾아가 404 를 받는다.
 * CSP 가 default-src 'none' 이라 img-src data: 를 열어 주지 않으면 아이콘이 안 뜬다.
 */
test('탭 아이콘이 있고 CSP 가 그걸 허용한다', async () => {
  const html = renderPage('tok');
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);

  // viewBox 가 없으면 300x150 캔버스 구석에 박혀 조용히 뭉개진다.
  // (실제로 한 번 sc-camel-view-box 로 변형된 채 들어온 적이 있다)
  const svg = decodeURIComponent(/href="data:image\/svg\+xml,([^"]+)"/.exec(html)[1]);
  assert.match(svg, /<svg[^>]+viewBox='0 0 32 32'/, `viewBox 가 없거나 이름이 바뀌었다: ${svg.slice(0, 80)}`);

  const { server, port, token } = await startWebServer({ port: 0, open: false, idleMinutes: 0, log: () => {} });
  try {
    const csp = (await fetch(`http://127.0.0.1:${port}/?t=${token}`)).headers.get('content-security-policy');
    assert.match(csp, /img-src data:/, 'CSP 가 인라인 아이콘을 막는다');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('상단은 소스 pill · 날짜 팝오버 · 타임라인 구조다', () => {
  const html = renderPage('tok');
  for (const id of ['id="src"', 'id="srcpop"', 'id="cal"', 'id="calpop"', 'id="tl"', 'id="bars"']) {
    assert.ok(html.includes(id), `누락: ${id}`);
  }
  // 옛 구조가 남아 있으면 두 벌이 공존하며 조용히 어긋난다
  for (const gone of ['id="drop"', 'id="profile"', 'data-preset', 'datetime-local', 'class="chip"']) {
    assert.ok(!html.includes(gone), `지웠어야 할 것이 남음: ${gone}`);
  }
});

/**
 * 상태는 상단 한 곳에서만 읽는다. 예전 footer 는 CLI 명령을 복사해 주는 자리였는데,
 * CLI 자체가 없어져서 **존재하지 않는 명령**(milog search --error -s …)을 띄우고 있었다.
 */
test('footer 는 없고 상태는 상단 표시기에 모인다', () => {
  const html = renderPage('tok');
  assert.ok(!/<footer>/.test(html), 'footer 가 남아 있다');
  assert.ok(!/id="cmd"/.test(html), '없어진 CLI 명령을 여전히 보여준다');
  // 자동 스크롤은 헤더의 알약 토글
  assert.match(html, /<button id="follow"/);
  assert.match(html, /\$\('#follow'\)\.classList\.contains\('on'\)/);
  // 끝나도 결과를 남긴다 — 다음 조회 시작 때 초기화
  assert.match(html, /\$\('#live'\)\.style\.display = runAt \? '' : 'none'/);
  assert.match(html, /runAt = Date\.now\(\); stoppedMs = 0;/);
});

/**
 * 검색어와 에러를 한 조회에 섞으면 CloudWatch 가 텍스트 패턴을 못 써서
 * 검색어가 message/logger/span.name 세 필드만 훑는 좁은 검색으로 조용히 바뀐다.
 * 실측: 같은 trace_id 가 --grep 만이면 37줄, --grep --error 면 0줄.
 * 그래서 화면에서 아예 못 섞게 모드를 셋으로 나눠 둔다.
 */
test('모드는 셋이고 검색어와 에러는 섞이지 않는다', () => {
  const html = renderPage('tok');
  for (const m of ['data-mode="tail"', 'data-mode="grep"', 'data-mode="error"']) {
    assert.ok(html.includes(m), `모드 누락: ${m}`);
  }
  assert.ok(!html.includes('id="errBtn"'), '에러 토글이 남아 있으면 검색어와 섞인다');
  assert.match(html, /error: mode === 'error' \? '1' : ''/);
  assert.match(html, /grep: mode === 'grep' \? \$\('#term'\)\.value : ''/);
});

test('타임라인은 추가 요청 없이 받은 이벤트만 센다', () => {
  const html = renderPage('tok');
  // 서버에 집계를 따로 요청하지 않는다 — 호출 경로는 tail/trace 둘뿐이어야 한다
  const calls = [...html.matchAll(/api\('(\/api\/[a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(),
    ['/api/bootstrap', '/api/groups', '/api/settings', '/api/tail', '/api/trace']);
  // 에러 판정은 서버 --error 와 같은 네 갈래여야 한다 (레벨만 보면 span 실패를 놓친다)
  assert.match(html, /'FATAL'.*status === 'ERROR'.*spanException/s);
});

/**
 * 목록은 훑는 화면이다. 속성을 세 개씩 잘라 붙여 봐야 시간·이름·소요시간을 읽는
 * 눈만 흐린다 — 궁금하면 trace_id 를 눌러 상세에서 전부 본다.
 */
test('목록에는 속성을 싣지 않는다', () => {
  const html = renderPage('tok');
  // 한 줄은 시간·레벨·trace·마커·이름·소요시간까지다
  assert.match(html, /\+ indent \+ mk \+ name \+ right\s*\n/);
  assert.ok(!/class="attr">' \+ esc\(parts/.test(html), '목록에 속성 칸이 되살아났다');
  // 상세에는 표준·사용자 정의를 합쳐 전부 보여준다
  assert.match(html, /\.\.\.biz, \.\.\.\(ev\.attributes \?\? \{\}\), \.\.\.biz/);
  // 트리 상세의 7개 키 allowlist 가 되살아나면 그 밖의 속성이 다시 안 보인다
  assert.ok(!/const keep = \[/.test(html), '속성 allowlist 가 남아 있다');
});

/**
 * OTel 계측의 code.function/code.namespace 는 span 이름을 그대로 다시 적는다.
 * 실측: code.* 가 있는 20건 전부 span 이름 == namespace끝.function (예외 0건).
 * 상세 패널에도 span 이름이 바로 위에 있으니 두 번 적을 이유가 없다.
 * 다만 span 이름을 다르게 붙이는 경우도 있으므로 겹칠 때만 숨겨야 한다.
 */
test('span 이름이 이미 말하는 속성은 숨긴다 — 겹칠 때만', () => {
  const html = renderPage('tok');
  assert.match(html, /function restatesName\(key, value, spanName\)/);
  assert.match(html, /restatesName\(k, merged\[k\], ev\.spanName\)[\s\S]{0,40}delete merged\[k\]/);
  // 무조건 지우면 span 이름이 다른 경우에 정보를 잃는다 — 반드시 비교해야 한다
  assert.match(html, /spanName === value \|\| spanName\.endsWith/);
});

/**
 * DB span 에는 매 쿼리마다 같은 접속 정보가 통째로 붙는다 — 호스트·포트·계정·스키마.
 * 쿼리를 읽는 데 도움이 안 되면서, db.connection_string 과 server.address 는
 * 내부 엔드포인트를 화면에 그대로 띄운다. 볼 것은 db.statement 하나다.
 */
test('DB 접속 정보는 숨기고 쿼리문만 남긴다', () => {
  const html = renderPage('tok');
  assert.match(html, /function isPlumbing\(key, \{ isDb, hasStatement \}\)/);
  // server.* 는 HTTP 호출 span 에서 '어느 서비스가 죽었나' 라 DB 일 때만 숨겨야 한다
  assert.match(html, /if \(!isDb \|\| key === 'db\.statement'\) return false/);
  // 쿼리문이 없으면 연산·테이블이라도 남겨야 빈 줄이 안 된다
  assert.match(html, /!hasStatement && \(key === 'db\.operation' \|\| key === 'db\.sql\.table'\)/);
  // 판정을 지우면서 다시 보면 db.system 을 지운 순간 DB span 이 아니게 된다
  assert.match(html, /const shape = \{/);
});

/**
 * 스택에서 '내 코드' 를 강조하는 규칙이 페이지에 리터럴로 박혀 있으면
 * 쓰는 사람이 자기 패키지를 지정할 방법이 없다. 서버가 내려준 값을 써야 한다.
 */
test('스택 강조 패키지는 하드코딩이 아니라 설정에서 온다', () => {
  const html = renderPage('tok');
  assert.match(html, /CFG\.appPackages\.some/);
  assert.match(html, /CFG\.appPackages = String\(SET\.appPackages/);
});

test('날짜는 오프셋을 붙여 보낸다 — 안 붙이면 UTC 자정으로 9시간 밀린다', () => {
  const html = renderPage('tok');
  assert.match(html, /'T00:00:00' \+ offset/);
  assert.match(html, /'T23:59:59' \+ offset/);
});

/**
 * 진행 표시는 %를 그리지 않는다. CloudWatch 는 매치 0건 페이지에서 스캔 위치를
 * 알려주지 않아, 드문 조건(에러 등)이면 진행률이 멈춘 채 거짓말이 된다.
 * 대신 '언제나 움직이는' 값만 쓴다 — 경과·요청·수신.
 */
test('진행 표시는 진행률(%)이 아니라 활동을 보여준다', () => {
  const html = renderPage('tok');
  assert.ok(html.includes('id="prog"'), '도는 중 표시가 없다');
  // 경과는 서버가 조용해도 움직여야 하므로 클라이언트 타이머가 필수다
  assert.match(html, /runTimer = setInterval\(/);
  assert.match(html, /drawRunState\(\);\s*\}, live \? 1000 : 250\)/);
  assert.match(html, /runAt = Date\.now\(\)/);
  // 레이아웃이 밀리면 조회할 때마다 화면이 튄다 — absolute 로 띄운다
  assert.match(html, /#prog\{position:absolute/);
  // 예전에 뺐던 커서 기반 진행률이 되살아나지 않았는지
  assert.ok(!/pct/.test(html), '진행률 % 계산이 다시 들어왔다');
});

/**
 * 실시간을 켜 두고 그 서비스를 보러 다른 탭으로 가는 게 가장 흔한 사용법이다.
 * 탭 전환에 스트림을 묶으면 정작 재현하는 동안 로그가 안 쌓여 '실시간' 이 무의미해진다.
 * 대신 '켜둔 채 잊기' 는 시간 제한으로 막는다 (CLI 의 --max-minutes 와 같은 역할).
 */
test('탭 전환으로 실시간이 끊기지 않는다', () => {
  const html = renderPage('tok');
  assert.ok(!/addEventListener\('visibilitychange'/.test(html), '탭 전환 감시가 남아 있다');
  assert.ok(!/document\.hidden/.test(html), '탭 전환 감시가 남아 있다');
  // 감시를 뺀 대신 안전장치는 반드시 있어야 한다 — 없으면 잊은 탭이 밤새 긁는다
  assert.match(html, /const tailMaxMs = \(\) =>/);
  assert.match(html, /Date\.now\(\) - runAt >= tailMaxMs\(\)/);
  // 자동 정지가 있는데 안 보이면 갑자기 끊긴 것처럼 느껴진다 — 남은 시간을 띄운다
  assert.match(html, /fmtCountdown\(left\)/);
  // 시계가 5초씩 튀면 고장으로 보인다
  assert.match(html, /live \? 1000 : 250/);
  // 조용히 끊으면 '로그가 안 오네' 로 오해한다 — 왜 멈췄는지 말해야 한다
  assert.match(html, /실시간 추적을 멈췄습니다/);
});

test('페이지가 CLI 의 렌더링 계약을 따른다', () => {
  const html = renderPage('tok');
  // trace 식별자는 앞이 아니라 뒤 12자리 (앞 8자리는 생성 시각이라 구분이 안 된다)
  assert.match(html, /slice\(-12\)/);
  // 색은 해시가 아니라 처음 본 순서대로
  assert.match(html, /next\+\+/);
  // tier 마커
  for (const marker of ['● ', '↳ ', '⇡ ', '· ']) assert.ok(html.includes(marker), `마커 누락: ${marker}`);
});
