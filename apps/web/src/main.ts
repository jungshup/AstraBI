import { createServer } from 'node:http';

const page = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#101827" />
  <title>AstraBI Foundation</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #101827; color: #e5edf8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(720px, 100%); }
    .eyebrow { color: #63d6b3; font-size: .8rem; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0; font-size: clamp(2.4rem, 8vw, 4.5rem); letter-spacing: -.06em; }
    p { color: #9eacc1; line-height: 1.65; }
    .card { margin-top: 32px; border: 1px solid #29364a; border-radius: 16px; padding: 24px; background: #172235; }
    .row { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid #29364a; }
    .row:last-child { border: 0; }
    .label { color: #9eacc1; }
    #state { color: #63d6b3; }
    code { color: #b9c9e0; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Foundation · v0.1</div>
    <h1>AstraBI</h1>
    <p>모듈형 분석 플랫폼의 첫 실행 가능한 기반입니다. API 연결 상태를 확인합니다.</p>
    <section class="card" aria-live="polite">
      <div class="row"><span class="label">서비스 상태</span><strong id="state">확인 중…</strong></div>
      <div class="row"><span class="label">버전</span><code id="version">—</code></div>
      <div class="row"><span class="label">환경</span><code id="environment">—</code></div>
      <div class="row"><span class="label">마지막 확인</span><code id="checkedAt">—</code></div>
    </section>
  </main>
  <script>
    const apiBase = ${JSON.stringify(process.env.API_BASE_URL ?? 'http://localhost:4000')};
    fetch(apiBase + '/api/v1/status')
      .then((response) => { if (!response.ok) throw new Error('API request failed'); return response.json(); })
      .then((status) => {
        document.querySelector('#state').textContent = '정상 운영 중';
        document.querySelector('#version').textContent = status.version;
        document.querySelector('#environment').textContent = status.environment;
        document.querySelector('#checkedAt').textContent = new Date(status.checkedAt).toLocaleString();
      })
      .catch(() => { document.querySelector('#state').textContent = 'API 연결 실패'; document.querySelector('#state').style.color = '#ff8b8b'; });
  </script>
</body>
</html>`;

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; connect-src 'self' http://localhost:4000 http://127.0.0.1:4000; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  });
  response.end(page);
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(`AstraBI web listening on http://localhost:${port}`));

function shutdown(): void {
  server.close((error) => {
    if (error) {
      console.error('Failed to close web server cleanly:', error);
      process.exitCode = 1;
    }
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
