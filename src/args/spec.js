/**
 * 옵션 스펙. parseArgs 의 options 로 그대로 넘기고, 동시에 help 와
 * 타입 변환(coerce)의 근거로도 쓴다.
 *
 * 이 도구는 브라우저에서 보는 게 전부다 — 조회 조건·출력 형식은 전부 화면에서 고르므로
 * 명령줄에는 **서버를 어떻게 띄울지**와 **어디를 볼지**만 남긴다.
 */
const opt = (type, short, desc, meta = {}) => ({ type, short, desc, ...meta });

export const GLOBAL = {
  profile: opt('string', 'p', 'AWS 프로필 (부분일치 가능) — 화면의 첫 선택으로 쓴다'),
  group: opt('string', 'g', '로그 그룹 이름 또는 부분문자열 (반복/콤마)', { multiple: true }),
  region: opt('string', undefined, '리전 (미지정 시 프로필의 region)'),
  'profile-prefix': opt('string', undefined, '프로필 이름 접두어로 목록 좁히기'),

  quiet: opt('boolean', 'q', '진단 출력 억제'),
  help: opt('boolean', 'h', '도움말'),
  version: opt('boolean', 'V', '버전'),
};

export const COMMANDS = {
  web: {
    summary: '브라우저에서 로그 보기 (기본)',
    opts: {
      port: opt('string', undefined, '포트. 기본 0 = 빈 포트 자동'),
      'no-open': opt('boolean', undefined, '브라우저를 자동으로 열지 않음'),
      'idle-minutes': opt('string', undefined, '접속이 없으면 종료할 시간(분). 기본 30, 0=무제한'),
    },
    defaults: { port: '0', 'idle-minutes': '30' },
  },
  doctor: {
    summary: '환경 진단 (버전·Node·자격증명·터미널)',
    opts: {},
    defaults: {},
  },
};

export const ALIASES = {};

/** parseArgs 가 받는 형태로. desc 등 메타는 떼어낸다. */
export function toParseArgsOptions(spec) {
  const out = {};
  for (const [name, o] of Object.entries(spec)) {
    out[name] = { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) };
  }
  return out;
}
