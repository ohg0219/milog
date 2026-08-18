import { buildTraceTree } from './trace.js';

const MAX_TRACKED = 50_000;

/**
 * span 중첩 깊이 계산기.
 *
 * 이벤트 자신은 `parent_span_id` 로 '부모가 누구인지' 만 안다. 깊이를 알려면 조상
 * 사슬을 끝까지 타야 하므로, 본 span 들의 span_id → parent_span_id 를 모아 둔다.
 *
 * 주의: span 이벤트는 span 이 *끝날 때* 발행되므로 자식이 부모보다 먼저 도착한다.
 * 그래서 tail 처럼 흘려보내는 경우엔 조상이 아직 안 왔을 수 있고, 깊이가 실제보다
 * 얕게 나올 수 있다. search 처럼 한 번에 모아 오는 경우엔 정확하다.
 */
export function makeDepthResolver() {
  const parentOf = new Map();

  const note = (ev) => {
    if (!ev?.spanId) return;
    if (ev.tier !== 'wide' && ev.tier !== 'call') return;
    if (parentOf.has(ev.spanId)) return;

    parentOf.set(ev.spanId, ev.parentSpanId ?? null);
    if (parentOf.size > MAX_TRACKED) {
      // 오래 켜 두는 세션에서 무한히 크지 않게 앞쪽 절반을 버린다.
      let drop = Math.floor(MAX_TRACKED / 2);
      for (const k of parentOf.keys()) {
        if (drop-- <= 0) break;
        parentOf.delete(k);
      }
    }
  };

  /** id 자신을 1 로 세고 조상을 따라 올라간다. 아는 데까지만 센다. */
  const chainDepth = (id) => {
    let depth = 0;
    let cur = id;
    const seen = new Set();
    while (cur && parentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur); // 망가진 사슬에 매달리지 않는다
      depth += 1;
      cur = parentOf.get(cur);
    }
    return depth;
  };

  const depthOf = (ev) => {
    if (!ev) return 0;
    if (ev.tier === 'wide') return 0;
    if (ev.tier === 'call') return chainDepth(ev.parentSpanId);
    // narration 은 자신을 감싼 span 바로 아래에 놓는다.
    if (ev.tier === 'narration' && ev.spanId) return chainDepth(ev.spanId);
    return 0;
  };

  /**
   * 부모가 조회 범위 밖이라 깊이를 못 잰 call 이벤트인지.
   * 이걸 구분하지 않으면 root 와 같은 자리에 그려져 최상위처럼 보인다.
   */
  const parentMissing = (ev) => {
    if (ev?.tier !== 'call' || !ev.parentSpanId) return false;
    return !parentOf.has(ev.parentSpanId);
  };

  return { note, depthOf, parentMissing, get size() { return parentOf.size; } };
}

/** 이벤트 묶음 전체에 깊이를 매긴다 (두 번 훑어 정확하게). */
export function assignDepths(events) {
  const r = makeDepthResolver();
  for (const e of events) r.note(e);
  for (const e of events) {
    e.depth = r.depthOf(e);
    e.parentMissing = r.parentMissing(e);
  }
  return events;
}

const startOf = (e) => (e.ts ?? 0) - (e.durationMs ?? 0);

/**
 * trace 별로 묶고, 각 trace 안에서는 실제 부모-자식 트리를 깊이우선으로 편다.
 *
 * 기본 출력은 발생 시각순이라, span 이 끝날 때 기록되는 특성상 안쪽 span 이 먼저
 * 나온다 — 들여쓰기가 아래로 갈수록 얕아져 거꾸로 보인다.
 *
 * 시작 시각(ts - duration)으로 정렬하는 것만으로는 부족하다. narration 로그는
 * duration 이 없어서, 자기를 감싼 span 이 시작하기 직전에 찍힌 로그가 부모보다
 * 위로 올라간다. 트리를 만들어 펴면 부모가 항상 자식보다 먼저 온다.
 */
export function orderByTrace(events) {
  const buckets = new Map();
  for (const e of events) {
    const key = e.traceId ?? `~${e.eventId ?? ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const flattenTrace = (evs) => {
    const tree = buildTraceTree(evs);
    const out = [];
    const visit = (n) => {
      out.push(n.ev);
      for (const l of n.logs) out.push(l); // narration 은 자기 span 바로 아래
      for (const c of n.children) visit(c);
    };
    for (const r of tree.roots) visit(r);
    // 붙일 곳을 못 찾은 로그는 버리지 않고 뒤에 시간순으로 붙인다.
    out.push(...tree.unattached.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)));
    return out;
  };

  return [...buckets.values()]
    .map((evs) => ({ evs, first: Math.min(...evs.map(startOf)) }))
    .sort((a, b) => a.first - b.first)
    .flatMap(({ evs }) => flattenTrace(evs));
}
