/**
 * trace 트리 구성.
 *
 * 중요한 전제: span 이벤트의 timestamp 는 span 이 *끝난* 시각이다(span.end() 에서
 * 발행되므로). 그래서 부모의 타임스탬프가 자식보다 항상 늦다. 완료 시각으로 정렬하면
 * 동시 실행 구간이 뒤집혀 보인다. 시작 시각을 되살려 정렬한다:
 *     start = timestamp - duration_ms
 */
export const startOf = (node) => node.ev.ts - (node.ev.durationMs ?? 0);

export function buildTraceTree(events) {
  const spans = new Map(); // span_id -> node
  const loose = [];

  for (const ev of events) {
    if (ev.tier === 'narration' || ev.tier === 'legacy' || !ev.spanId) { loose.push(ev); continue; }
    const prev = spans.get(ev.spanId);
    if (prev) { prev.dupes.push(ev); continue; } // 같은 span 이 두 그룹에 들어온 경우
    spans.set(ev.spanId, {
      id: ev.spanId,
      parentId: ev.parentSpanId ?? null,
      ev,
      children: [],
      logs: [],
      dupes: [],
      depth: 0,
      orphan: false,
      cycle: false,
    });
  }

  // narration 은 parent_span_id 를 구조적으로 갖지 않는다 — 자신의 span_id 가 가리키는
  // span 에 리프로 붙는 것이 유일한 연결 경로다.
  const unattached = [];
  for (const l of loose) {
    const host = l.spanId && spans.get(l.spanId);
    if (host) host.logs.push(l);
    else unattached.push(l);
  }

  const roots = [];
  for (const n of spans.values()) {
    if (n.parentId == null) { roots.push(n); continue; }
    const p = spans.get(n.parentId);
    if (p) p.children.push(n);
    else { n.orphan = true; roots.push(n); } // 부모가 조회 구간 밖 — 버리지 않는다
  }

  const cmp = (a, b) => startOf(a) - startOf(b)
    || (b.ev.durationMs ?? 0) - (a.ev.durationMs ?? 0)
    || String(a.id).localeCompare(String(b.id));

  const seen = new Set();
  const walk = (n, depth) => {
    if (seen.has(n.id)) { n.cycle = true; return; } // 망가진 체인에 매달리지 않는다
    seen.add(n.id);
    n.depth = depth;
    n.children.sort(cmp);
    n.logs.sort((a, b) => a.ts - b.ts);
    for (const c of n.children) walk(c, depth + 1);
  };

  roots.sort(cmp);
  for (const r of roots) walk(r, 0);

  // 순환에 갇혀 root 로 못 가는 노드도 드러낸다.
  for (const n of spans.values()) {
    if (!seen.has(n.id)) { n.orphan = true; roots.push(n); walk(n, 0); }
  }

  const all = [...spans.values()];

  return {
    roots,
    spans,
    unattached,
    orphanCount: all.filter((n) => n.orphan).length,
    t0: all.length ? Math.min(...all.map(startOf)) : 0,
    t1: all.length ? Math.max(...all.map((n) => n.ev.ts)) : 0,
    callerTraces: [...new Set(events.map((e) => e.callerTraceId).filter(Boolean))],
    totalSpans: all.length,
  };
}

/** 트리를 깊이우선 순서의 평탄한 배열로. 렌더러가 쓴다. */
export function flatten(tree) {
  const out = [];
  const visit = (n, prefixes, isLast) => {
    out.push({ node: n, prefixes, isLast });
    n.children.forEach((c, i) => visit(
      c,
      [...prefixes, isLast],
      i === n.children.length - 1,
    ));
  };
  tree.roots.forEach((r, i) => visit(r, [], i === tree.roots.length - 1));
  return out;
}
