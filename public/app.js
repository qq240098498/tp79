// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  trash: [],
  trashModules: [],
  trashTotal: 0,
  // 服务端时间与本机时间的偏差，回收站倒计时按服务端时间计算，避免本机时钟不准
  trashClockOffset: 0,
  trashTimer: null,
  // 当前正在处理的恢复冲突：回收站条目 id 与冲突双方信息
  restoring: null,
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与附加详情一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.details = error.details || null;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区与文案区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 距离自动清除还剩多久：超过一天按天显示，不到一天按小时，不到一小时按分钟
function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '即将清除';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  if (days >= 1) {
    const hours = Math.round((minutes - days * 1440) / 60);
    return hours ? `约 ${days} 天 ${hours} 小时` : `约 ${days} 天`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `约 ${hours} 小时 ${minutes % 60} 分钟`;
  if (minutes >= 1) return `约 ${minutes} 分钟`;
  return '不到 1 分钟';
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const select = el('filter-module');
  const current = select.value;
  const rows = ['<option value="">全部模块</option>']
    .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  select.innerHTML = rows.join('');
  if (state.modules.some((item) => item.module === current)) select.value = current;
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '恢复记录', '操作'])
    .map((text) => `<th>${escapeHtml(text)}</th>`)
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    const records = Array.isArray(item.restoreRecords) ? item.restoreRecords : [];
    const restoreCell = records.length
      ? `<td class="restore-cell">${records.map((record) => {
        const moved = record.originKey !== record.restoredKey || record.originModule !== record.restoredModule;
        const origin = moved
          ? `（原 ${escapeHtml(record.originModule)} / ${escapeHtml(record.originKey)}）`
          : '';
        return `<div class="restore-line">${escapeHtml(formatTime(record.restoredAt))} 由 ${escapeHtml(record.restoredBy)} 恢复，键：<span class="mono">${escapeHtml(record.restoredKey)}</span>${origin}</div>`;
      }).join('')}</td>`
      : '<td class="missing">—</td>';
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      ${restoreCell}
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

function openEntryForm(entry) {
  state.editingId = entry ? entry.id : '';
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  el('entry-form').classList.remove('hidden');
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

// ---- 回收站 ----

function trashQuery() {
  const params = new URLSearchParams();
  const module = el('trash-filter-module').value;
  const keyword = el('trash-filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function loadTrash() {
  const payload = await request(`/api/trash${trashQuery()}`);
  state.trash = payload.trash || [];
  state.trashModules = payload.modules || [];
  state.trashTotal = payload.total || 0;
  // 记录服务端与本机的时间差，倒计时按服务端时钟走，本机时间不准也不会算错
  const serverTime = Date.parse(payload.serverTime);
  if (Number.isFinite(serverTime)) state.trashClockOffset = Date.now() - serverTime;
  renderTrashModules();
  renderTrash();
  renderTrashBadge();
}

function renderTrashBadge() {
  const badge = el('trash-count');
  badge.textContent = String(state.trashTotal);
  badge.classList.toggle('hidden', state.trashTotal <= 0);
}

function renderTrashModules() {
  const select = el('trash-filter-module');
  const current = select.value;
  const rows = ['<option value="">全部模块</option>']
    .concat(state.trashModules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  select.innerHTML = rows.join('');
  if (state.trashModules.some((item) => item.module === current)) select.value = current;
}

// 回收站只读：译文全部展开列出，连已经注销的语言也照实显示，并标注语言已删除
function renderTrash() {
  const body = el('trash-body');
  const knownCodes = new Set(state.languages.map((item) => item.code));
  body.innerHTML = state.trash.map((item) => {
    const codes = Object.keys(item.translations);
    const translations = codes.length
      ? codes.map((code) => {
        const value = item.translations[code];
        const stateTag = knownCodes.has(code) ? '' : '<span class="tag off">语言已删除</span>';
        const text = value.trim() ? escapeHtml(value) : '<span class="missing-inline">（这条语言下没有译文）</span>';
        return `<div class="trash-translation"><span class="mono">${escapeHtml(code)}</span> ${stateTag}<div>${text}</div></div>`;
      }).join('')
      : '<span class="missing-inline">（没有任何译文）</span>';
    const remainingMs = Date.parse(item.expiresAt) - (Date.now() - state.trashClockOffset);
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      <td><div class="trash-translations">${translations}</div></td>
      <td class="trash-meta">
        <div>由 <strong>${escapeHtml(item.deletedBy)}</strong> 删除</div>
        <div class="mono minor">${escapeHtml(formatTime(item.deletedAt))}</div>
      </td>
      <td class="trash-countdown${remainingMs < 24 * 3600 * 1000 ? ' urgent' : ''}" data-expires="${escapeHtml(item.expiresAt)}">${escapeHtml(formatRemaining(remainingMs))}</td>
      <td class="actions">
        <button type="button" class="link" data-trash-restore="${escapeHtml(item.id)}">恢复</button>
      </td>
    </tr>`;
  }).join('');
  el('trash-empty').classList.toggle('hidden', state.trash.length > 0);
}

// 倒计时不重新请求，按本地时钟每分钟刷新一次剩余时间
function refreshTrashCountdowns() {
  document.querySelectorAll('[data-expires]').forEach((node) => {
    const ms = Date.parse(node.dataset.expires) - (Date.now() - state.trashClockOffset);
    node.textContent = formatRemaining(ms);
    node.classList.toggle('urgent', ms < 24 * 3600 * 1000);
  });
}

function openTrash() {
  el('trash-overlay').classList.remove('hidden');
  clearTrashStatus();
  loadTrash()
    .then(() => {
      if (state.trashTimer) clearInterval(state.trashTimer);
      state.trashTimer = setInterval(refreshTrashCountdowns, 60 * 1000);
    })
    .catch((err) => setTrashStatus(err.message, true));
}

function closeTrash() {
  el('trash-overlay').classList.add('hidden');
  if (state.trashTimer) {
    clearInterval(state.trashTimer);
    state.trashTimer = null;
  }
}

function setTrashStatus(message, isError) {
  const box = el('trash-status');
  box.textContent = message || '';
  box.className = message ? (isError ? 'trash-status error' : 'trash-status ok') : 'trash-status';
}

function clearTrashStatus() {
  const box = el('trash-status');
  box.textContent = '';
  box.className = 'trash-status';
}

// ---- 恢复 ----

// 先尝试按原来的模块与键恢复；冲突时服务端返回双方信息，弹出换键对话框
async function startRestore(id) {
  clearTrashStatus();
  const item = state.trash.find((entry) => entry.id === id);
  try {
    const result = await request(`/api/trash/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ operator: currentOperator() }),
    });
    await afterRestored(result);
  } catch (err) {
    if (err.code === 'RESTORE_KEY_CONFLICT' && err.details) {
      openRestoreDialog(id, err.details, item);
    } else {
      setTrashStatus(err.message, true);
    }
  }
}

function openRestoreDialog(id, details, item) {
  state.restoring = { id, details };
  const origin = details.origin || { module: item ? item.module : '', key: item ? item.key : '' };
  const conflict = details.conflict || {};
  el('restore-conflict-info').innerHTML = `
    <p>这条文案原来在 <span class="mono">${escapeHtml(origin.module)} / ${escapeHtml(origin.key)}</span>，
    但这个键现在已经被别的文案占用了：</p>
    <p class="conflict-current">现有文案：<span class="mono">${escapeHtml(conflict.module || '')} / ${escapeHtml(conflict.key || '')}</span>
    （编号 <span class="mono">${escapeHtml(conflict.id || '')}</span>）</p>
    <p>请换一个模块或文案键再恢复，或者放弃这次恢复。</p>`;
  el('restore-module').value = origin.module || '';
  el('restore-key').value = origin.key || '';
  setRestoreStatus('', false);
  clearFieldMarks();
  el('restore-overlay').classList.remove('hidden');
  el('restore-key').focus();
}

function closeRestoreDialog() {
  state.restoring = null;
  el('restore-overlay').classList.add('hidden');
  const status = el('restore-status');
  status.textContent = '';
  status.className = 'trash-status';
  clearFieldMarks();
}

function setRestoreStatus(message, isError) {
  const box = el('restore-status');
  box.textContent = message || '';
  box.className = message ? (isError ? 'trash-status error' : 'trash-status ok') : 'trash-status';
}

async function submitRestore(event) {
  event.preventDefault();
  const restoring = state.restoring;
  if (!restoring) return;
  clearFieldMarks();
  const payload = {
    operator: currentOperator(),
    module: el('restore-module').value,
    key: el('restore-key').value,
  };
  try {
    const result = await request(`/api/trash/${encodeURIComponent(restoring.id)}/restore`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    closeRestoreDialog();
    await afterRestored(result);
  } catch (err) {
    // 换的键仍然冲突时，更新冲突说明，让操作者继续改或者放弃
    if (err.code === 'RESTORE_KEY_CONFLICT' && err.details) {
      state.restoring.details = err.details;
      const origin = err.details.origin || {};
      const conflict = err.details.conflict || {};
      el('restore-conflict-info').innerHTML = `
        <p>新填的 <span class="mono">${escapeHtml(payload.module)} / ${escapeHtml(payload.key)}</span> 仍然被占用：</p>
        <p class="conflict-current">现有文案：<span class="mono">${escapeHtml(conflict.module || '')} / ${escapeHtml(conflict.key || '')}</span>
        （编号 <span class="mono">${escapeHtml(conflict.id || '')}</span>）</p>
        <p>这条文案原来在 <span class="mono">${escapeHtml(origin.module || '')} / ${escapeHtml(origin.key || '')}</span>，再换一个键，或者放弃恢复。</p>`;
      markField(`restore.${err.field}`);
    } else {
      setRestoreStatus(err.message, true);
      markField(`restore.${err.field}`);
    }
  }
}

async function afterRestored(result) {
  const record = result.record || {};
  const usedKey = record.restoredKey || '';
  const who = record.restoredBy || '未署名';
  const when = formatTime(record.restoredAt);
  setTrashStatus(`已于 ${when} 由 ${who} 恢复，恢复后使用的键是 ${usedKey}`, false);
  await Promise.all([
    loadEntries(),
    loadLanguages(),
    loadTrash(),
  ]);
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 语言与文案列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryEdit);
    if (found) openEntryForm(found);
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定把文案 ${found ? found.key : ''} 移入回收站吗？30 天内可以从回收站恢复，到期后自动清除`)) return;
    try {
      const result = await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, {
        method: 'DELETE',
        body: JSON.stringify({ operator: currentOperator() }),
      });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify(`文案已移入回收站，将于 ${formatTime(result.expiresAt)} 自动清除`, 'ok');
      await loadEntries();
      await loadLanguages();
      await loadTrashSilently();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  if (node.dataset.trashRestore) {
    startRestore(node.dataset.trashRestore);
  }
});

// 后台刷新回收站角标：删除后不用打开回收站也能看到条数变化
async function loadTrashSilently() {
  try {
    const payload = await request('/api/trash');
    state.trashTotal = payload.total || 0;
    renderTrashBadge();
  } catch (err) {
    // 角标刷新失败不打断主流程
  }
}

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);
el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 回收站入口与弹层内操作
el('trash-open').addEventListener('click', () => {
  clearNotice();
  openTrash();
});
el('trash-close').addEventListener('click', closeTrash);
el('trash-refresh').addEventListener('click', () => {
  loadTrash().catch((err) => setTrashStatus(err.message, true));
});
el('trash-filter-apply').addEventListener('click', () => {
  loadTrash().catch((err) => setTrashStatus(err.message, true));
});
el('trash-filter-reset').addEventListener('click', () => {
  el('trash-filter-module').value = '';
  el('trash-filter-keyword').value = '';
  loadTrash().catch((err) => setTrashStatus(err.message, true));
});
el('trash-filter-module').addEventListener('change', () => {
  loadTrash().catch((err) => setTrashStatus(err.message, true));
});
el('trash-filter-keyword').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadTrash().catch((err) => setTrashStatus(err.message, true));
  }
});
el('restore-form').addEventListener('submit', submitRestore);
el('restore-cancel').addEventListener('click', closeRestoreDialog);

// 点遮罩空白处关闭弹层，按 Esc 也可以
[['trash-overlay', closeTrash], ['restore-overlay', closeRestoreDialog]].forEach(([id, onClose]) => {
  el(id).addEventListener('click', (event) => {
    if (event.target === event.currentTarget) onClose();
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el('restore-overlay').classList.contains('hidden')) closeRestoreDialog();
  else if (!el('trash-overlay').classList.contains('hidden')) closeTrash();
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列；顺带拉取回收站角标
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .then(loadTrashSilently)
  .catch((err) => notify(err.message, 'error'));
