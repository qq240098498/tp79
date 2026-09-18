// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  trash: [],
  history: [],
  editingId: '',
  restoreTarget: null,
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
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
    failure.conflict = error.conflict || null;
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

// 回收站条目距离自动清除还剩多久：大于一天按天，小于一天按时分
function formatCountdown(expireAt) {
  const target = new Date(expireAt).getTime();
  if (Number.isNaN(target)) return '剩余时间未知';
  const diff = target - Date.now();
  if (diff <= 0) return '即将清除';
  const minutes = Math.floor(diff / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `还剩 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `还剩 ${hours} 小时 ${mins} 分钟`;
  return `还剩 ${Math.max(mins, 1)} 分钟`;
}

// 倒计时的刷新定时器，切换数据时只保留一个
let countdownTimer = null;
function startCountdown() {
  if (countdownTimer) return;
  countdownTimer = window.setInterval(() => {
    document.querySelectorAll('[data-expire-at]').forEach((node) => {
      node.textContent = formatCountdown(node.dataset.expireAt);
    });
  }, 60 * 1000);
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
  state.history = payload.history || [];
  renderModules();
  renderEntries();
  renderHistory();
}

async function loadTrash() {
  const payload = await request('/api/trash');
  state.trash = payload.trash || [];
  renderTrash();
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
    .concat(['备注', '最近改动人', '更新时间', '操作'])
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
    let restoreTag = '';
    if (item.restored) {
      const record = item.restored;
      const renamed = record.restoredFromKey && record.restoredFromKey !== record.key
        ? `，恢复前的键为 ${record.restoredFromKey}`
        : '';
      const tip = `由 ${record.restoredBy} 于 ${formatTime(record.restoredAt)} 恢复，恢复后键为 ${record.key}${renamed}`;
      restoreTag = `<span class="restored-tag" title="${escapeHtml(tip)}">已恢复</span>`;
    }
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}${restoreTag}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

// 回收站内容只读：一张卡片里看清原模块与键、全部译文、删除人/时间与剩余保留时间
function renderTrash() {
  const box = el('trash-list');
  el('trash-count').textContent = state.trash.length ? `（${state.trash.length} 条）` : '';
  box.innerHTML = state.trash.map((item) => {
    // 全部译文：按当前登记的语言逐条列出，已删掉的语言槽位不会出现在数据里
    const extraCodes = Object.keys(item.translations)
      .filter((code) => !state.languages.some((language) => language.code === code));
    const rows = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) {
        return `<div class="trash-translation-row"><span class="lang-code">${escapeHtml(language.code)}</span><span class="lang-value lang-empty">未登记</span></div>`;
      }
      if (!value.trim()) {
        return `<div class="trash-translation-row"><span class="lang-code">${escapeHtml(language.code)}</span><span class="lang-value lang-empty">待翻译</span></div>`;
      }
      return `<div class="trash-translation-row"><span class="lang-code">${escapeHtml(language.code)}</span><span class="lang-value">${escapeHtml(value)}</span></div>`;
    }).concat(extraCodes.map((code) => {
      const value = item.translations[code];
      const text = value.trim() ? value : '待翻译';
      return `<div class="trash-translation-row"><span class="lang-code">${escapeHtml(code)}</span><span class="lang-value${value.trim() ? '' : ' lang-empty'}">${escapeHtml(text)}</span></div>`;
    }));

    const remaining = new Date(item.expireAt).getTime() - Date.now();
    const expiring = remaining >= 0 && remaining < 24 * 60 * 60 * 1000;
    return `<div class="trash-card${expiring ? ' is-expiring' : ''}">
      <div class="trash-card-head">
        <div class="trash-card-title">
          <span class="module-badge">${escapeHtml(item.module)}</span>
          <span class="mono">${escapeHtml(item.key)}</span>
        </div>
      </div>
      <div class="trash-meta">
        <span>由 <strong>${escapeHtml(item.deletedBy)}</strong> 于 ${escapeHtml(formatTime(item.deletedAt))} 删除</span>
        <span class="countdown" data-expire-at="${escapeHtml(item.expireAt)}">${escapeHtml(formatCountdown(item.expireAt))}</span>
      </div>
      <div class="trash-translations">${rows.join('')}</div>
      ${item.note ? `<div class="trash-meta"><span>备注：${escapeHtml(item.note)}</span></div>` : ''}
      <div class="trash-card-foot">
        <button type="button" data-trash-restore="${escapeHtml(item.id)}">恢复这条文案</button>
        <span class="readonly-tip">回收站内容只读，不能在这里编辑</span>
      </div>
    </div>`;
  }).join('');
  el('trash-empty').classList.toggle('hidden', state.trash.length > 0);
  startCountdown();
}

// 恢复记录：最近的在前，换过键的把原键与新键都标出来
function renderHistory() {
  const list = el('restore-history');
  const records = state.history.slice().reverse();
  list.innerHTML = records.map((record) => {
    const renamed = record.restoredFromKey && record.restoredFromKey !== record.key
      ? `<span class="renamed">原键 ${escapeHtml(record.restoredFromKey)} → </span>`
      : '';
    return `<li>${escapeHtml(formatTime(record.restoredAt))}，${escapeHtml(record.restoredBy)} 恢复了
      <span class="mono">${escapeHtml(record.module)}</span> 模块下的
      ${renamed}<span class="mono">${escapeHtml(record.key)}</span>
    </li>`;
  }).join('');
  el('history-empty').classList.toggle('hidden', records.length > 0);
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
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？删除后会先进回收站，7 天内还能恢复。`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, {
        method: 'DELETE',
        body: JSON.stringify({ operator: currentOperator() }),
      });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify('文案已移入回收站', 'ok');
      await loadEntries();
      await loadLanguages();
      await loadTrash();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.trashRestore) {
    clearNotice();
    await restoreFromTrash(node.dataset.trashRestore, '');
  }
});

// 发起恢复；newKey 为空表示用删除前的原键。冲突时服务端会把占位者带回来
async function restoreFromTrash(trashId, newKey) {
  const target = state.trash.find((item) => item.id === trashId);
  const payload = { operator: currentOperator() };
  if (newKey) payload.key = newKey;
  try {
    await request(`/api/trash/${encodeURIComponent(trashId)}/restore`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const keyText = newKey || (target ? target.key : '');
    notify(`文案已恢复：${keyText}`, 'ok');
    await loadEntries();
    await loadLanguages();
    await loadTrash();
  } catch (err) {
    if (err.code === 'RESTORE_KEY_CONFLICT' && err.conflict) {
      openRestoreModal(target, err.conflict, err.message);
    } else {
      notify(err.message, 'error');
    }
  }
}

// 冲突弹窗：当场指出被谁占了，操作者可以换键重试，也可以放弃
function openRestoreModal(target, conflict, message) {
  state.restoreTarget = target;
  el('restore-conflict-text').textContent = message;
  el('restore-new-key').value = '';
  el('restore-error').className = 'modal-error hidden';
  el('restore-error').textContent = '';
  el('restore-modal').classList.remove('hidden');
  el('restore-new-key').focus();
}

function closeRestoreModal() {
  state.restoreTarget = null;
  el('restore-modal').classList.add('hidden');
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
    .then(() => Promise.all([loadEntries(), loadTrash()]))
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

el('trash-refresh').addEventListener('click', () => {
  clearNotice();
  loadTrash().catch((err) => notify(err.message, 'error'));
});

el('restore-cancel').addEventListener('click', () => {
  closeRestoreModal();
  clearNotice();
});

el('restore-confirm').addEventListener('click', async () => {
  const target = state.restoreTarget;
  if (!target) return;
  const nextKey = el('restore-new-key').value.trim();
  if (!nextKey) {
    const box = el('restore-error');
    box.textContent = '请填写一个新的文案键，或者点“放弃恢复”';
    box.className = 'modal-error';
    return;
  }
  await submitRestore(target.id, nextKey);
});

// 在弹窗里回车等同确认
el('restore-new-key').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    el('restore-confirm').click();
  }
});

async function submitRestore(trashId, nextKey) {
  const errorBox = el('restore-error');
  try {
    await request(`/api/trash/${encodeURIComponent(trashId)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ operator: currentOperator(), key: nextKey }),
    });
    closeRestoreModal();
    notify(`文案已用新键 ${nextKey} 恢复`, 'ok');
    await loadEntries();
    await loadLanguages();
    await loadTrash();
  } catch (err) {
    if (err.code === 'RESTORE_KEY_CONFLICT' && err.conflict) {
      // 换的键也被占了：留在弹窗里，把新的冲突说明展示出来继续选
      errorBox.textContent = err.message;
      errorBox.className = 'modal-error';
      el('restore-new-key').value = '';
    } else {
      errorBox.textContent = err.message;
      errorBox.className = 'modal-error';
    }
    el('restore-new-key').focus();
  }
}

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(() => Promise.all([loadEntries(), loadTrash()]))
  .catch((err) => notify(err.message, 'error'));
