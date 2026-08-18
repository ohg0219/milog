/**
 * CloudWatch 원본 이벤트 → 정규화 이벤트.
 *
 * 로그는 Log4j2 JsonTemplateLayout 이 찍은 JSON 한 줄이다.
 *
 * 한 스트림에 tier 3종이 섞여 있고, 구분자는 구조다:
 *   wide      span 있음 + parent_span_id 없음   (root span)
 *   call      span 있음 + parent_span_id 있음   (내부 메서드)
 *   narration span 키 자체가 없음               (log.info/error)
 *   legacy    JSON 이 아님                      (전환 중이거나 다른 포맷)
 */
export function normalize(raw, group = raw.group) {
  const text = raw.message ?? '';

  let body = null;
  if (text.charCodeAt(0) === 0x7b /* { */) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch {
      // JSON 이 아니면 legacy 로 흘린다 — 버리지 않는다.
    }
  }

  if (!body) {
    return {
      tier: 'legacy',
      group,
      stream: raw.logStreamName ?? raw.stream,
      eventId: raw.eventId,
      ts: raw.timestamp,
      tsText: null,
      message: text.replace(/\s+$/, ''),
      raw: text,
      late: raw.late ?? false,
    };
  }

  const cm = body.context_map ?? {};
  const span = body.span ?? null;

  return {
    tier: span == null ? 'narration' : (cm.parent_span_id ? 'call' : 'wide'),
    group,
    stream: raw.logStreamName ?? raw.stream,
    eventId: raw.eventId,

    // ts 는 정렬·커서용(CloudWatch epoch ms). 화면에는 tsText 를 쓴다.
    ts: raw.timestamp ?? (body.timestamp ? Date.parse(body.timestamp) : undefined),
    // +09:00 이 이미 박혀 있다. 재변환하지 않고 문자열 그대로 보관한다.
    tsText: body.timestamp ?? null,

    level: body.level,
    logger: body.logger,
    thread: body.thread,
    host: body.host_name,
    service: body.service_name,
    message: body.message ?? '',

    span,
    spanName: span?.name,
    durationMs: typeof span?.duration_ms === 'number' ? span.duration_ms : undefined,
    status: span?.status,
    attributes: span?.attributes ?? null,

    traceId: cm.trace_id,
    spanId: cm.span_id,
    parentSpanId: cm.parent_span_id,
    sessionId: cm.session_id,
    callerTraceId: cm.caller_trace_id,
    callerSpanId: cm.caller_span_id,

    exception: body.exception ?? null,
    spanException: body.span_exception ?? null,
    business: body.business_attributes ?? null,

    raw: text,
    body,
    late: raw.late ?? false,
  };
}

/** 화면에 쓸 짧은 시각. tsText 는 '2026-08-13T10:16:00.031+09:00' 꼴. */
export function timeText(ev, { withDate = false } = {}) {
  if (ev.tsText && ev.tsText.length >= 23) {
    return withDate ? ev.tsText.slice(5, 23).replace('T', ' ') : ev.tsText.slice(11, 23);
  }
  if (!Number.isFinite(ev.ts)) return '';
  // legacy 경로: epoch 뿐이라 로컬 시각으로 보여준다.
  const d = new Date(ev.ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  return withDate ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hms}` : hms;
}

/** 이벤트에서 dotted path 로 값 꺼내기 — --fields 용. 한글 키도 그대로 동작한다. */
export function pluck(ev, dotted) {
  const direct = { time: ev.tsText, level: ev.level, service: ev.service, group: ev.group };
  if (dotted in direct) return direct[dotted];

  let cur = ev.body ?? ev;
  const parts = dotted.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    // span.attributes 는 'code.function' 처럼 점이 든 평면 키를 쓴다.
    // 중첩으로 착각해 파고들기 전에, 남은 경로를 통째로 키로 먼저 시도한다.
    const rest = parts.slice(i).join('.');
    if (Object.hasOwn(cur, rest)) return cur[rest];
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * span.attributes 는 'code.function' 같이 점이 든 평면 키를 쓴다.
 * 중첩으로 착각해 파고들지 않도록 전용 접근자를 둔다.
 */
export function attr(ev, key) {
  return ev.attributes ? ev.attributes[key] : undefined;
}
