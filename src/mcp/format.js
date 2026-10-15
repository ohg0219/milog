import { timeText } from '../model/event.js';
import { startOf } from '../model/trace.js';
import { slowThresholds, appPackages } from '../config.js';
import { formatBytes } from '../aws/client.js';

/**
 * MCP 응답용 텍스트.
 *
 * 웹 화면은 "자르지 않는다" 가 원칙이지만, 여기 독자는 AI 다 — 컨텍스트가 곧 비용이고
 * 같은 예외 300줄은 정보가 아니라 소음이다. 묶어서 세고, 스택은 앞부분만, 전체에 상한을 둔다.
 * 대신 **잘랐다는 사실은 반드시 적는다.** 조용히 자르면 "이게 전부" 로 오해한다.
 */

export const MAX_CHARS = 20_000;

/** 응답 전체 상한. 자른 자리에 무엇을 하면 되는지 적는다. */
export function clip(text, max = MAX_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (응답이 길어 ${(text.length - max).toLocaleString()}자를 잘랐습니다 — 구간이나 그룹을 좁히세요)`;
}

const oneLine = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 스택 트레이스를 앞 n줄로. 단 n 밖이라도 놓치면 안 되는 줄은 살린다:
 *   - `Caused by:` — 진짜 원인은 대개 여기 있다
 *   - MILOG_APP_PACKAGES 에 걸리는 프레임 — 프레임워크 프레임 사이에 묻힌 '내 코드'
 */
export function trimStack(stackTrace, n = 8, pkgs = appPackages()) {
  // 메시지에 응답 본문 덤프가 박힌 경우가 있다 — 한 줄이 수백 자면 그것만으로 컨텍스트를 먹는다.
  const lines = String(stackTrace ?? '').split(/\r?\n/).map((l) => oneLine(l, 240)).filter(Boolean);
  if (lines.length <= n) return lines;

  const keep = new Set(lines.slice(0, n).map((_, i) => i));
  lines.forEach((l, i) => {
    if (/^\s*Caused by:/.test(l)) { keep.add(i); if (i + 1 < lines.length) keep.add(i + 1); }
    else if (pkgs.length && /^\s*at /.test(l) && pkgs.some((p) => l.includes(p))) keep.add(i);
  });

  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      if (skipped) { out.push(`  … (${skipped}줄)`); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push(`  … (+${skipped}줄)`);
  return out;
}

const exOf = (ev) => ev.spanException ?? ev.exception ?? null;

/** 스택 첫 줄은 대개 'className: message' 라 바로 위에 찍은 제목과 겹친다. 프레임부터 보여준다. */
const framesOf = (ex, n) => {
  const lines = trimStack(ex.stackTrace, n + 1);
  return lines[0]?.startsWith(ex.className) ? lines.slice(1) : lines;
};

/** 같은 문제를 한 묶음으로. 메시지 안의 id·숫자가 달라도 같은 종류로 본다. */
function errorKey(ev) {
  const ex = exOf(ev);
  const msg = String(ex ? ex.message ?? '' : ev.message ?? '')
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return `${ev.group}\u0000${ex ? ex.className : ev.level}\u0000${msg}`;
}

const shortTime = (ev) => timeText(ev, { withDate: true }).slice(0, 14); // 'MM-DD HH:MM:SS'

const countByGroup = (events) => {
  const m = new Map();
  for (const e of events) m.set(e.group, (m.get(e.group) ?? 0) + 1);
  return m;
};

/**
 * 결과가 '어디까지 본 것인지' — 그룹별 건수, 상한에 걸린 그룹, 시간 안에 못 끝낸 그룹.
 * 이게 없으면 AI 는 받은 것을 전부로 믿는다.
 */
function coverage({ perGroup, capped = [], unfinished = [], reachedMs = null, budgetMs, limit }) {
  const out = [];
  if (perGroup.size) {
    // 시끄러운 그룹과 조용한 그룹을 한눈에 — 드문 것이 어디 있는지 여기서 먼저 보인다.
    out.push(`그룹별: ${[...perGroup].sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${g} ${n}${capped.includes(g) ? '+' : ''}`).join(' · ')}`);
  }
  if (capped.length) {
    out.push(`⚠ 그룹당 상한 ${Number(limit).toLocaleString()}건에서 멈춤: ${capped.join(', ')} — 이 그룹은 실제로 더 있습니다. 구간을 좁히세요.`);
  }
  const secs = Math.round(budgetMs / 1000);
  if (reachedMs != null) {
    // 최근부터 훑다 시간이 다 된 경우 — 여기서부터 지금까지는 다 봤고, 그 앞은 못 봤다.
    out.push(`⏱ ${secs}초 안에 ${clockText(reachedMs)} 이후만 다 훑었습니다. 그 이전은 보지 못했습니다 — 이전이 필요하면 until 로 구간을 지정하세요.`);
    if (unfinished.length) out.push(`  그 직전 구간을 훑다 멈춘 그룹: ${unfinished.join(', ')}`);
  } else if (unfinished.length) {
    out.push(`⏱ ${secs}초 안에 다 훑지 못한 그룹: ${unfinished.join(', ')} — 이 그룹들은 일부만 봤습니다. groups 나 구간을 좁혀 다시 부르세요.`);
  }
  return out;
}

/** epoch ms → 'MM-DD HH:MM' (로컬 시각). */
export const clockText = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 검색 결과 → 시간순 로그 줄.
 *
 * 에러와 달리 묶지 않는다 — 검색은 '그 요청에서 무슨 일이 있었나' 를 따라가는 용도라
 * 줄의 순서와 내용 자체가 답이다. 대신 한 줄에 필요한 것만 싣는다.
 * trace_id 는 전체를 쓴다 — 그대로 get_trace 에 넘길 수 있어야 한다.
 */
export function renderLines(events, { query, capped = [], unfinished = [], reachedMs = null, budgetMs, limit, usage, window } = {}) {
  const perGroup = countByGroup(events);
  const traces = new Set(events.map((e) => e.traceId).filter(Boolean));

  const out = [];
  out.push(`검색 "${query}" · ${events.length.toLocaleString()}줄 · trace ${traces.size}개 · 그룹 ${perGroup.size}개${window ? ` · ${window}` : ''}`);
  out.push(...coverage({ perGroup, capped, unfinished, reachedMs, budgetMs, limit }));
  if (!events.length) {
    out.push(unfinished.length || reachedMs != null ? '받은 범위 안에서는 찾지 못했습니다.' : '이 구간에서 찾지 못했습니다. 검색어는 대소문자를 구분합니다.');
  }

  const multiGroup = perGroup.size > 1;
  if (events.length) out.push('');
  let lastTrace = null;
  for (const ev of events) {
    // trace 가 바뀔 때만 적는다 — 한 요청의 줄이 이어질 때 32자를 매 줄 반복하지 않는다.
    if (ev.traceId && ev.traceId !== lastTrace) out.push(`── trace ${ev.traceId}`);
    lastTrace = ev.traceId ?? null;
    const head = `${timeText(ev, { withDate: true })} ${String(ev.level ?? '-').padEnd(5)}`;
    const where = [multiGroup ? ev.group.split('/').at(-1) : '', ev.logger ? shortLogger(ev.logger) : ''].filter(Boolean).join(' ');
    const span = ev.spanName ? ` [${ev.spanName}${ev.durationMs != null ? ` ${fmtMs(ev.durationMs)}` : ''}${ev.status === 'ERROR' ? ' ERROR' : ''}]` : '';
    const text = [spanMessageIsEcho(ev) ? '' : oneLine(ev.message, 300), details(ev)].filter(Boolean).join('  ');
    out.push(`${head} ${where}${span}${text ? `  ${text}` : ''}`);
    const ex = exOf(ev);
    if (ex) out.push(`    ✗ ${ex.className}: ${oneLine(ex.message, 200)}`);
  }

  if (usage) out.push('', usageLine(usage));
  return clip(out.join('\n'));
}

/**
 * 에러 이벤트 → 종류별 요약. 많은 순.
 * 위쪽 몇 종류에만 스택을 붙인다 — 아래로 갈수록 드문 것이라 한 줄이면 충분하다.
 */
export function summarizeErrors(events, { capped = [], unfinished = [], reachedMs = null, budgetMs, limit, usage, window, stackFor = 10 } = {}) {
  const buckets = new Map();
  for (const ev of events) {
    const k = errorKey(ev);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { n: 0, first: ev, last: ev, traces: new Set(), sample: ev }));
    b.n++;
    if (ev.ts < b.first.ts) b.first = ev;
    if (ev.ts > b.last.ts) b.last = ev;
    if (ev.traceId && b.traces.size < 3) b.traces.add(ev.traceId);
  }

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n || b.last.ts - a.last.ts);
  const perGroup = countByGroup(events);

  const out = [];
  out.push(`에러 ${events.length.toLocaleString()}건 · ${sorted.length}종류 · 그룹 ${perGroup.size}개${window ? ` · ${window}` : ''}`);
  out.push(...coverage({ perGroup, capped, unfinished, reachedMs, budgetMs, limit }));
  if (!events.length) out.push(unfinished.length || reachedMs != null ? '받은 범위 안에서는 에러가 없습니다.' : '이 구간에 에러가 없습니다.');

  sorted.forEach((b, i) => {
    const ex = exOf(b.sample);
    const what = ex ? `${ex.className}: ${oneLine(ex.message)}` : `${b.sample.level} ${b.sample.logger ?? ''} ${oneLine(b.sample.message)}`;
    const when = b.n === 1 ? shortTime(b.first) : `${shortTime(b.first)} ~ ${shortTime(b.last)}`;
    out.push('');
    out.push(`[${i + 1}] ${b.n}회  ${b.sample.group}  ${when}`);
    out.push(`    ${what}`);
    if (b.sample.spanName) out.push(`    span: ${b.sample.spanName}`);
    if (i < stackFor && ex?.stackTrace) {
      for (const l of framesOf(ex, 5)) out.push(`      ${l}`);
    }
    if (b.traces.size) out.push(`    trace: ${[...b.traces].join(', ')}`);
  });

  if (usage) out.push('', usageLine(usage));
  return clip(out.join('\n'));
}

export const usageLine = (u) =>
  `(CloudWatch 요청 ${u.requests}회 · ${formatBytes(u.bytes)}${u.estimated ? ' 근사' : ''})`;

const fmtMs = (ms) => (ms == null ? '' : `${Math.round(ms).toLocaleString()}ms`);

/**
 * trace 트리 → 들여쓴 텍스트.
 *
 * 시각은 trace 시작 기준 오프셋(+12ms)으로 쓴다. span 의 timestamp 는 *끝난* 시각이라
 * 그대로 찍으면 부모가 자식보다 늦게 보인다 — 트리와 같은 기준(start)으로 맞춘다.
 */
export function renderTrace(tree, { traceId, usage } = {}) {
  const { warn, bad } = slowThresholds();
  const out = [];
  const total = tree.t1 - tree.t0;
  const rootEv = tree.roots[0]?.ev;

  out.push(`trace ${traceId} · span ${tree.totalSpans}개 · ${fmtMs(total)}${rootEv?.tsText ? ` · ${rootEv.tsText.slice(0, 19).replace('T', ' ')}` : ''}`);
  if (rootEv?.service || rootEv?.group) out.push(`서비스 ${rootEv.service ?? '-'} · 그룹 ${rootEv.group}`);
  out.push('');

  const exLines = (ex, pad) => {
    const lines = [`${pad}✗ ${ex.className}: ${oneLine(ex.message, 300)}`];
    for (const l of framesOf(ex, 8)) lines.push(`${pad}    ${l}`);
    return lines;
  };

  const seen = new Set();
  const walk = (n, depth) => {
    if (seen.has(n.id)) return; // 순환 — buildTraceTree 가 표시만 하고 끊지는 않는다
    seen.add(n.id);
    const ev = n.ev;
    const pad = '  '.repeat(depth);
    const off = `+${fmtMs(startOf(n) - tree.t0)}`.padStart(9);
    const slow = ev.durationMs >= bad ? '  ⚠느림' : ev.durationMs >= warn ? '  △' : '';
    const err = ev.status === 'ERROR' ? '  ERROR' : '';
    const tags = [n.orphan ? '부모 없음' : '', n.cycle ? '순환' : '', n.dupes.length ? `중복 ${n.dupes.length}` : ''].filter(Boolean);
    out.push(`${off} ${String(ev.level ?? '').padEnd(5)} ${pad}${depth ? '↳' : '●'} ${ev.spanName ?? '(이름 없음)'}  ${fmtMs(ev.durationMs)}${slow}${err}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    const d = details(ev);
    if (d) out.push(`${' '.repeat(16)}${pad}  ${d}`);

    const ex = exOf(ev);
    if (ex) out.push(...exLines(ex, `${' '.repeat(16)}${pad}`));

    for (const l of n.logs) {
      out.push(`${' '.repeat(16)}${pad}  · ${String(l.level ?? '').padEnd(5)} ${shortLogger(l.logger)}  ${oneLine(l.message, 300)}`);
      const lex = exOf(l);
      if (lex) out.push(...exLines(lex, `${' '.repeat(16)}${pad}    `));
    }
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of tree.roots) walk(r, 0);

  if (tree.unattached.length) {
    out.push('', `span 에 붙지 못한 로그 ${tree.unattached.length}줄:`);
    for (const l of tree.unattached.slice(0, 30)) {
      out.push(`  ${timeText(l)} ${String(l.level ?? '').padEnd(5)} ${shortLogger(l.logger)}  ${oneLine(l.message, 300)}`);
    }
    if (tree.unattached.length > 30) out.push(`  … (+${tree.unattached.length - 30}줄)`);
  }
  if (tree.orphanCount) out.push('', `부모 span 이 조회 구간 밖인 span ${tree.orphanCount}개 — since 를 넓히면 이어질 수 있습니다.`);
  if (tree.callerTraces.length) out.push(`호출한 쪽 trace: ${tree.callerTraces.join(', ')}`);
  if (usage) out.push('', usageLine(usage));
  return clip(out.join('\n'));
}

/** 'com.acme.order.OrderService' → 'OrderService'. 줄 폭을 아낀다. */
const shortLogger = (l) => String(l ?? '').split('.').at(-1);

/** span 이벤트의 message 는 대개 'GET /checkout, 841 ms' — 이름과 소요시간을 다시 적은 것뿐이다. */
const spanMessageIsEcho = (ev) =>
  !!ev.spanName && String(ev.message ?? '').trim() === `${ev.spanName}, ${ev.durationMs} ms`;

/**
 * span 속성 중 넘길 것. 같은 `GET /checkout` 이라도 플로우 단계(url.query)·응답 코드가 다르고,
 * 그게 요청을 구분하는 실마리다. 나머지(스레드·user agent·포트·code.*)는 이름이나
 * 다른 값과 겹쳐 컨텍스트만 먹는다.
 */
const SPAN_KEYS = ['http.response.status_code', 'url.query', 'db.statement', 'error.type'];

/**
 * 줄에 붙일 핵심 값. business_attributes 는 **전부** 싣는다 — 개발자가 일부러 남긴 값이라
 * 무엇이 중요한지 도구가 판단할 수 없다 (화면의 "사용자 정의 속성은 절대 안 숨긴다" 와 같은 원칙).
 */
export function details(ev) {
  const parts = [];
  const a = ev.attributes ?? {};
  for (const k of SPAN_KEYS) {
    if (a[k] != null && a[k] !== '') parts.push(`${k}=${oneLine(a[k], 160)}`);
  }
  // 나가는 HTTP 호출(http.route 가 없음)의 대상은 '어느 서비스가 느렸나·죽었나' 다.
  // DB span 의 server.* 는 내부 엔드포인트라 화면과 같이 뺀다.
  const isDb = Object.keys(a).some((k) => k.startsWith('db.'));
  if (a['server.address'] && a['http.request.method'] && !a['http.route'] && !isDb) {
    parts.push(`server.address=${a['server.address']}`);
  }
  for (const [k, v] of Object.entries(ev.business ?? {})) {
    parts.push(`${k}=${typeof v === 'object' ? oneLine(JSON.stringify(v), 100) : oneLine(v, 100)}`);
  }
  return parts.join(' ');
}
