const page = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AstraBI Analytics Console</title>
  <style>
    :root { --bg: #0b1220; --panel: #101827; --panel-2: #172235; --text: #e5edf8; --muted: #98a8c0; --accent: #63d6b3; --warn: #fbbf24; --danger: #f87171; --blue: #60a5fa; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 18px 80px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 2.8rem); letter-spacing: -0.05em; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .card { background: var(--panel); border: 1px solid #2b3c53; border-radius: 16px; padding: 20px; }
    .stat { font-size: 2rem; font-weight: 700; margin-top: 10px; }
    .section { margin-top: 28px; }
    .stack { display: grid; gap: 12px; }
    .flag-row, .widget-card { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 14px 16px; border-radius: 12px; background: var(--panel-2); border: 1px solid #2a3d59; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; font-size: 0.8rem; font-weight: 700; }
    .badge.on { background: rgba(99,214,179,0.12); color: var(--accent); }
    .badge.off { background: rgba(248,113,113,0.12); color: var(--danger); }
    button, input, textarea, select { font: inherit; }
    button { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: var(--blue); color: #031321; font-weight: 700; }
    input, textarea, select { width: 100%; padding: 11px 12px; background: #0b1220; color: var(--text); border: 1px solid #344d69; border-radius: 9px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid #2a3d59; }
    .pill { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #1d2a40; color: #cfe1ff; font-size: 0.8rem; }
    .hidden { display: none !important; }
    .message { min-height: 1.2rem; color: var(--danger); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <div class="muted">AstraBI · Foundation v0.1</div>
        <h1>Analytics Console</h1>
      </div>
      <div id="sessionState" class="muted">확인 중…</div>
    </div>

    <div class="grid">
      <div class="card"><div class="muted">총 사용자</div><div class="stat" id="totalUsers">0</div></div>
      <div class="card"><div class="muted">활성 기능</div><div class="stat" id="activeFlags">0</div></div>
      <div class="card"><div class="muted">리포트 수</div><div class="stat" id="reportCount">0</div></div>
    </div>

    <div class="section card">
      <h2>Feature Flag</h2>
      <div id="flagList" class="stack"></div>
    </div>

    <div class="section card">
      <h2>Dashboard</h2>
      <div id="dashboardPanel" class="stack"></div>
    </div>

    <div class="section card">
      <h2>Reports</h2>
      <form id="reportForm" class="stack">
        <input id="reportTitle" placeholder="Report title" required />
        <textarea id="reportDescription" rows="3" placeholder="Report description"></textarea>
        <select id="reportStatus">
          <option value="draft">draft</option>
          <option value="published">published</option>
        </select>
        <button type="submit">리포트 생성</button>
      </form>
      <table>
        <thead>
          <tr><th>Title</th><th>Status</th><th>Created</th></tr>
        </thead>
        <tbody id="reportTable"></tbody>
      </table>
    </div>
  </div>

  <script>
    const apiBase = ${JSON.stringify(process.env.API_BASE_URL ?? 'http://127.0.0.1:4000')};

    async function api(path, options = {}) {
      const response = await fetch(apiBase + path, {
        credentials: 'same-origin',
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || 'Request failed');
      return data;
    }

    async function loadSession() {
      try {
        const result = await api('/api/v1/auth/session');
        document.getElementById('sessionState').textContent = result.user.email + ' · ' + result.user.role;
      } catch {
        document.getElementById('sessionState').textContent = '로그인 필요';
      }
    }

    async function loadFeatureFlags() {
      try {
        const data = await api('/api/v1/admin/feature-flags');
        const list = document.getElementById('flagList');
        list.innerHTML = '';
        const enabledCount = data.data.filter(flag => flag.enabled).length;
        document.getElementById('activeFlags').textContent = String(enabledCount);

        for (const flag of data.data) {
          const row = document.createElement('div');
          row.className = 'flag-row';
          row.innerHTML = `
            <div>
              <strong>${flag.key}</strong>
              <div class="muted">${flag.description || 'No description'}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="badge ${flag.enabled ? 'on' : 'off'}">${flag.enabled ? 'ON' : 'OFF'}</span>
              <button type="button">${flag.enabled ? 'Disable' : 'Enable'}</button>
            </div>
          `;
          row.querySelector('button').addEventListener('click', async () => {
            await api('/api/v1/admin/feature-flags/' + encodeURIComponent(flag.key), {
              method: 'PATCH',
              body: JSON.stringify({ enabled: !flag.enabled })
            });
            await loadFeatureFlags();
          });
          list.appendChild(row);
        }
      } catch (error) {
        document.getElementById('flagList').innerHTML = '<div class="message">' + (error.message || '권한이 없습니다.') + '</div>';
      }
    }

    async function loadDashboard() {
      try {
        const data = await api('/api/v1/dashboard');
        const panel = document.getElementById('dashboardPanel');
        panel.innerHTML = '';
        for (const widget of data.widgets || []) {
          const card = document.createElement('div');
          card.className = 'widget-card';
          card.innerHTML = `
            <div>
              <strong>${widget.title}</strong>
              <div class="muted">${widget.type}</div>
            </div>
            <div class="stat" style="font-size:1.4rem; margin-top:0;">${widget.config?.value ?? '—'}</div>
          `;
          panel.appendChild(card);
        }
      } catch (error) {
        document.getElementById('dashboardPanel').innerHTML = '<div class="message">' + (error.message || '대시보드 접근이 제한됩니다.') + '</div>';
      }
    }

    async function loadReports() {
      try {
        const data = await api('/api/v1/reports');
        document.getElementById('reportCount').textContent = String(data.total || 0);
        const rows = document.getElementById('reportTable');
        rows.innerHTML = '';
        for (const report of data.data || []) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${report.title}</td>
            <td><span class="pill">${report.status}</span></td>
            <td>${new Date(report.createdAt).toLocaleString()}</td>
          `;
          rows.appendChild(tr);
        }
      } catch (error) {
        document.getElementById('reportTable').innerHTML = '<tr><td colspan="3">' + (error.message || '리포트를 불러오지 못했습니다.') + '</td></tr>';
      }
    }

    document.getElementById('reportForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        title: document.getElementById('reportTitle').value.trim(),
        description: document.getElementById('reportDescription').value.trim(),
        status: document.getElementById('reportStatus').value,
      };
      try {
        await api('/api/v1/reports', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        document.getElementById('reportForm').reset();
        await loadReports();
      } catch (error) {
        alert(error.message);
      }
    });

    async function init() {
      await loadSession();
      await loadFeatureFlags();
      await loadDashboard();
      await loadReports();
    }

    init();
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
    'content-security-policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:4000; style-src 'unsafe-inline'; script-src 'unsafe-inline';",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  response.end(page);
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(`AstraBI web listening on http://localhost:${port}`));
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
