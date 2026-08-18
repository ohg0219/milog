import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { routes, streamTail } from './api.js';
import { renderPage } from './page.js';
import { describe, MilogError, UsageError } from '../util/errors.js';

const HOST = '127.0.0.1';

/** 길이가 달라도 타이밍이 새지 않게. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Host 헤더 검증 — DNS rebinding 방어.
 *
 * 127.0.0.1 에만 바인딩해도, 악성 페이지가 자기 도메인을 127.0.0.1 로 재바인딩하면
 * 사용자의 브라우저를 통해 이 서버에 붙을 수 있다. 그때 Host 는 attacker.com 이므로
 * 여기서 걸린다.
 */
function hostAllowed(req, port) {
  const host = String(req.headers.host ?? '');
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['start', ['""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const httpStatus = (err) => {
  if (err instanceof UsageError) return 400;
  if (err instanceof MilogError && err.exitCode >= 400 && err.exitCode < 600) return err.exitCode;
  const cls = describe(err).cls;
  return cls === 'auth' ? 401 : cls === 'permission' ? 403 : cls === 'notfound' ? 404 : cls === 'badinput' ? 400 : 500;
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function sendError(res, err) {
  const d = describe(err);
  sendJson(res, httpStatus(err), { error: err?.message ?? d.text, hint: err?.hint ?? d.hint ?? null });
}

/** SSE 한 줄 쓰기. 데이터에 개행이 있어도 프로토콜이 깨지지 않게 JSON 으로만 보낸다. */
function makeSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    get closed() { return closed; },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}

export async function startWebServer({ port = 0, open = true, idleMinutes = 30, log = console.error } = {}) {
  const token = randomUUID();
  let live = 0;
  let idleTimer = null;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }

    const actualPort = server.address()?.port;
    if (!hostAllowed(req, actualPort)) {
      return sendJson(res, 403, { error: 'forbidden host' });
    }
    // 교차 출처 fetch 를 막기 위해 CORS 헤더를 일부러 주지 않는다.

    const q = url.searchParams;
    if (!tokenMatches(q.get('t'), token)) {
      return sendJson(res, 403, { error: '토큰이 없거나 올바르지 않습니다.', hint: '터미널에 찍힌 주소로 접속하세요.' });
    }

    if (url.pathname === '/') {
      const buf = Buffer.from(renderPage(token), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-store',
        // 페이지는 자체 완결이다 — 외부 요청을 아예 막는다.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      });
      return res.end(buf);
    }

    // 요청 하나마다 별도 AbortController — 한 탭이 닫혀도 다른 스트림은 살아 있어야 한다.
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    q.signal = ac.signal;

    if (url.pathname === '/api/tail') {
      live += 1;
      clearTimeout(idleTimer);
      const sse = makeSse(res);
      const started = Date.now();
      log(`  실시간 시작 — ${q.get('groups')} (접속 ${live})`);
      try {
        await streamTail(q, sse);
      } catch (err) {
        if (!ac.signal.aborted) {
          const d = describe(err);
          sse.send('fatal', { error: err?.message ?? d.text, hint: err?.hint ?? d.hint ?? null });
        }
      } finally {
        live -= 1;
        // 여기까지 왔다는 건 폴링 루프가 실제로 끝났다는 뜻이다.
        // 탭을 닫으면 abort → 루프 종료 → 이 줄이 찍힌다.
        log(`  실시간 중지 — ${Math.round((Date.now() - started) / 1000)}초 (접속 ${live})`);
        res.end();
        scheduleIdleShutdown();
      }
      return undefined;
    }

    const handler = routes[url.pathname];
    if (!handler) return sendJson(res, 404, { error: 'not found' });

    try {
      return sendJson(res, 200, await handler(q));
    } catch (err) {
      if (ac.signal.aborted) return res.end();
      return sendError(res, err);
    }
  });

  function scheduleIdleShutdown() {
    clearTimeout(idleTimer);
    if (!idleMinutes || live > 0) return;
    // '켜둔 걸 잊는' 걸 막는 CLI 의 --max-minutes 에 해당하는 장치.
    idleTimer = setTimeout(() => {
      log(`  ${idleMinutes}분 동안 접속이 없어 서버를 종료합니다.`);
      server.close(() => process.exit(0));
    }, idleMinutes * 60_000);
    idleTimer.unref?.();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve); // 127.0.0.1 전용 — 외부에서 못 붙는다
  });

  const actualPort = server.address().port;
  const url = `http://${HOST}:${actualPort}/?t=${token}`;
  scheduleIdleShutdown();

  return { server, url, port: actualPort, token, openBrowser: () => open && openBrowser(url) };
}
