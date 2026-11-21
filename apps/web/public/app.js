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
let chartTooltipSequence = 0;
let currentDashboardId;
let activeDashboardFilter;

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

  details.replaceChildren();
  const columns = Array.isArray(dataset.columns) ? dataset.columns : [];
  const summary = document.createElement('p');
  summary.textContent = `${dataset.rowCount ?? 0} rows · ${columns
    .map((column) => `${column.name} (${column.type.toLowerCase()})`)
    .join(', ')}`;
  details.append(summary);

  if (dataset.dataSource.kind === 'POSTGRES') {
    const refreshStatus = document.createElement('p');
    refreshStatus.className = 'dataset-refresh-status';
    if (dataset.lastRefreshError) {
      refreshStatus.textContent = `Last refresh failed (${dataset.lastRefreshError}); the previous snapshot is retained.`;
      refreshStatus.classList.add('refresh-error');
    } else if (dataset.lastRefreshedAt) {
      refreshStatus.textContent = `Snapshot updated ${new Date(dataset.lastRefreshedAt).toLocaleString()}.`;
    } else {
      refreshStatus.textContent = 'No snapshot yet. Refresh this dataset to load its rows.';
    }
    details.append(refreshStatus);

    const controls = document.createElement('div');
    controls.className = 'dataset-refresh-controls';
    const scheduleLabel = document.createElement('label');
    scheduleLabel.textContent = 'Automatic refresh';
    const schedule = document.createElement('select');
    schedule.add(new Option('Off', ''));
    schedule.add(new Option('Every 15 minutes', '15'));
    schedule.add(new Option('Every hour', '60'));
    schedule.add(new Option('Every 6 hours', '360'));
    schedule.add(new Option('Every 24 hours', '1440'));
    schedule.value = dataset.refreshIntervalMinutes === null
      ? ''
      : String(dataset.refreshIntervalMinutes);
    schedule.addEventListener('change', async () => {
      schedule.disabled = true;
      try {
        await request(`/datasets/${encodeURIComponent(dataset.id)}/refresh-schedule`, {
          method: 'PATCH',
          body: JSON.stringify({
            intervalMinutes: schedule.value === '' ? null : Number(schedule.value),
          }),
        });
        showMessage('Dataset refresh schedule updated.');
        await loadDatasets();
      } catch (error) {
        showMessage(error.message, true);
        schedule.disabled = false;
      }
    });
    scheduleLabel.append(schedule);
    const refreshButton = document.createElement('button');
    refreshButton.className = 'button button-quiet';
    refreshButton.type = 'button';
    refreshButton.textContent = 'Refresh now';
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing...';
      try {
        const result = await request(`/datasets/${encodeURIComponent(dataset.id)}/refresh`, {
          method: 'POST',
        });
        showMessage(`Dataset snapshot refreshed (${result.rowCount} rows).`);
        await loadDatasets();
      } catch (error) {
        showMessage(error.message, true);
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh now';
      }
    });
    controls.append(scheduleLabel, refreshButton);
    details.append(controls);
  }

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
  const sqlTableLabel = document.createElement('p');
  sqlTableLabel.className = 'dataset-sql-table';
  sqlTableLabel.textContent = `SQL table: ${sqlTable}`;
  details.append(sqlTableLabel);
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

async function loadDashboardResults(dashboardId, filterSelection = null) {
  const results = document.querySelector('#dashboard-results');
  const isClearingFilter = Boolean(activeDashboardFilter) && !filterSelection;
  results.replaceChildren();
  try {
    const params = new URLSearchParams();
    if (filterSelection) {
      params.set('sourcePanelId', filterSelection.sourcePanelId);
      params.set('value', filterSelection.value);
    }
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : '';
    const dashboard = await request(
      `/dashboards/${encodeURIComponent(dashboardId)}/results${query}`,
    );
    currentDashboardId = dashboardId;
    activeDashboardFilter = dashboard.activeFilter;
    for (const panel of dashboard.panels) renderPanel(results, panel);
    updateDashboardFilterStatus(dashboard);
    if (isClearingFilter) results.querySelector('.chart-mark[tabindex="0"]')?.focus();
  } catch (error) {
    showMessage(error.message, true);
  }
}

function updateDashboardFilterStatus(dashboard) {
  const clearButton = document.querySelector('#clear-dashboard-filter');
  const status = document.querySelector('#dashboard-filter-status');
  const activeFilter = dashboard.activeFilter;
  clearButton.hidden = !activeFilter;
  status.hidden = !activeFilter;
  if (!activeFilter) {
    status.textContent = '';
    return;
  }
  const sourcePanel = dashboard.panels.find((panel) => panel.id === activeFilter.sourcePanelId);
  status.textContent = `Filtering matching visual panels by ${sourcePanel?.title ?? 'selected chart'}: ${activeFilter.value}`;
  clearButton.focus();
}

function selectDashboardFilter(panel, value) {
  if (currentDashboardId && panel.crossFilter && value !== null && value !== undefined) {
    loadDashboardResults(currentDashboardId, {
      sourcePanelId: panel.id,
      value: String(value),
    });
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
    const chartContainer = document.createElement('div');
    chartContainer.className = 'chart-container';
    const tooltip = createChartTooltip(chartContainer);
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const chartHeight = Math.max(100, displayedRows.length * 28);
    chart.setAttribute('viewBox', `0 0 640 ${chartHeight}`);
    chart.setAttribute('role', 'group');
    chart.setAttribute('aria-label', `${panel.title} chart. Focus a data point and use arrow keys to navigate.`);
    const marks = [];
    displayedRows.forEach((row, index) => {
      const y = index * 28 + 18;
      const numericValue = Number.isFinite(numericValues[index]) ? numericValues[index] : 0;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', '0');
      label.setAttribute('y', String(y + 12));
      label.setAttribute('class', 'svg-chart-label');
      label.setAttribute('aria-hidden', 'true');
      label.textContent = String(row[0] ?? '');
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', '180');
      bar.setAttribute('y', String(y));
      bar.setAttribute('width', String(Math.max(0, Math.min(400, (numericValue / max) * 400))));
      bar.setAttribute('height', '16');
      bar.setAttribute('rx', '6');
      bar.setAttribute('class', 'bar-shape chart-mark');
      configureChartMark(
        bar,
        `${columns[0]}: ${String(row[0] ?? '—')}; ${columns[1]}: ${String(row[1] ?? '—')}`,
        tooltip,
        index,
        panel.crossFilter && row[0] !== null && row[0] !== undefined &&
          String(row[0]).length <= 500
          ? () => selectDashboardFilter(panel, row[0])
          : undefined,
      );
      marks.push(bar);
      const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      value.setAttribute('x', '590');
      value.setAttribute('y', String(y + 12));
      value.setAttribute('text-anchor', 'end');
      value.setAttribute('class', 'svg-chart-value');
      value.setAttribute('aria-hidden', 'true');
      value.textContent = String(row[1] ?? '');
      chart.append(label, bar, value);
    });
    enableChartPointNavigation(marks);
    chartContainer.append(chart, createChartHint());
    card.append(chartContainer);
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
    const chartContainer = document.createElement('div');
    chartContainer.className = 'chart-container';
    const tooltip = createChartTooltip(chartContainer);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `${panel.title} chart. Focus a data point and use arrow keys to navigate.`);
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
    const marks = points.map((point) => {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      marker.setAttribute('cx', String(point.x));
      marker.setAttribute('cy', String(point.y));
      marker.setAttribute('r', '5');
      marker.setAttribute('class', 'chart-mark chart-point');
      return marker;
    });
    marks.forEach((marker, index) => {
      configureChartMark(
        marker,
        `${columns[0]}: ${String(rows[index][0] ?? '—')}; ${columns[1]}: ${String(rows[index][1] ?? '—')}`,
        tooltip,
        index,
        panel.crossFilter && rows[index][0] !== null && rows[index][0] !== undefined &&
          String(rows[index][0]).length <= 500
          ? () => selectDashboardFilter(panel, rows[index][0])
          : undefined,
      );
    });
    enableChartPointNavigation(marks);
    svg.append(...marks);
    const labels = document.createElement('div');
    labels.className = 'chart-labels';
    rows.forEach((row) => {
      const label = document.createElement('span');
      label.textContent = `${String(row[0] ?? '')}: ${String(row[1] ?? '')}`;
      labels.append(label);
    });
    chartContainer.append(svg, labels, createChartHint());
    card.append(chartContainer);
  } else {
    const table = document.createElement('div');
    renderResultTable(table, panel.result);
    card.append(table);
  }
  container.append(card);
}

function createChartTooltip(container) {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.id = `chart-tooltip-${++chartTooltipSequence}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  container.append(tooltip);
  return tooltip;
}

function configureChartMark(mark, label, tooltip, index, onActivate) {
  const canFilter = Boolean(onActivate);
  mark.setAttribute('role', canFilter ? 'button' : 'img');
  mark.setAttribute('aria-label', canFilter ? `${label}. Activate to filter the dashboard.` : label);
  mark.setAttribute('aria-describedby', tooltip.id);
  mark.setAttribute('tabindex', index === 0 ? '0' : '-1');

  const showTooltip = () => {
    tooltip.textContent = label;
    tooltip.hidden = false;
  };
  const hideTooltip = () => {
    if (document.activeElement !== mark && !mark.matches(':hover')) tooltip.hidden = true;
  };
  mark.addEventListener('pointerenter', showTooltip);
  mark.addEventListener('pointerleave', hideTooltip);
  mark.addEventListener('focus', showTooltip);
  mark.addEventListener('blur', hideTooltip);
  if (canFilter) {
    mark.addEventListener('click', onActivate);
    mark.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    });
  }
}

function enableChartPointNavigation(marks) {
  marks.forEach((mark, index) => {
    mark.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = Math.min(index + 1, marks.length - 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = Math.max(index - 1, 0);
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = marks.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      mark.setAttribute('tabindex', '-1');
      marks[nextIndex].setAttribute('tabindex', '0');
      marks[nextIndex].focus();
    });
  });
}

function createChartHint() {
  const hint = document.createElement('p');
  hint.className = 'muted chart-hint';
  hint.textContent = 'Hover or focus a data point to see its values. Use arrow keys to navigate.';
  return hint;
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

document.querySelector('#clear-dashboard-filter').addEventListener('click', () => {
  if (currentDashboardId && activeDashboardFilter) {
    loadDashboardResults(currentDashboardId);
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
