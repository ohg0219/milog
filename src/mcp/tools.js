import { z } from 'zod';
import { discoverProfiles, findProfile, resolvePrefix } from '../aws/profiles.js';
import { findByFragment } from '../aws/groups.js';
import { buildIR } from '../filter/dsl.js';
import { resolveWindow } from '../args/time.js';
import { fetchEvents } from '../query.js';
import { buildTraceTree } from '../model/trace.js';
import { buildBase } from '../web/context.js';
import { MilogError, UsageError, describe } from '../util/errors.js';
import { summarizeErrors, renderTrace, renderLines, clip, clockText } from './format.js';

/**
 * 시작할 때 -p/-g 로 정한 범위. 여기서는 **AWS 를 부르지 않는다** — SSO 가 만료돼도
 * 서버는 떠서, 첫 호출에 "로그인하세요" 를 돌려줄 수 있어야 한다.
 */
export async function resolveScope(values) {
  const prefix = resolvePrefix(values.profilePrefix);
  let profile = null;
  if (values.profile) {
    const { profiles, exact } = await findProfile(values.profile, { prefix });
    if (!exact) {
      throw new MilogError(`프로필을 특정할 수 없습니다: ${values.profile}`, {
        hint: `후보: ${profiles.map((p) => p.name).join(', ')}`,
      });
    }
    profile = exact.name;
  }
  return {
    prefix,
    profile,
    region: values.region,
    groups: (values.group ?? []).flatMap((g) => String(g).split(',')).map((s) => s.trim()).filter(Boolean),
  };
}

/** 조각들 → 실제 그룹 이름. 정확 일치 우선, 조각 하나가 여러 그룹에 걸리면 **전부** 넣는다. */
function expand(fragments, names) {
  const out = new Set();
  const missing = [];
  for (const f of fragments) {
    const hits = names.includes(f) ? [f] : findByFragment(names, f);
    if (!hits.length) missing.push(f);
    hits.forEach((h) => out.add(h));
  }
  return { names: [...out], missing };
}

/**
 * 호출 하나에 쓸 컨텍스트. 시작 때 고정한 범위가 있으면 그 **안에서만** 좁힐 수 있다.
 */
async function contextFor(scope, args) {
  const profileName = scope.profile ?? args.profile;
  if (!profileName) {
    throw new MilogError('profile 이 필요합니다.', { hint: 'list_sources 로 프로필 목록을 먼저 보세요.' });
  }
  const exact = scope.profile ?? (await findProfile(profileName, { prefix: scope.prefix })).exact?.name;
  if (!exact) throw new MilogError(`프로필을 특정할 수 없습니다: ${profileName}`, { hint: 'list_sources 로 정확한 이름을 확인하세요.' });

  const base = await buildBase({ profileName: exact, region: scope.region });
  const all = base.allGroups.map((g) => g.name);

  const allowed = scope.groups.length ? expand(scope.groups, all).names : all;
  const asked = args.groups?.length ? args.groups : scope.groups;
  if (!asked.length) {
    throw new MilogError('groups 가 필요합니다.', { hint: 'list_sources 로 로그 그룹을 보고 이름(또는 조각)을 주세요.' });
  }
  const { names, missing } = expand(asked, allowed);
  if (missing.length) {
    throw new MilogError(`허용된 범위에 없는 로그 그룹: ${missing.join(', ')}`, {
      hint: scope.groups.length ? `이 서버는 ${allowed.join(', ')} 만 봅니다.` : 'list_sources 로 확인하세요.',
    });
  }
  return { base, groupNames: names };
}

/** 한 번의 tool 호출에 쓸 시간. AI 클라이언트는 몇 분씩 말없이 기다려 주지 않는다. */
export const BUDGET_MS = 90_000;
/** 동시에 훑는 그룹 수. FilterLogEvents 는 리전당 초당 요청 상한이 있다 (ap-northeast-2 실측 10). */
const CONCURRENCY = 6;

/**
 * 그룹마다 따로 받고, 상한(limit)도 **그룹마다** 건다.
 *
 * 전체에 상한 하나를 걸면 시끄러운 그룹 하나가 그걸 다 써 버린다 — 실측에서 크롤러 예외
 * 500건이 상한을 채워, 다른 서비스의 NPE 가 결과에서 통째로 사라졌다.
 *
 * 그렇다고 차례로 돌면 그룹별 시간이 전부 더해진다 — 3일 구간·12그룹에서 9분을 넘겼다.
 * 몇 개씩 동시에 돌리고, 시간 예산을 넘기면 받은 데까지로 끊고 **못 끝낸 그룹을 알린다.**
 */
async function fetchPerGroup({ base, groupNames }, {
  ir, values, startMs, endMs, limit, limitFor = () => limit, signal, budget = AbortSignal.timeout(BUDGET_MS),
}) {
  const sig = AbortSignal.any([signal, budget]);

  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < groupNames.length && !sig.aborted) {
      const g = groupNames[next++];
      let r;
      try {
        r = await fetchEvents({ ctx: { ...base, groupNames: [g] }, ir, values, startMs, endMs, limit: limitFor(g), signal: sig });
      } catch (err) {
        if (!sig.aborted) throw err;
        r = { events: [], truncated: false }; // 중간에 끊긴 SDK 요청 — 아래에서 '못 끝냄' 으로 잡힌다
      }
      results.push({ g, ...r, done: !sig.aborted });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groupNames.length) }, worker));

  const finished = new Set(results.filter((r) => r.done).map((r) => r.g));
  return {
    events: results.flatMap((r) => r.events).sort((a, b) => a.ts - b.ts),
    capped: results.filter((r) => r.truncated).map((r) => r.g),
    unfinished: budget.aborted ? groupNames.filter((g) => !finished.has(g)) : [],
  };
}

/** 최근부터 훑을 때 쓰는 조각 경계 — 지금에서 얼마나 거슬러 올라가는가. */
const STEPS_MS = [1, 6, 24, 72, 168, 336, 720].map((h) => h * 3_600_000);

/** [startMs, endMs] → 최근 쪽부터의 조각들. 가까운 쪽은 잘게, 먼 쪽은 크게. */
export function recentChunks(startMs, endMs) {
  const out = [];
  let hi = endMs;
  for (const step of STEPS_MS) {
    const lo = Math.max(startMs, endMs - step);
    if (lo < hi) { out.push([lo, hi]); hi = lo; }
    if (hi <= startMs) return out;
  }
  while (hi > startMs) {
    const lo = Math.max(startMs, hi - STEPS_MS.at(-1));
    out.push([lo, hi]);
    hi = lo;
  }
  return out;
}

/** 날짜를 콕 집어 준 게 아니면(상대값만 있으면) 최근부터 훑는다. */
export const isRelativeWindow = ({ since, until }) => !until && !/^\d{4}-\d{2}-\d{2}/.test(String(since ?? ''));

/**
 * 최근 쪽부터 조각씩 훑는다.
 *
 * FilterLogEvents 는 시작 시각부터 앞으로만 간다. 7일을 한 번에 주면 시간 예산이
 * 오래된 쪽에서 다 떨어져 **정작 오늘 로그에 닿지도 못한다** — 실측에서 '7일 0건' 인데
 * 같은 검색이 '1일' 에선 나왔다. 사람이 "최근 로그" 를 물을 때 원하는 건 최근 쪽이다.
 *
 * 그룹별 상한을 채운 그룹은 더 오래된 조각에서 뺀다.
 * 시간이 다 되면 어디까지 다 봤는지(reachedMs)를 돌려준다.
 */
async function fetchRecentFirst(c, { ir, values, startMs, endMs, limit, signal }) {
  const budget = AbortSignal.timeout(BUDGET_MS);
  const got = new Map();
  const events = [];
  const capped = new Set();
  let unfinished = [];
  let reachedMs = endMs;

  for (const [lo, hi] of recentChunks(startMs, endMs)) {
    const groupNames = c.groupNames.filter((g) => !capped.has(g));
    if (!groupNames.length || budget.aborted || signal.aborted) break;
    const r = await fetchPerGroup({ base: c.base, groupNames }, {
      ir, values, startMs: lo, endMs: hi, limitFor: (g) => limit - (got.get(g) ?? 0), signal, budget,
    });
    for (const e of r.events) got.set(e.group, (got.get(e.group) ?? 0) + 1);
    events.push(...r.events);
    r.capped.forEach((g) => capped.add(g));
    if (r.unfinished.length) { unfinished = r.unfinished; break; }
    reachedMs = lo;
  }

  return {
    events: events.sort((a, b) => a.ts - b.ts),
    capped: [...capped],
    unfinished,
    // 시간이 모자라 멈췄을 때만 알린다. 상한을 다 채워 멈춘 건 capped 가 이미 말한다.
    reachedMs: budget.aborted && reachedMs > startMs ? reachedMs : null,
  };
}

/** trace 가 생성 시각 뒤로 얼마나 이어질 수 있다고 보는가. 배치처럼 긴 trace 도 대개 이 안에 끝난다. */
const TRACE_AFTER_MS = 30 * 60_000;

/**
 * 32자리 trace_id → 찾아볼 구간. 이 시스템의 id 는 앞 8자리가 생성 시각(epoch 초, hex)이다
 * (실측: 6ad02bf5 → 10-15 10:27:17, 로그 시각과 초까지 일치).
 * 시각으로 말이 안 되는 값이면 null — 다른 규칙으로 만든 id 다.
 */
export function traceWindow(traceId, now = Date.now()) {
  if (!/^[0-9a-f]{32}$/i.test(String(traceId))) return null;
  const born = Number.parseInt(traceId.slice(0, 8), 16) * 1000;
  if (born < Date.UTC(2020, 0, 1) || born > now + 60_000) return null;
  // 앞쪽 1분 여유: 호출한 쪽과 시계가 조금 어긋나도 놓치지 않게.
  const startMs = born - 60_000;
  const endMs = Math.min(now, born + TRACE_AFTER_MS);
  return startMs < endMs ? { startMs, endMs } : null;
}

/** 상대 구간이면 최근부터, 날짜를 지정했으면 그 구간을 그대로. */
function fetchWindow(c, opts) {
  return isRelativeWindow(opts.values)
    ? fetchRecentFirst(c, opts)
    : fetchPerGroup(c, opts).then((r) => ({ ...r, reachedMs: null }));
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

/** 오류도 AI 가 읽고 다음 행동을 정할 수 있는 문장으로 돌려준다 — 특히 SSO 만료. */
function asToolError(err) {
  let msg;
  if (err instanceof MilogError) msg = err.hint ? `${err.message}\n${err.hint}` : err.message;
  else if (err instanceof UsageError) msg = err.message;
  else {
    const d = describe(err);
    msg = d.hint ? `${d.text}\n${d.hint}` : d.text;
  }
  return { ...text(msg), isError: true };
}

const safeCall = (fn) => async (args, extra) => {
  try {
    return await fn(args ?? {}, extra);
  } catch (err) {
    return asToolError(err);
  }
};

const TIME_HELP = "'30m' '2h' '1d' 'today' 처럼 지금 기준 상대값, 또는 ISO 시각('2026-10-13T10:00:00+09:00'). 상대값이고 until 이 없으면 최근 쪽부터 훑어, 시간이 모자라면 어디까지 봤는지 알려 줍니다";

/**
 * 새 버전 안내를 세션의 **첫 응답에 한 번만** 붙인다. 매번 붙이면 AI 가 매번 되풀이한다.
 * 확인이 아직 안 끝났으면 기다리지 않는다 — 다음 응답에 붙는다.
 */
function withUpdateNotice(scope, handler) {
  return async (args, extra) => {
    const result = await handler(args, extra);
    if (scope.noticeShown || !scope.update) return result;
    const n = await Promise.race([scope.update, Promise.resolve(undefined)]);
    if (n === undefined) return result; // 아직 확인 중
    scope.noticeShown = true;
    if (!n) return result;
    return {
      ...result,
      content: [...result.content, {
        type: 'text',
        text: `ℹ milog 새 버전 ${n.latest} 이 나왔습니다 (지금 ${n.current}). 사용자에게 알려 주세요 — `
          + '`npm i -g @ohg0219/milog@latest` 로 올린 뒤 MCP 서버를 다시 연결하면 됩니다.',
      }],
    };
  };
}

export function registerTools(server, scope) {
  const safe = (fn) => withUpdateNotice(scope, safeCall(fn));
  const fixed = [
    scope.profile ? `프로필 ${scope.profile}` : '',
    scope.groups.length ? `그룹 ${scope.groups.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const fixedNote = fixed ? ` 이 서버는 ${fixed} 로 범위가 고정돼 있습니다.` : '';

  const where = {
    ...(scope.profile ? {} : { profile: z.string().optional().describe('AWS 프로필 이름 (부분일치). list_sources 로 확인') }),
    groups: z.array(z.string()).optional().describe(
      scope.groups.length
        ? '고정 범위 안에서 더 좁힐 로그 그룹 이름 또는 조각. 비우면 고정 범위 전체'
        : '로그 그룹 이름 또는 조각 (조각 하나가 여러 그룹에 걸리면 전부)',
    ),
  };

  server.registerTool('list_sources', {
    title: '프로필·로그 그룹 목록',
    description: `조회할 수 있는 AWS 프로필과 CloudWatch 로그 그룹을 보여줍니다.${fixedNote}`,
    inputSchema: scope.profile ? {} : { profile: z.string().optional().describe('이 프로필의 로그 그룹까지 보기') },
  }, safe(async (args) => {
    const profileName = scope.profile ?? args.profile;
    const out = [];
    if (!scope.profile) {
      const { profiles } = await discoverProfiles({ prefix: scope.prefix });
      out.push('프로필:');
      for (const p of profiles) out.push(`  ${p.name}  ${p.region ?? ''}${p.label ? `  — ${p.label}` : ''}`);
      if (!profileName) {
        out.push('', '로그 그룹을 보려면 profile 을 주세요.');
        return text(out.join('\n'));
      }
      out.push('');
    }
    const exact = scope.profile ?? (await findProfile(profileName, { prefix: scope.prefix })).exact?.name;
    if (!exact) throw new MilogError(`프로필을 특정할 수 없습니다: ${profileName}`);
    const base = await buildBase({ profileName: exact, region: scope.region });
    const all = base.allGroups.map((g) => g.name);
    const shown = scope.groups.length ? expand(scope.groups, all).names : all;
    out.push(`${exact} (${base.region}) 로그 그룹 ${shown.length}개${scope.groups.length ? ' — 고정 범위' : ''}:`);
    for (const n of shown) out.push(`  ${n}`);
    return text(clip(out.join('\n')));
  }));

  server.registerTool('find_errors', {
    title: '에러 요약',
    description: [
      'ERROR·FATAL 레벨, 실패한 span, 예외가 있는 로그를 찾아 같은 종류끼리 묶어 많은 순으로 보여줍니다.',
      '각 묶음에 횟수·처음/마지막 시각·스택 앞부분·예시 trace_id 가 붙습니다. 원인을 파려면 그 trace_id 로 get_trace 를 부르세요.',
      '로그 줄 원문이 아니라 요약입니다. 구간이 길거나 그룹이 많으면 느리니 짧게 시작하세요.',
      fixedNote.trim(),
    ].filter(Boolean).join(' '),
    inputSchema: {
      ...where,
      since: z.string().default('1h').describe(`시작. ${TIME_HELP}. 기본 1h`),
      until: z.string().optional().describe('끝. 비우면 지금'),
      limit: z.number().int().min(1).max(5000).default(300).describe('그룹마다 최대로 받을 에러 줄 수. 기본 300'),
    },
  }, safe(async (args, extra) => {
    const c = await contextFor(scope, args);
    const values = { error: true, since: args.since ?? '1h', until: args.until };
    const { startMs, endMs } = resolveWindow(values);
    const limit = args.limit ?? 300;
    const { events, capped, unfinished, reachedMs } = await fetchWindow(c, {
      ir: buildIR(values), values, startMs, endMs, limit, signal: extra?.signal ?? new AbortController().signal,
    });
    return text(summarizeErrors(events, {
      capped, unfinished, reachedMs, budgetMs: BUDGET_MS, limit, usage: c.base.counters,
      window: `${values.since}${values.until ? ` ~ ${values.until}` : ' ~ 지금'}`,
    }));
  }));

  server.registerTool('search_logs', {
    title: '로그 검색',
    description: [
      '검색어가 들어간 로그 줄을 시간순으로 보여줍니다 (레벨 무관). 주문번호·사용자 id·URL·메시지 문구로 특정 요청을 따라갈 때 씁니다.',
      '검색어는 원본 줄 전체에서 찾고 한글도 됩니다. 대소문자를 구분합니다. 콤마로 여러 개를 주면 모두 들어간 줄만 찾습니다.',
      '원본 줄은 JSON 이라 trace_id·span_id·소요시간까지 다 들어 있습니다 — 숫자 값만 따로 주면(예: orderId,12345) trace_id 에 그 숫자가 든 엉뚱한 줄까지 걸립니다.',
      '키와 값은 로그에 찍힌 모양 그대로 붙여서 찾으세요: JSON 속성은 "orderId":12345, 메시지 안은 orderId=12345. 모양을 모르면 둘 다 불러 보세요. trace_id 를 검색어로 주는 것도 됩니다.',
      '에러만 보려면 find_errors 를 쓰세요 — 검색어와 에러 조건을 한 요청에 섞으면 CloudWatch 가 일부 필드만 훑어 답이 틀어집니다.',
      '줄마다 trace_id 가 붙으니 흐름 전체는 get_trace 로 보세요.',
      fixedNote.trim(),
    ].filter(Boolean).join(' '),
    inputSchema: {
      ...where,
      query: z.string().min(1).describe('검색어. 콤마로 여러 개 = 모두 포함 (AND)'),
      since: z.string().default('1h').describe(`시작. ${TIME_HELP}. 기본 1h`),
      until: z.string().optional().describe('끝. 비우면 지금'),
      limit: z.number().int().min(1).max(2000).default(100).describe('그룹마다 최대로 받을 줄 수. 기본 100'),
    },
  }, safe(async (args, extra) => {
    const c = await contextFor(scope, args);
    const values = { grep: [args.query], since: args.since ?? '1h', until: args.until };
    const { startMs, endMs } = resolveWindow(values);
    const limit = args.limit ?? 100;
    const { events, capped, unfinished, reachedMs } = await fetchWindow(c, {
      ir: buildIR(values), values, startMs, endMs, limit, signal: extra?.signal ?? new AbortController().signal,
    });
    return text(renderLines(events, {
      query: args.query, capped, unfinished, reachedMs, budgetMs: BUDGET_MS, limit, usage: c.base.counters,
      window: `${values.since}${values.until ? ` ~ ${values.until}` : ' ~ 지금'}`,
    }));
  }));

  server.registerTool('get_trace', {
    title: 'trace 상세',
    description: [
      '요청 하나(trace_id)를 span 트리로 보여줍니다. 시각은 trace 시작 기준 오프셋, 느린 span 과 예외·스택이 표시됩니다.',
      'trace_id 는 32자리 전체 또는 화면에 보이는 조각(6자 이상)도 됩니다.',
      '32자리 전체를 주면 since 없이도 됩니다 — trace_id 앞 8자리가 생성 시각이라 그 앞뒤만 찾습니다(며칠 전 trace 도 바로 열림).',
      '조각만 있으면 기본 최근 1시간에서 찾으니, 못 찾으면 since 를 넓히세요.',
      fixedNote.trim(),
    ].filter(Boolean).join(' '),
    inputSchema: {
      ...where,
      traceId: z.string().regex(/^[0-9a-f]{6,32}$/i).describe('trace_id (hex 6~32자)'),
      since: z.string().optional().describe(`시작. ${TIME_HELP}. 비우면 32자리 id 는 생성 시각 기준, 조각은 최근 1h`),
      until: z.string().optional().describe('끝. 비우면 지금'),
    },
  }, safe(async (args, extra) => {
    const c = await contextFor(scope, args);
    const signal = extra?.signal ?? new AbortController().signal;
    const ir = buildIR({ trace: args.traceId });
    const values = { trace: args.traceId };
    const fallback = () => resolveWindow({ since: args.since ?? '1h', until: args.until });

    // 구간을 안 줬고 전체 id 면, id 에 박힌 생성 시각 앞뒤만 본다.
    const born = !args.since && !args.until ? traceWindow(args.traceId) : null;
    let win = born ?? fallback();
    let r = await fetchPerGroup(c, { ir, values, ...win, limit: 10_000, signal });
    let range = born ? `trace_id 의 생성 시각 기준 ${clockText(win.startMs)} ~ ${clockText(win.endMs)}` : `${args.since ?? '1h'}${args.until ? ` ~ ${args.until}` : ' ~ 지금'}`;

    // 앞 8자리가 시각이 아닌 id(다른 시스템이 만든 무작위 id)면 엉뚱한 구간을 본 것이다 — 최근으로 한 번 더.
    if (!r.events.length && born) {
      win = fallback();
      r = await fetchPerGroup(c, { ir, values, ...win, limit: 10_000, signal });
      range = `생성 시각 구간에서 못 찾아 최근 1h 에서 다시 찾음`;
    }

    const { events, capped, unfinished } = r;
    const late = unfinished.length
      ? `⏱ ${BUDGET_MS / 1000}초 안에 다 훑지 못한 그룹: ${unfinished.join(', ')} — groups 나 구간을 좁혀 다시 부르세요.\n`
      : '';
    if (!events.length) {
      return text(`${late}trace ${args.traceId} 를 찾지 못했습니다 (${range}). since·until 로 구간을 주거나 groups 를 확인하세요.`);
    }
    const ids = [...new Set(events.map((e) => e.traceId).filter(Boolean))];
    const parts = [late, `구간: ${range}`].filter(Boolean);
    if (ids.length > 1) parts.push(`조각 '${args.traceId}' 에 trace ${ids.length}개가 걸렸습니다: ${ids.join(', ')} — 전체 id 로 다시 부르세요.\n`);
    if (capped.length) parts.push(`⚠ ${capped.join(', ')} 에서 10,000줄에 멈췄습니다 — 일부 span 이 빠졌을 수 있습니다.\n`);
    parts.push(renderTrace(buildTraceTree(events), { traceId: ids[0] ?? args.traceId, usage: c.base.counters }));
    return text(clip(parts.join('\n')));
  }));
}
