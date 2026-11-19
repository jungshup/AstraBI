const apiUrl = window.ASTRABI_API_URL;
const loginView = document.querySelector('#login-view');
const usersView = document.querySelector('#users-view');
const analyticsView = document.querySelector('#analytics-view');
const workspaceNav = document.querySelector('#workspace-nav');
const navUsers = document.querySelector('#nav-users');
const message = document.querySelector('#message');
const signOutButton = document.querySelector('#sign-out');
const usersList = document.querySelector('#users-list');
const datasetsSelect = document.querySelector('#dataset-select');
const sqlDatasetsSelect = document.querySelector('#sql-datasets');
const queryResults = document.querySelector('#query-results');
let currentUser;
let datasets = [];
let lastQuery;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = !text;
}

function setAuthenticated(isAuthenticated) {
  const isAdmin = isAuthenticated && currentUser?.role === 'ADMIN';
  loginView.hidden = isAuthenticated;
  usersView.hidden = !isAdmin;
  analyticsView.hidden = !isAuthenticated;
  workspaceNav.hidden = !isAuthenticated;
  navUsers.hidden = !isAdmin;
  signOutButton.hidden = !isAuthenticated;
  document.querySelector('#source-admin-tools').hidden = !isAdmin;
  document.querySelector('#datasets-section').hidden = !isAdmin;
  document.querySelector('#query-section').hidden = !isAdmin;
  document.querySelector('#dashboard-form').hidden = !isAdmin;
  document.querySelector('#save-panel-form').hidden = !isAdmin;
}

async function request(path, options = {}) {
  const token = sessionStorage.getItem('astrabi-token');
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body && !isFormData ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

async function loadUsers() {
  const users = await request('/users');
  usersList.replaceChildren();

  for (const user of users) {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = user.displayName;
    const email = document.createElement('span');
    email.className = 'user-email';
    email.textContent = user.email;
    identity.append(name, email);

    const roleCell = document.createElement('td');
    const role = document.createElement('select');
    role.setAttribute('aria-label', `Role for ${user.email}`);
    for (const value of ['ADMIN', 'MEMBER']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'ADMIN' ? 'Administrator' : 'Member';
      option.selected = value === user.role;
      role.append(option);
    }
    role.disabled = !user.isActive || user.id === currentUser.id;
    role.addEventListener('change', async () => {
      try {
        await request(`/users/${encodeURIComponent(user.id)}/role`, {
          method: 'PATCH',
          body: JSON.stringify({ role: role.value }),
        });
        showMessage('User role updated.');
      } catch (error) {
        showMessage(error.message, true);
        await loadUsers();
      }
    });
    roleCell.append(role);

    const status = document.createElement('td');
    status.textContent = user.isActive ? 'Active' : 'Disabled';
    const actions = document.createElement('td');
    const actionGroup = document.createElement('div');
    actionGroup.className = 'row-actions';
    if (user.isActive && user.id !== currentUser.id) {
      const disable = document.createElement('button');
      disable.type = 'button';
      disable.className = 'button button-quiet';
      disable.textContent = 'Disable';
      disable.addEventListener('click', async () => {
        if (!window.confirm(`Disable ${user.email}? Existing sessions will be revoked.`)) return;
        try {
          await request(`/users/${encodeURIComponent(user.id)}/disable`, { method: 'PATCH' });
          showMessage('User disabled and active sessions revoked.');
          await loadUsers();
        } catch (error) {
          showMessage(error.message, true);
        }
      });
      actionGroup.append(disable);
    }
    actions.append(actionGroup);
    row.append(identity, roleCell, status, actions);
    usersList.append(row);
  }
}

async function loadSources() {
  if (currentUser.role !== 'ADMIN') return;
  const sources = await request('/data-sources');
  const tbody = document.querySelector('#sources-list');
  tbody.replaceChildren();
  for (const source of sources) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = source.name;
    const kind = document.createElement('td');
    kind.textContent = source.kind;
    const count = document.createElement('td');
    count.textContent = String(source._count.datasets);
    const actions = document.createElement('td');
    if (source.kind === 'POSTGRES') {
      const browse = document.createElement('button');
      browse.className = 'button button-quiet';
      browse.type = 'button';
      browse.textContent = 'Browse tables';
      browse.addEventListener('click', () => browseSourceTables(source));
      actions.append(browse);
    } else {
      actions.textContent = 'Imported';
    }
    row.append(name, kind, count, actions);
    tbody.append(row);
  }
}

async function browseSourceTables(source) {
  const browser = document.querySelector('#source-table-browser');
  browser.replaceChildren();
  browser.hidden = false;
  const heading = document.createElement('h3');
  heading.textContent = `Tables in ${source.name}`;
  browser.append(heading);
  try {
    const tables = await request(`/data-sources/${encodeURIComponent(source.id)}/tables`);
    if (tables.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No accessible base tables were found.';
      browser.append(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'source-table-list';
    for (const table of tables) {
      const item = document.createElement('div');
      item.className = 'source-table-item';
      const name = document.createElement('span');
      name.textContent = `${table.schema}.${table.name}`;
      const add = document.createElement('button');
      add.className = 'button button-quiet';
      add.type = 'button';
      add.textContent = 'Add dataset';
      add.addEventListener('click', async () => {
        try {
          await request(`/data-sources/${encodeURIComponent(source.id)}/datasets`, {
            method: 'POST',
            body: JSON.stringify({ schema: table.schema, table: table.name }),
          });
          showMessage(`Added ${table.schema}.${table.name}.`);
          await Promise.all([loadDatasets(), loadSources()]);
        } catch (error) {
          showMessage(error.message, true);
        }
      });
      item.append(name, add);
      list.append(item);
    }
    browser.append(list);
  } catch (error) {
    browser.hidden = true;
    showMessage(error.message, true);
  }
}

async function loadDatasets() {
  const selectedId = datasetsSelect.value;
  datasets = await request('/datasets');
  datasetsSelect.replaceChildren();
  sqlDatasetsSelect.replaceChildren();
  for (const dataset of datasets) {
    const label = `${dataset.name} · ${dataset.dataSource.name}`;
    const option = new Option(label, dataset.id);
    datasetsSelect.add(option);
    sqlDatasetsSelect.add(new Option(label, dataset.id));
  }
  if (datasets.some((dataset) => dataset.id === selectedId)) datasetsSelect.value = selectedId;
  if (!datasetsSelect.value && datasets.length > 0) datasetsSelect.value = datasets[0].id;
  if (datasetsSelect.value) {
    sqlDatasetsSelect.querySelector(`option[value="${CSS.escape(datasetsSelect.value)}"]`).selected = true;
  }
  renderSelectedDataset();
}

function selectedDataset() {
  return datasets.find((dataset) => dataset.id === datasetsSelect.value);
}

function datasetTableName(datasetId) {
  return `ds_${datasetId.replace(/-/g, '')}`;
}

function renderSelectedDataset() {
  const dataset = selectedDataset();
  const details = document.querySelector('#dataset-details');
  const dimensions = document.querySelector('#dimension-fields');
  const metricColumn = document.querySelector('#metric-column');
  dimensions.replaceChildren();
  metricColumn.replaceChildren(new Option('Count rows', ''));
  if (!dataset) {
    details.textContent = 'Import a CSV or add a PostgreSQL table to get started.';
    document.querySelector('#sql-editor').value = '';
    document.querySelector('#sql-dataset-help').textContent = '';
    return;
  }

  const columns = Array.isArray(dataset.columns) ? dataset.columns : [];
  details.textContent = `${dataset.rowCount ?? 'Live'} rows · ${columns
    .map((column) => `${column.name} (${column.type.toLowerCase()})`)
    .join(', ')}`;
  for (const column of columns) {
    const label = document.createElement('label');
    label.className = 'option-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = column.key;
    checkbox.addEventListener('change', updateVisualQueryExample);
    const text = document.createElement('span');
    text.textContent = `${column.name} (${column.type.toLowerCase()})`;
    label.append(checkbox, text);
    dimensions.append(label);
    metricColumn.add(new Option(`${column.name} (${column.type.toLowerCase()})`, column.key));
  }

  const sqlTable = datasetTableName(dataset.id);
  details.append(document.createElement('br'));
  details.append(document.createTextNode(`SQL table: ${sqlTable}`));
  document.querySelector('#sql-editor').value = `SELECT * FROM ${sqlTable} LIMIT 20;`;
  updateSqlDatasetHelp();
  updateVisualQueryExample();
}

function updateSqlDatasetHelp() {
  const selectedIds = new Set([...sqlDatasetsSelect.selectedOptions].map((option) => option.value));
  document.querySelector('#sql-dataset-help').textContent = datasets
    .filter((dataset) => selectedIds.has(dataset.id))
    .map((dataset) => {
      const columns = (Array.isArray(dataset.columns) ? dataset.columns : [])
        .map((column) => `${column.key}=${column.name}`)
        .join(', ');
      return `${datasetTableName(dataset.id)} (${dataset.name}): ${columns}`;
    })
    .join(' · ');
}

function updateVisualQueryExample() {
  const operation = document.querySelector('#metric-operation').value;
  const metricColumn = document.querySelector('#metric-column');
  metricColumn.disabled = operation === 'count';
}

function renderResultTable(container, result) {
  container.replaceChildren();
  if (!result.columns.length) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  for (const name of result.columns) {
    const cell = document.createElement('th');
    cell.textContent = name;
    header.append(cell);
  }
  thead.append(header);
  const tbody = document.createElement('tbody');
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const td = document.createElement('td');
      td.textContent = value === null || value === undefined
        ? ''
        : typeof value === 'object' ? JSON.stringify(value) : String(value);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrapper.append(table);
  container.append(wrapper);
  if (result.truncated) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Showing the first 1,000 rows.';
    container.append(note);
  }
}

function buildQuery() {
  if (document.querySelector('#query-mode').value === 'sql') {
    const datasetIds = [...sqlDatasetsSelect.selectedOptions].map((option) => option.value);
    return {
      mode: 'sql',
      datasetIds,
      sql: document.querySelector('#sql-editor').value,
    };
  }
  const dataset = selectedDataset();
  if (!dataset) throw new Error('Choose a dataset first.');
  const dimensions = [...document.querySelectorAll('#dimension-fields input:checked')]
    .map((input) => input.value);
  const operation = document.querySelector('#metric-operation').value;
  const column = document.querySelector('#metric-column').value;
  if (operation !== 'count' && !column) {
    throw new Error('Choose a column for the selected metric.');
  }
  return {
    mode: 'visual',
    datasetId: dataset.id,
    dimensions,
    metrics: operation === 'count' && !column
      ? [{ operation }]
      : [{ operation, column }],
    filters: [],
    limit: 1000,
  };
}

async function runQuery() {
  const status = document.querySelector('#query-status');
  status.textContent = 'Running…';
  queryResults.replaceChildren();
  try {
    lastQuery = buildQuery();
    const result = await request('/analytics/query', {
      method: 'POST',
      body: JSON.stringify(lastQuery),
    });
    renderResultTable(queryResults, result);
    status.textContent = result.truncated ? 'Result limited to 1,000 rows.' : `${result.rows.length} rows`;
  } catch (error) {
    status.textContent = '';
    showMessage(error.message, true);
  }
}

async function loadDashboards() {
  const dashboards = await request('/dashboards');
  const select = document.querySelector('#dashboard-select');
  const selectedId = select.value;
  select.replaceChildren();
  for (const dashboard of dashboards) {
    select.add(new Option(`${dashboard.name} (${dashboard._count.panels} panels)`, dashboard.id));
  }
  if (dashboards.some((dashboard) => dashboard.id === selectedId)) select.value = selectedId;

  const list = document.querySelector('#dashboards-list');
  list.replaceChildren();
  for (const dashboard of dashboards) {
    const button = document.createElement('button');
    button.className = 'dashboard-link';
    button.type = 'button';
    button.textContent = `${dashboard.name} · ${dashboard._count.panels} panels`;
    button.addEventListener('click', () => loadDashboardResults(dashboard.id));
    list.append(button);
  }
}

async function loadDashboardResults(dashboardId) {
  const results = document.querySelector('#dashboard-results');
  results.replaceChildren();
  try {
    const dashboard = await request(`/dashboards/${encodeURIComponent(dashboardId)}/results`);
    for (const panel of dashboard.panels) renderPanel(results, panel);
  } catch (error) {
    showMessage(error.message, true);
  }
}

function renderPanel(container, panel) {
  const card = document.createElement('article');
  card.className = 'panel dashboard-panel';
  const heading = document.createElement('h3');
  heading.textContent = panel.title;
  card.append(heading);
  const { columns, rows } = panel.result;
  if (panel.chartType === 'NUMBER') {
    const value = document.createElement('p');
    value.className = 'number-value';
    const lastColumn = rows[0]?.length - 1;
    value.textContent = lastColumn < 0 || rows[0]?.[lastColumn] === undefined
      ? '—'
      : String(rows[0][lastColumn]);
    card.append(value);
  } else if (panel.chartType === 'BAR' && columns.length >= 2) {
    const displayedRows = rows.slice(0, 20);
    const numericValues = displayedRows.map((row) => Number(row[1]));
    const finiteValues = numericValues.filter(Number.isFinite);
    const max = Math.max(1, ...finiteValues);
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const chartHeight = Math.max(100, displayedRows.length * 28);
    chart.setAttribute('viewBox', `0 0 640 ${chartHeight}`);
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', panel.title);
    displayedRows.forEach((row, index) => {
      const y = index * 28 + 18;
      const numericValue = Number.isFinite(numericValues[index]) ? numericValues[index] : 0;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', '0');
      label.setAttribute('y', String(y + 12));
      label.setAttribute('class', 'svg-chart-label');
      label.textContent = String(row[0] ?? '');
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', '180');
      bar.setAttribute('y', String(y));
      bar.setAttribute('width', String(Math.max(0, Math.min(400, (numericValue / max) * 400))));
      bar.setAttribute('height', '16');
      bar.setAttribute('rx', '6');
      bar.setAttribute('class', 'bar-shape');
      const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      value.setAttribute('x', '590');
      value.setAttribute('y', String(y + 12));
      value.setAttribute('text-anchor', 'end');
      value.setAttribute('class', 'svg-chart-value');
      value.textContent = String(row[1] ?? '');
      chart.append(label, bar, value);
    });
    card.append(chart);
    if (rows.length > displayedRows.length) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'Showing the first 20 chart rows.';
      card.append(note);
    }
  } else if (['LINE', 'AREA'].includes(panel.chartType) && columns.length >= 2 && rows.length > 0) {
    const numericValues = rows.map((row) => Number(row[1]));
    const max = Math.max(1, ...numericValues.filter(Number.isFinite));
    const min = Math.min(0, ...numericValues.filter(Number.isFinite));
    const width = 640;
    const height = 220;
    const padding = 24;
    const points = numericValues.map((value, index) => {
      const x = rows.length === 1
        ? width / 2
        : padding + (index / (rows.length - 1)) * (width - padding * 2);
      const safeValue = Number.isFinite(value) ? value : 0;
      const y = height - padding -
        ((safeValue - min) / Math.max(1, max - min)) * (height - padding * 2);
      return { x, y };
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', panel.title);
    if (panel.chartType === 'AREA') {
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const first = points[0];
      const last = points[points.length - 1];
      area.setAttribute(
        'd',
        `M ${first.x} ${height - padding} L ${points.map(({ x, y }) => `${x} ${y}`).join(' L ')} L ${last.x} ${height - padding} Z`,
      );
      area.setAttribute('class', 'area-shape');
      svg.append(area);
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points.map(({ x, y }) => `${x},${y}`).join(' '));
    line.setAttribute('class', 'line-shape');
    svg.append(line);
    const labels = document.createElement('div');
    labels.className = 'chart-labels';
    rows.forEach((row) => {
      const label = document.createElement('span');
      label.textContent = `${String(row[0] ?? '')}: ${String(row[1] ?? '')}`;
      labels.append(label);
    });
    card.append(svg, labels);
  } else {
    const table = document.createElement('div');
    renderResultTable(table, panel.result);
    card.append(table);
  }
  container.append(card);
}

async function openWorkspace() {
  currentUser = await request('/auth/me');
  document.querySelector('#account-summary').textContent =
    `${currentUser.displayName} · ${currentUser.email}`;
  document.querySelector('#analytics-account-summary').textContent =
    `${currentUser.displayName} · ${currentUser.email}`;
  setAuthenticated(true);
  await Promise.all([
    currentUser.role === 'ADMIN' ? loadUsers() : Promise.resolve(),
    currentUser.role === 'ADMIN' ? loadSources() : Promise.resolve(),
    currentUser.role === 'ADMIN' ? loadDatasets() : Promise.resolve(),
    loadDashboards(),
  ]);
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    sessionStorage.setItem('astrabi-token', result.token);
    await openWorkspace();
    showMessage('Signed in successfully.');
  } catch (error) {
    sessionStorage.removeItem('astrabi-token');
    currentUser = undefined;
    setAuthenticated(false);
    showMessage(error.message, true);
  }
});

document.querySelector('#create-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await request('/users', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    showMessage('User created with the Member role.');
    await loadUsers();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#refresh-users').addEventListener('click', async () => {
  try {
    await loadUsers();
    showMessage('User list refreshed.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#postgres-source-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.port = Number(payload.port);
  try {
    await request('/data-sources/postgres', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    form.reset();
    showMessage('PostgreSQL connection added.');
    await loadSources();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#csv-upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request('/data-sources/csv', {
      method: 'POST',
      body: new FormData(form),
    });
    form.reset();
    showMessage(`Imported ${result.dataset.name} (${result.dataset.rowCount} rows).`);
    await Promise.all([loadSources(), loadDatasets()]);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#refresh-sources').addEventListener('click', async () => {
  try {
    await loadSources();
    showMessage('Data sources refreshed.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#refresh-datasets').addEventListener('click', async () => {
  try {
    await loadDatasets();
    showMessage('Datasets refreshed.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

datasetsSelect.addEventListener('change', () => {
  renderSelectedDataset();
  const option = [...sqlDatasetsSelect.options].find((item) => item.value === datasetsSelect.value);
  if (option && ![...sqlDatasetsSelect.selectedOptions].some((item) => item.value === option.value)) {
    option.selected = true;
  }
  updateSqlDatasetHelp();
});
sqlDatasetsSelect.addEventListener('change', updateSqlDatasetHelp);

document.querySelector('#query-mode').addEventListener('change', (event) => {
  const isSql = event.currentTarget.value === 'sql';
  document.querySelector('#sql-builder').hidden = !isSql;
  document.querySelector('#visual-builder').hidden = isSql;
});
document.querySelector('#metric-operation').addEventListener('change', updateVisualQueryExample);
document.querySelector('#run-query').addEventListener('click', runQuery);

document.querySelector('#dashboard-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await request('/dashboards', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    await loadDashboards();
    showMessage('Dashboard created.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#save-panel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!lastQuery) {
    showMessage('Run a query before saving it to a dashboard.', true);
    return;
  }
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await request(`/dashboards/${encodeURIComponent(form.dashboardId)}/panels`, {
      method: 'POST',
      body: JSON.stringify({
        title: form.title,
        chartType: form.chartType,
        query: lastQuery,
      }),
    });
    showMessage('Dashboard panel saved.');
    await loadDashboards();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#refresh-dashboards').addEventListener('click', async () => {
  try {
    await loadDashboards();
    showMessage('Dashboards refreshed.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#nav-analytics').addEventListener('click', () => {
  analyticsView.hidden = false;
  usersView.hidden = true;
});
navUsers.addEventListener('click', () => {
  usersView.hidden = false;
  analyticsView.hidden = true;
});

signOutButton.addEventListener('click', async () => {
  let logoutError;
  try {
    await request('/auth/logout', { method: 'POST' });
  } catch (error) {
    logoutError = error;
  } finally {
    sessionStorage.removeItem('astrabi-token');
    currentUser = undefined;
    setAuthenticated(false);
    showMessage(
      logoutError
        ? 'Signed out locally, but the server could not confirm session revocation.'
        : 'Signed out.',
      Boolean(logoutError),
    );
  }
});

if (sessionStorage.getItem('astrabi-token')) {
  openWorkspace().catch((error) => {
    sessionStorage.removeItem('astrabi-token');
    currentUser = undefined;
    setAuthenticated(false);
    showMessage(error.message, true);
  });
}
