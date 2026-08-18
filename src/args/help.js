import { COMMANDS, GLOBAL } from './spec.js';

const flagText = (name, o) => {
  const short = o.short ? `-${o.short}, ` : '    ';
  const arg = o.type === 'string' ? ' <값>' : '';
  return `  ${short}--${name}${arg}`;
};

function section(title, spec) {
  const rows = Object.entries(spec).map(([n, o]) => [flagText(n, o), o.desc]);
  const w = Math.max(...rows.map(([l]) => l.length));
  return [`\n${title}`, ...rows.map(([l, d]) => `${l.padEnd(w)}  ${d}`)].join('\n');
}

/**
 * 조회 조건·출력 형식은 전부 브라우저 화면에서 고른다.
 * 그래서 도움말도 "어떻게 띄우나" 만 말하면 된다 — 짧을수록 좋다.
 */
export function mainHelp() {
  return `milog — CloudWatch JSON 로그를 브라우저에서

  milog                       로컬 서버를 띄우고 브라우저를 연다
  milog -p acme -g qa-web     프로필·그룹을 미리 고른 채로 시작
  milog --port 8080 --no-open 포트를 고정하고 창은 직접 열기
  milog doctor                환경 진단 (안 뜰 때 여기부터)

  화면에서 실시간·에러·검색 세 가지를 고르고, 날짜와 검색어를 정한다.

명령
${Object.entries(COMMANDS)
    .map(([n, c]) => `  ${(n + (c.args ? ` ${c.args}` : '')).padEnd(20)}${c.summary}`)
    .join('\n')}
${section('web 옵션', COMMANDS.web.opts)}
${section('공통 옵션', GLOBAL)}

환경 변수
  MILOG_APP_PACKAGES   스택 트레이스에서 강조할 패키지 접두사 (콤마 구분)
  MILOG_SLOW_MS        느림 판정 기준(ms). 기본 1000
  MILOG_NO_UPDATE=1    자동 업데이트 끄기
`;
}

export function commandHelp(name) {
  const cmd = COMMANDS[name];
  if (!cmd) return mainHelp();
  const defaults = Object.entries(cmd.defaults ?? {}).map(([k, v]) => `--${k} ${v}`).join('  ');

  return `milog ${name}${cmd.args ? ` ${cmd.args}` : ''} — ${cmd.summary}
${defaults ? `\n기본값: ${defaults}\n` : ''}${Object.keys(cmd.opts).length ? section(`${name} 옵션`, cmd.opts) : ''}
${section('공통 옵션', GLOBAL)}
`;
}
