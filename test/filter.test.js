import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIR } from '../src/filter/dsl.js';
import { compilePattern, compilePredicate } from '../src/filter/compile.js';
import { normalize } from '../src/model/event.js';

const pat = (v) => compilePattern(buildIR(v)).pattern;

// 아래 기대값은 실제 로그 그룹 대상으로 실제 API 에 던져 확인한 문법이다.
// 문자열이 바뀌면 서버가 거부하거나 조용히 0건을 돌려주므로 리터럴로 고정한다.

test('--error 하나가 레벨·span 실패·예외를 모두 덮는다', () => {
  assert.equal(
    pat({ error: true }),
    '{ ($.level = "ERROR" || $.level = "FATAL" || $.span.status = "ERROR"'
    + ' || $.exception.className = "*" || $.span_exception.className = "*") }',
  );
});

test('긍정 존재는 = "*" 로 쓴다 (EXISTS 는 문법 오류)', () => {
  assert.match(pat({ error: true }), /\$\.exception\.className = "\*"/);
  assert.doesNotMatch(pat({ error: true }), /EXISTS/);
});

test('trace_id 전체는 정확 일치', () => {
  assert.equal(
    pat({ trace: '6a7e50e49d5276d03b0f82e6e9815d23' }),
    '{ $.context_map.trace_id = "6a7e50e49d5276d03b0f82e6e9815d23" }',
  );
});

test('화면에 보이는 짧은 trace_id 도 받는다', () => {
  assert.equal(pat({ trace: 'e9815d23' }), '{ $.context_map.trace_id = "*e9815d23*" }');
});

test('검색어만 있으면 텍스트 패턴 — 원본 줄 전체를 훑고 한글도 된다', () => {
  const r = compilePattern(buildIR({ grep: 'timeout' }));
  assert.equal(r.mode, 'text');
  assert.equal(r.pattern, '"timeout"');

  const ko = compilePattern(buildIR({ grep: '결제실패' }));
  assert.equal(ko.mode, 'text');
  assert.equal(ko.pattern, '"결제실패"');
});

test('텍스트와 구조 조건은 한 패턴에 못 섞는다 — ASCII 는 접어 넣는다', () => {
  const r = compilePattern(buildIR({ error: true, grep: 'timeout' }));
  assert.equal(r.mode, 'json');
  assert.match(r.pattern, /\$\.message = %timeout%/);
  assert.equal(r.residual.length, 0);
});

test('한글 검색어 + 구조 조건이면 한글은 클라이언트로 넘어간다', () => {
  const r = compilePattern(buildIR({ error: true, grep: '결제실패' }));
  assert.match(r.pattern, /\$\.level = "ERROR"/);
  assert.equal(r.residual.length, 1);
});

test('클라이언트 잔여 술어는 원본 줄에서 한글을 찾는다', () => {
  const ev = normalize({
    message: JSON.stringify({
      timestamp: '2026-08-13T10:00:00.000+09:00',
      level: 'ERROR',
      message: '결제실패: 시간 초과',
      context_map: { span_id: 'a', trace_id: 'b' },
    }),
    timestamp: 1,
  });
  const { residual } = compilePattern(buildIR({ error: true, grep: '결제실패' }));
  assert.equal(compilePredicate(residual)(ev), true);

  const { residual: miss } = compilePattern(buildIR({ error: true, grep: '환불' }));
  assert.equal(compilePredicate(miss)(ev), false);
});

test('-f 는 다른 조건과 함께 쓸 수 없다', () => {
  assert.throws(() => buildIR({ filter: '{ $.level = "INFO" }', error: true }), /함께 쓸 수 없습니다/);
});

test('조건이 없으면 패턴도 없다 (전체 조회)', () => {
  assert.equal(pat({}), undefined);
});
