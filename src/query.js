import { compilePattern, compilePredicate, explainResidual } from './filter/compile.js';
import { pollLogEvents, pollDefaults } from './aws/poll.js';
import { normalize } from './model/event.js';
import { ui } from './util/out.js';

/**
 * 이벤트를 한 번에 모아 온다 (search / trace 용, follow 없음).
 *
 * 조회 경로는 FilterLogEvents 하나뿐이다 — 조회 API 는 요청당 과금이 없고,
 * 서버측 필터링 후 매치만 전송된다.
 */
export async function fetchEvents({ ctx, ir, startMs, endMs, limit, values, signal }) {
  const { pattern, residual } = values.filter
    ? { pattern: values.filter, residual: [] }
    : compilePattern(ir);

  reportResidual(residual);
  const predicate = compilePredicate(residual);
  const events = [];

  const iter = pollLogEvents({
    client: ctx.client,
    groups: ctx.groupNames,
    filterPattern: pattern,
    startMs,
    cfg: {
      ...pollDefaults,
      follow: false,
      endMs,
      maxPagesPerTick: 500,
      // 필요한 만큼만 받는다. 예전엔 상한과 무관하게 구간 전체를 긁어와서
      // 200건 보여주려고 9.9 MB 를 받는 일이 있었다.
      // 서버에서 못 거른 조건이 있으면 그만큼 더 봐야 하므로 여유를 둔다.
      maxEventsPerTick: residual.length ? Math.max(limit * 20, 50_000) : limit,
      pageSize: residual.length ? 10_000 : Math.min(10_000, Math.max(50, limit)),
    },
    counters: ctx.counters,
    signal,
  });

  // 상한에 걸려 멈췄는지 기억한다 — 조용히 자르면 "이게 전부" 로 오해한다.
  let truncated = false;

  outer:
  for await (const batch of iter) {
    for (const raw of batch) {
      const ev = normalize(raw);
      if (!predicate(ev)) continue;
      events.push(ev);
      if (events.length >= limit) { truncated = true; break outer; }
    }
  }
  return { events, pattern, truncated };
}

/** 서버에서 못 거른 조건이 있으면 알린다 — 전송량이 늘어나는 걸 모르고 있으면 안 된다. */
export function reportResidual(residual) {
  if (!residual?.length) return;
  ui.warn('  일부 조건은 서버에서 걸 수 없어 클라이언트에서 거릅니다 (전송량이 늘어납니다):');
  for (const r of explainResidual(residual)) ui.dim(`    · ${r}`);
}
