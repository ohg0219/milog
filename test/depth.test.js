import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/model/event.js';
import { makeDepthResolver, assignDepths, orderByTrace } from '../src/model/depth.js';

const span = (name, id, parent, ts = 1000, dur = 1) => normalize({
  message: JSON.stringify({
    timestamp: '2026-08-13T17:22:51.129+09:00',
    level: 'INFO',
    logger: 'com.example.otel.WideEvent',
    span: { name, duration_ms: dur },
    context_map: { trace_id: 'T', span_id: id, ...(parent ? { parent_span_id: parent } : {}) },
  }),
  timestamp: ts,
});

const narration = (msg, spanId, ts = 1000) => normalize({
  message: JSON.stringify({
    timestamp: '2026-08-13T17:22:51.129+09:00',
    level: 'INFO',
    logger: 'com.example.Foo',
    message: msg,
    context_map: { trace_id: 'T', span_id: spanId },
  }),
  timestamp: ts,
});

test('중첩 단계마다 깊이가 하나씩 늘어난다', () => {
  const evs = [
    span('GET /', 'r', null),
    span('Intercept.preHandle', 'f', 'r'),
    span('Service.find', 't', 'f'),
    span('SELECT x', 's', 't'),
  ];
  assignDepths(evs);
  assert.deepEqual(evs.map((e) => e.depth), [0, 1, 2, 3]);
});

test('narration 은 감싸는 span 바로 아래에 놓인다', () => {
  const evs = [span('GET /', 'r', null), span('Svc.find', 't', 'r'), narration('안녕', 't')];
  assignDepths(evs);
  assert.deepEqual(evs.map((e) => e.depth), [0, 1, 2]);
});

test('조상이 조회 범위 밖이면 아는 만큼만 세고 그 사실을 표시한다', () => {
  const evs = [span('Svc.find', 't', 'missing')];
  assignDepths(evs);
  assert.equal(evs[0].depth, 0);
  // depth 0 이라고 root 인 건 아니다 — 렌더러가 ⇡ 로 구분한다.
  assert.equal(evs[0].parentMissing, true);
});

test('부모가 있으면 parentMissing 이 아니다', () => {
  const evs = [span('GET /', 'r', null), span('Svc.find', 't', 'r')];
  assignDepths(evs);
  assert.equal(evs[0].parentMissing, false);
  assert.equal(evs[1].parentMissing, false);
});

test('순환 사슬에서도 멈추지 않는다', () => {
  const evs = [span('a', 'A', 'B'), span('b', 'B', 'A')];
  assignDepths(evs);
  assert.ok(evs.every((e) => Number.isFinite(e.depth)));
});

test('흘려보낼 때는 조상이 온 만큼만 반영된다 (자식이 먼저 도착)', () => {
  const r = makeDepthResolver();
  const child = span('Svc.find', 't', 'r');
  const parent = span('GET /', 'r', null);

  // 자식이 먼저 온 시점에는 부모를 모르므로 0
  r.note(child);
  assert.equal(r.depthOf(child), 0);

  // 부모가 도착한 뒤에는 제대로 센다
  r.note(parent);
  assert.equal(r.depthOf(child), 1);
});

test('같은 틱으로 묶어 주면 흘려보내도 깊이가 정확하다', () => {
  const r = makeDepthResolver();
  const batch = [span('SELECT x', 's', 't'), span('Svc.find', 't', 'r'), span('GET /', 'r', null)];
  for (const e of batch) r.note(e); // 출력 전에 틱 전체를 먼저 훑는다
  assert.deepEqual(batch.map((e) => r.depthOf(e)), [2, 1, 0]);
});

test('--tree 는 부모를 항상 자식보다 먼저 낸다 — span 시작 직전에 찍힌 로그도', () => {
  // 실측 사례: commence 는 .385 에 끝나고 10ms 였으니 시작은 .375.
  // 그런데 narration 은 .374 — span 이 시작하기 1ms 전에 찍혔다.
  // 시작 시각으로만 정렬하면 자식 로그가 부모보다 위로 올라간다.
  const evs = [
    narration('인증 정보 없음', 'c', 374),
    span('OnCommitted.sendRedirect', 'o', 'c', 384, 9),
    span('EntryPoint.commence', 'c', 'r', 385, 10),
    span('GET /orders', 'r', null, 388, 18),
  ];
  assignDepths(evs);
  const ordered = orderByTrace(evs);
  assert.deepEqual(
    ordered.map((e) => e.spanName ?? e.message),
    ['GET /orders', 'EntryPoint.commence', '인증 정보 없음', 'OnCommitted.sendRedirect'],
  );
});

test('--tree 는 trace 별로 묶고 바깥에서 안쪽 순으로 세운다', () => {
  // 시간순으로는 자식(먼저 끝남)이 앞에 온다
  const evs = [
    span('SELECT x', 's', 't', 1005, 1),
    span('Svc.find', 't', 'r', 1006, 3),
    span('GET /', 'r', null, 1010, 10),
    span('GET /other', 'r2', null, 2000, 5),
  ];
  evs[3].traceId = 'U';
  const ordered = orderByTrace(evs);
  assert.deepEqual(ordered.map((e) => e.spanName), ['GET /', 'Svc.find', 'SELECT x', 'GET /other']);
});
