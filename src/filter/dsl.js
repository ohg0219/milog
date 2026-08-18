import { UsageError } from '../util/errors.js';

/** OTel trace_id 는 32자리 hex 다. 그보다 짧으면 사용자가 화면에서 복사한 조각으로 본다. */
export const isFullTraceId = (s) => /^[0-9a-f]{32}$/i.test(String(s ?? ''));

/**
 * 플래그 → IR(AND 목록). OR 은 { any: [...] } 노드로 중첩한다.
 *
 * 조회 조건은 세 가지뿐이다 — trace_id, 검색어, 에러·예외.
 * 여기에 필드별 플래그를 늘리기 시작하면 "뭘 써야 할지 모르겠는" 상태로 돌아간다.
 * 더 세밀한 조건이 필요하면 -f 로 필터 패턴을 직접 준다.
 */
export function buildIR(v = {}) {
  const ir = [];

  if (v.error) {
    // '에러' 를 한 플래그로 덮는다. 레벨만 보면 span 실패를 놓치고,
    // status 만 보면 narration 의 log.error 를 놓친다.
    ir.push({ any: [
      { field: 'level', op: '=', value: 'ERROR' },
      { field: 'level', op: '=', value: 'FATAL' },
      { field: 'status', op: '=', value: 'ERROR' },
      { field: 'exClass', op: 'exists' },
      { field: 'spanExClass', op: 'exists' },
    ] });
  }

  if (v.trace) {
    // 화면에 보이는 짧은 id(뒤 8자리)를 그대로 복사해 쓸 수 있게 부분일치를 허용한다.
    ir.push({ field: 'trace', op: isFullTraceId(v.trace) ? '=' : 'contains', value: v.trace });
  }

  const terms = (Array.isArray(v.grep) ? v.grep : v.grep ? [v.grep] : [])
    .flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  for (const t of terms) ir.push({ text: t });

  if (v.filter && ir.length) {
    throw new UsageError('-f 는 다른 조회 조건과 함께 쓸 수 없습니다 (직접 준 패턴을 그대로 보냅니다).');
  }

  return ir;
}

/** 조회 조건이 하나라도 주어졌는지 — 마법사를 띄울지 판단하고, trace 명령이 거부하는 데 쓴다. */
export const DSL_FLAGS = ['error', 'trace', 'grep', 'filter'];
