import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, pluck, timeText } from '../src/model/event.js';
import { buildTraceTree } from '../src/model/trace.js';
import { parseSelection, findByFragment } from '../src/aws/groups.js';

const ev = (body, ts = 1000) => normalize({ message: JSON.stringify(body), timestamp: ts }, 'g');

const WIDE = { timestamp: '2026-08-13T10:16:00.031+09:00', level: 'INFO', logger: 'com.example.otel.WideEvent', service_name: 'demo-web', message: 'x', span: { name: 'GET /', duration_ms: 68, status: 'UNSET' }, context_map: { trace_id: 't', span_id: 'root' } };
const CALL = { ...WIDE, span: { name: 'Svc.find', duration_ms: 8 }, context_map: { trace_id: 't', span_id: 'kid', parent_span_id: 'root' } };
const NARR = { timestamp: '2026-08-13T10:16:00.040+09:00', level: 'INFO', logger: 'com.example.Foo', message: '안녕', context_map: { trace_id: 't', span_id: 'kid' } };

test('tier 는 구조로 판별된다', () => {
  assert.equal(ev(WIDE).tier, 'wide');
  assert.equal(ev(CALL).tier, 'call');
  assert.equal(ev(NARR).tier, 'narration');
});

test('JSON 이 아닌 줄은 버리지 않고 legacy 로 남는다', () => {
  const e = normalize({ message: '2026/07/31 nginx 502 upstream timeout', timestamp: 5 }, 'g');
  assert.equal(e.tier, 'legacy');
  assert.match(e.message, /nginx 502/);
});

test('timestamp 는 재변환하지 않고 문자열을 그대로 쓴다 (+09:00 가 이미 박혀 있음)', () => {
  assert.equal(timeText(ev(WIDE)), '10:16:00.031');
});

test('pluck 은 점이 든 평면 키를 중첩으로 오해하지 않는다', () => {
  const e = ev({ ...WIDE, span: { ...WIDE.span, attributes: { 'code.function': 'renew' } } });
  assert.equal(pluck(e, 'span.attributes.code.function'), 'renew');
});

test('pluck 은 한글 키를 읽는다', () => {
  const e = ev({ ...WIDE, business_attributes: { '주문_취소_대상건수': 0 } });
  assert.equal(pluck(e, 'business_attributes.주문_취소_대상건수'), 0);
});

test('trace 트리는 parent_span_id 로 이어지고 narration 은 리프로 붙는다', () => {
  const t = buildTraceTree([ev(WIDE, 1068), ev(CALL, 1008), ev(NARR, 1005)]);
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].ev.spanName, 'GET /');
  assert.equal(t.roots[0].children.length, 1);
  assert.equal(t.roots[0].children[0].logs.length, 1);
  assert.equal(t.unattached.length, 0);
});

test('부모가 없는 span 은 버리지 않고 orphan 으로 올린다', () => {
  const t = buildTraceTree([ev(CALL, 1008)]);
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].orphan, true);
  assert.equal(t.orphanCount, 1);
});

test('span_id 가 안 맞는 narration 은 미연결로 남는다', () => {
  const t = buildTraceTree([ev(WIDE, 1068), ev({ ...NARR, context_map: { trace_id: 't', span_id: 'zzz' } }, 1005)]);
  assert.equal(t.unattached.length, 1);
});

test('순환 참조가 있어도 멈추지 않는다', () => {
  const a = { ...WIDE, span: { name: 'a', duration_ms: 1 }, context_map: { trace_id: 't', span_id: 'A', parent_span_id: 'B' } };
  const b = { ...WIDE, span: { name: 'b', duration_ms: 1 }, context_map: { trace_id: 't', span_id: 'B', parent_span_id: 'A' } };
  const t = buildTraceTree([ev(a), ev(b)]);
  assert.ok(t.roots.length >= 1);
});

test('선택 문법 1,3 / 1-3 / 공백 혼용', () => {
  assert.deepEqual(parseSelection('1,3', 5), [1, 3]);
  assert.deepEqual(parseSelection('1-3', 5), [1, 2, 3]);
  assert.deepEqual(parseSelection('1 3 1', 5), [1, 3]);
  assert.throws(() => parseSelection('9', 5));
});

test('퍼지 검색은 모든 토큰을 포함해야 한다 (AND)', () => {
  const items = ['/app/qa-web', '/app/prod-web', '/app/qa-api'];
  assert.deepEqual(findByFragment(items, 'qa web'), ['/app/qa-web']);
});
