import { startWebServer } from '../web/server.js';
import { ui } from '../util/out.js';

export async function web(values, { signal }) {
  const { server, url, port, openBrowser } = await startWebServer({
    port: Number(values.port ?? 0) || 0,
    open: !values.noOpen,
    idleMinutes: Number(values.idleMinutes ?? 30),
    log: (s) => ui.dim(s),
  });

  ui.line('');
  ui.ok(`  milog web  →  ${url}`);
  ui.dim('  127.0.0.1 에만 열려 있고, 토큰이 있어야 붙을 수 있습니다.');
  ui.dim('  Ctrl+C 로 종료. 브라우저 탭을 닫으면 폴링도 함께 멈춥니다.');
  ui.line('');

  if (!values.noOpen && !openBrowser()) {
    ui.warn('  브라우저를 자동으로 열지 못했습니다 — 위 주소를 직접 붙여넣으세요.');
  }

  // 서버가 살아 있는 동안 명령이 끝나지 않게 잡아 둔다.
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
    server.once('close', resolve);
  });

  await new Promise((r) => server.close(r));
  ui.dim(`  서버를 닫았습니다 (포트 ${port}).`);
  return 0;
}
