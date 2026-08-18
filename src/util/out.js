import { once } from 'node:events';

/**
 * 페이로드는 stdout, 진단은 전부 stderr.
 * 이래야 `milog search --raw | grep ...` 이 깨끗하다.
 */

let epipeInstalled = false;
export function installEpipeGuard() {
  if (epipeInstalled) return;
  epipeInstalled = true;
  const quiet = (e) => {
    if (e?.code === 'EPIPE') process.exit(0);
  };
  process.stdout.on('error', quiet);
  process.stderr.on('error', quiet);
}

/**
 * backpressure 를 지키는 쓰기. 느린 소비자(파이프) 앞에서 버퍼가 무한히 크는 걸 막는다.
 */
export async function writeOut(text) {
  if (!process.stdout.write(text)) {
    try {
      await once(process.stdout, 'drain');
    } catch {
      /* 닫힌 파이프 — EPIPE 가드가 처리한다 */
    }
  }
}

export const writeLine = (text) => writeOut(`${text}\n`);

const isQuiet = () => process.env.MILOG_QUIET === '1';

export const ui = {
  set quiet(v) { process.env.MILOG_QUIET = v ? '1' : ''; },

  raw(text) { process.stderr.write(text); },
  line(text = '') { if (!isQuiet()) process.stderr.write(`${text}\n`); },
  info(text) { if (!isQuiet()) process.stderr.write(`${text}\n`); },
  dim(text) { if (!isQuiet()) process.stderr.write(`\x1b[2m${text}\x1b[0m\n`); },
  warn(text) { process.stderr.write(`\x1b[33m${text}\x1b[0m\n`); },
  error(text) { process.stderr.write(`\x1b[31m${text}\x1b[0m\n`); },
  ok(text) { if (!isQuiet()) process.stderr.write(`\x1b[32m${text}\x1b[0m\n`); },
};
