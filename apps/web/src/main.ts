import { createServer } from 'node:http';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';
const page = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#101827" /><title>AstraBI 관리자</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#101827;color:#e5edf8}*{box-sizing:border-box}body{margin:0;min-height:100vh}.wrap{width:min(1080px,100%);margin:auto;padding:36px 20px 72px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:clamp(2rem,5vw,3rem);letter-spacing:-.05em;margin:8px 0}.eyebrow{color:#63d6b3;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase}.card{margin-top:24px;border:1px solid #29364a;border-radius:16px;padding:24px;background:#172235}.muted{color:#9eacc1;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}.stat{background:#101827;border-radius:12px;padding:16px}.stat small{display:block;color:#9eacc1}.stat strong{display:block;margin-top:8px;font-size:1.3rem}.field{display:grid;gap:7px;margin:14px 0}.field label{color:#b9c9e0;font-size:.9rem}.field input,select{width:100%;border:1px solid #40516b;border-radius:9px;padding:11px 12px;color:#e5edf8;background:#101827}button{border:0;border-radius:9px;background:#63d6b3;color:#0c1a21;padding:11px 16px;font-weight:700;cursor:pointer}button.secondary{background:#29364a;color:#e5edf8}button:disabled{opacity:.55;cursor:wait}.toolbar{display:flex;gap:10px;align-items:center}.message{min-height:1.5em;color:#ff9999}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:650px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #29364a}th{color:#9eacc1;font-weight:600}.pill{border-radius:999px;background:#26344a;padding:4px 9px;font-size:.8rem}#login{max-width:440px;margin:60px auto}.hidden{display:none!important}.status{color:#63d6b3}
  </style>
</head>
<body><main class="wrap">
  <header><div><div class="eyebrow">AstraBI · Foundation v0.1</div><h1>관리자 콘솔</h1></div><div class="toolbar"><span id="identity" class="muted"></span><button id="logout" class="secondary hidden" type="button">로그아웃</button></div></header>
  <section id="login" class="card"><h2>로그인</h2><p class="muted">관리자 계정으로 로그인하세요.</p><form id="login-form"><div class="field"><label for="email">이메일</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254" /></div><div class="field"><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" /></div><button id="login-button" type="submit">로그인</button><p id="login-message" class="message" role="alert"></p></form></section>
  <section id="dashboard" class="hidden"><div class="grid"><div class="card stat"><small>플랫폼</small><strong>AstraBI</strong></div><div class="card stat"><small>서비스 상태</small><strong id="service-state">확인 중</strong></div><div class="card stat"><small>데이터베이스</small><strong id="db-state">확인 중</strong></div><div class="card stat"><small>등록 사용자</small><strong id="user-count">—</strong></div></div>
  <section class="card"><h2>사용자 및 권한</h2><p class="muted">역할과 계정 활성 상태를 관리합니다. 권한 변경은 감사 로그에 기록됩니다.</p><div class="table-wrap"><table><thead><tr><th>사용자</th><th>이름</th><th>역할</th><th>상태</th><th>생성일</th></tr></thead><tbody id="users"></tbody></table></div><p id="admin-message" class="message" role="alert"></p></section>
  <section class="card"><h2>최근 감사 로그</h2><div class="table-wrap"><table><thead><tr><th>시간</th><th>작업자</th><th>작업</th><th>세부 정보</th></tr></thead><tbody id="audit"></tbody></table></div></section></section>
  <p id="notice" class="muted" role="status"></p>
</main>
<script>
const apiBase = ${JSON.stringify(apiBaseUrl)};
const $ = (selector) => document.querySelector(selector);
async function api(path, options = {}) {
  const response = await fetch('/api/v1' + path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || '요청에 실패했습니다.');
  return data;
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); row.append(td); return td; }
async function loadAdmin() {
  const [status, users, audit] = await Promise.all([api('/status'), api('/admin/users'), api('/admin/audit')]);
  $('#service-state').textContent = status.status; $('#db-state').textContent = status.database; $('#user-count').textContent = String(users.total);
  const body = $('#users'); body.replaceChildren();
  for (const user of users.data) {
    const row = document.createElement('tr'); cell(row, user.email); cell(row, user.name);
    const roleCell = document.createElement('td'); const select = document.createElement('select');
    for (const role of ['ADMIN', 'ANALYST', 'VIEWER']) { const option = document.createElement('option'); option.value = role; option.textContent = role; option.selected = role === user.role; select.append(option); }
    select.addEventListener('change', async () => { try { await api('/admin/users/' + encodeURIComponent(user.id), { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); $('#admin-message').textContent = '역할이 업데이트되었습니다.'; } catch (error) { select.value = user.role; $('#admin-message').textContent = error.message; } });
    roleCell.append(select); row.append(roleCell);
    const activeCell = document.createElement('td'); const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'secondary'; toggle.textContent = user.isActive ? '활성' : '비활성'; toggle.setAttribute('aria-label', user.email + ' 계정 활성 상태 변경');
    toggle.addEventListener('click', async () => { try { const result = await api('/admin/users/' + encodeURIComponent(user.id), { method: 'PATCH', body: JSON.stringify({ isActive: !user.isActive }) }); user.isActive = result.user.isActive; toggle.textContent = user.isActive ? '활성' : '비활성'; } catch (error) { $('#admin-message').textContent = error.message; } });
    activeCell.append(toggle); row.append(activeCell); cell(row, new Date(user.createdAt).toLocaleString()); body.append(row);
  }
  const auditBody = $('#audit'); auditBody.replaceChildren();
  for (const item of audit.data) { const row = document.createElement('tr'); cell(row, new Date(item.createdAt).toLocaleString()); cell(row, item.actor); cell(row, item.action); cell(row, JSON.stringify(item.details)); auditBody.append(row); }
}
async function showSession() {
  try {
    const { user } = await api('/auth/session');
    $('#identity').textContent = user.email + ' · ' + user.role; $('#logout').classList.remove('hidden'); $('#login').classList.add('hidden');
    if (user.role !== 'ADMIN') { $('#notice').textContent = '로그인되었습니다. 관리자 권한이 없어 관리 콘솔은 볼 수 없습니다.'; return; }
    $('#dashboard').classList.remove('hidden'); await loadAdmin();
  } catch { $('#login').classList.remove('hidden'); }
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#login-button'); button.disabled = true; $('#login-message').textContent = '';
  try { const form = new FormData(event.currentTarget); const { user } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); $('#identity').textContent = user.email + ' · ' + user.role; await showSession(); }
  catch (error) { $('#login-message').textContent = error.message === 'invalid_credentials' ? '이메일 또는 비밀번호를 확인하세요.' : error.message; }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { location.reload(); } });
showSession().catch((error) => { $('#notice').textContent = error.message; });
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/v1/')) {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value && !['host', 'connection', 'content-length'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET');
      const upstream = await fetch(new URL(request.url ?? '/', apiBase), {
        method: request.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key)) response.setHeader(key, value);
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.error('API proxy failed:', error);
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: 'api_unavailable' }));
    }
    return;
  }
  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  });
  response.end(page);
});
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(`AstraBI web listening on http://localhost:${port}`));
function shutdown(): void { server.close((error) => { if (error) { console.error(error); process.exitCode = 1; } }); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
