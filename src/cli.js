import { dispatch } from './args/parse.js';
import { mainHelp, commandHelp } from './args/help.js';
import { installEpipeGuard, writeLine, ui } from './util/out.js';
import { UsageError, MilogError, describe } from './util/errors.js';
import { maybeAutoUpdate } from './update.js';
import { version } from './version.js';

import { web } from './commands/web.js';
import { doctor } from './commands/doctor.js';

const HANDLERS = { web, doctor };

export async function main(argv) {
  installEpipeGuard();

  let parsed;
  try {
    parsed = dispatch(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      ui.error(e.message);
      ui.line('');
      ui.line(e.command ? commandHelp(e.command) : mainHelp());
      return 2;
    }
    throw e;
  }

  const { name, values, explicitCommand } = parsed;

  // 도움말·버전은 사용자가 명시적으로 요청한 결과물이므로 stdout 으로 나간다
  // (`milog --help | less` 가 동작해야 한다). 진단 출력만 stderr 다.
  if (values.help) { await writeLine(explicitCommand ? commandHelp(name) : mainHelp()); return 0; }
  if (values.version) { await writeLine(await version()); return 0; }
  if (values.quiet) ui.quiet = true;

  // 업데이트는 **명령을 시작하기 전에** 처리한다. 주 명령이 웹 서버라 Ctrl+C 로만
  // 끝나는데, 종료 시점에 걸어 두면 강제 종료 타이머에 잘려 영영 안 돈다.
  await maybeAutoUpdate();

  // Ctrl+C 는 이 도구의 정상 종료 경로다 (웹 서버를 그렇게 끈다).
  // 서버가 정리될 수 있게 abort 로 협조적으로 내려간다.
  const ac = new AbortController();
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    ac.abort();
    setTimeout(() => process.exit(130), 150);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);

  try {
    return await HANDLERS[name](values, { signal: ac.signal });
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, onSignal);
  }
}

export async function run(argv) {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      ui.error(err.message);
      return 2;
    }
    if (err instanceof MilogError) {
      ui.error(err.message);
      if (err.hint) ui.dim(`  ${err.hint}`);
      return err.exitCode ?? 1;
    }
    const d = describe(err);
    ui.error(d.text);
    if (d.hint) ui.dim(`  ${d.hint}`);
    if (process.env.MILOG_DEBUG === '1') ui.dim(err.stack ?? '');
    return d.cls === 'auth' ? 3 : d.cls === 'permission' ? 4 : 1;
  }
}
