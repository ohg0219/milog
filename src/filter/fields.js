/**
 * 필드 레지스트리.
 *   fp  = FilterLogEvents 필터 패턴 선택자
 *   get = 클라이언트측 접근자 (서버에서 못 거른 조건용)
 *
 * 조회 조건 플래그는 셋뿐이지만(`--error` `--grep` `--trace`), 그것들이 컴파일되는
 * 대상 필드는 여기 모아 둔다. -f 로 직접 패턴을 줄 때 참고할 목록이기도 하다.
 */
export const FIELDS = {
  level: { fp: '$.level', type: 'string', get: (e) => e.level },
  logger: { fp: '$.logger', type: 'string', get: (e) => e.logger },
  message: { fp: '$.message', type: 'string', get: (e) => e.message },
  span: { fp: '$.span.name', type: 'string', get: (e) => e.spanName },
  status: { fp: '$.span.status', type: 'string', get: (e) => e.status },
  trace: { fp: '$.context_map.trace_id', type: 'string', get: (e) => e.traceId },
  exClass: { fp: '$.exception.className', type: 'string', get: (e) => e.exception?.className },
  spanExClass: { fp: '$.span_exception.className', type: 'string', get: (e) => e.spanException?.className },
};

export const isAscii = (s) => /^[\x20-\x7E]*$/.test(String(s));
