import { FIELDS, isAscii } from './fields.js';

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ── 백엔드 A: FilterLogEvents 필터 패턴 ──────────────────────────────────────
//
// 실측으로 확정한 제약:
//   · 긍정 존재는 EXISTS 가 아니라 = "*"      ({ $.span EXISTS } 는 문법 오류)
//   · NOT EXISTS 는 객체/중첩 경로 모두 동작
//   · 텍스트 패턴과 JSON 패턴은 한 요청에 못 섞는다
//   · 한글 값은 매칭이 미검증이라 클라이언트로 넘긴다

function leafPattern(n) {
  const f = FIELDS[n.field];
  if (!f?.fp) return null;

  switch (n.op) {
    case 'exists': return `${f.fp} = "*"`;
    case 'notexists': return `${f.fp} NOT EXISTS`;
    case 'contains':
      // 한글 값 매칭은 문법상 허용되나 실제 매칭이 미검증이라 클라이언트로 보낸다.
      return isAscii(n.value) ? `${f.fp} = ${q(`*${n.value}*`)}` : null;
    case '=':
      return f.type === 'number' ? `${f.fp} = ${Number(n.value)}` : `${f.fp} = ${q(n.value)}`;
    case '!=':
      return f.type === 'number' ? `${f.fp} != ${Number(n.value)}` : `${f.fp} != ${q(n.value)}`;
    case '>': case '>=': case '<': case '<=':
      return `${f.fp} ${n.op} ${Number(n.value)}`;
    default: return null;
  }
}

function nodePattern(n) {
  if (n.any) {
    const parts = n.any.map(leafPattern);
    if (parts.some((p) => p === null)) return null; // OR 은 전부 되거나 전부 안 되거나
    return `(${parts.join(' || ')})`;
  }
  return leafPattern(n);
}

/**
 * @returns {{pattern?: string, residual: object[], mode: 'json'|'text'|'none'}}
 */
export function compilePattern(ir) {
  const structured = ir.filter((n) => !n.text);
  const textual = ir.filter((n) => n.text);
  const residual = [];

  // 자유 텍스트만 있으면 텍스트 패턴이 최선이다 — 원본 줄 전체를 훑고 한글도 된다.
  if (structured.length === 0 && textual.length > 0) {
    return { pattern: textual.map((t) => q(t.text)).join(' '), residual: [], mode: 'text' };
  }

  const parts = [];
  for (const n of structured) {
    const s = nodePattern(n);
    if (s) parts.push(s);
    else residual.push(n);
  }

  // 구조 조건이 있으면 텍스트 패턴을 못 쓴다. ASCII 는 문자열 필드 OR 로 접어 넣고,
  // 한글은 클라이언트로 넘긴다.
  for (const t of textual) {
    if (isAscii(t.text)) {
      const r = reEsc(t.text);
      parts.push(`($.message = %${r}% || $.logger = %${r}% || $.span.name = %${r}%)`);
    } else {
      residual.push(t);
    }
  }

  return {
    pattern: parts.length ? `{ ${parts.join(' && ')} }` : undefined,
    residual,
    mode: parts.length ? 'json' : 'none',
  };
}

// ── 백엔드 C: 클라이언트측 잔여 술어 ────────────────────────────────────────

const cmp = {
  '=': (a, b) => String(a) === String(b),
  '!=': (a, b) => String(a) !== String(b),
  '>': (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
};

function leafTest(n, ev) {
  if (n.text) return ev.raw?.toLowerCase().includes(String(n.text).toLowerCase());
  const f = FIELDS[n.field];
  if (!f) return true;
  const v = f.get(ev);
  switch (n.op) {
    case 'exists': return v != null;
    case 'notexists': return v == null;
    case 'contains': return String(v ?? '').toLowerCase().includes(String(n.value).toLowerCase());
    default: return cmp[n.op]?.(v, n.value) ?? false;
  }
}

/** 잔여 IR → (ev) => boolean. 빈 목록이면 항상 true. */
export function compilePredicate(residual) {
  if (!residual?.length) return () => true;
  return (ev) => residual.every((n) => (n.any ? n.any.some((k) => leafTest(k, ev)) : leafTest(n, ev)));
}

/** 잔여가 왜 생겼는지 사람 말로 — 사용자가 데이터 전송량을 오해하지 않게. */
export function explainResidual(residual) {
  return residual.map((n) => {
    if (n.text) return `자유 텍스트 "${n.text}" (한글은 구조 조건과 함께 서버로 못 보냄)`;
    return `${n.field} ${n.op}`;
  });
}
