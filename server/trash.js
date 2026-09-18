const crypto = require('crypto');
const { load, save, TRASH_RETENTION_MS, UNNAMED } = require('./store');
const { ApiError, pickText } = require('./errors');
const { validateModule, validateKey, validateOperator } = require('./entries');

// 回收站按删除时间倒序排列，最近删掉的排在最前面；同样支持按模块与关键词筛选
function listTrash(options) {
  const input = options && typeof options === 'object' ? options : {};
  const module = pickText(input.module);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.trash || [];
  if (module) list = list.filter((item) => item.module === module);
  if (keyword) {
    list = list.filter((item) => {
      if (item.key.toLowerCase().includes(keyword)) return true;
      return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(keyword));
    });
  }

  list = list.slice().sort((a, b) => {
    if (a.deletedAt !== b.deletedAt) return a.deletedAt < b.deletedAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  // 回收站各模块条数基于全部条目计算，筛选之后下拉里的选项也不会缺
  const counts = {};
  (data.trash || []).forEach((item) => {
    counts[item.module] = (counts[item.module] || 0) + 1;
  });
  const modules = Object.keys(counts).sort().map((name) => ({ module: name, count: counts[name] }));

  return {
    trash: list,
    modules,
    // 全部回收站条目条数，不受当前筛选影响，页面入口角标据此显示
    total: (data.trash || []).length,
    retentionMs: TRASH_RETENTION_MS,
    serverTime: new Date().toISOString(),
  };
}

// 同一个模块下键是否已经被正常列表里的文案占用，比较时忽略大小写
function findConflict(data, module, key) {
  return data.entries.find((item) => item.module === module
    && item.key.toLowerCase() === key.toLowerCase());
}

// 恢复回收站条目：
// 默认回到原来的模块与键；调用方也可以显式指定新模块/新键。
// 原位置已经被别的文案占住时当场拒绝，并把冲突双方一并返回，
// 由页面让操作者选择换一个键再恢复，或者放弃这次恢复。
function restoreTrashItem(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const trash = data.trash || [];
  const index = trash.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new ApiError(404, 'TRASH_ITEM_NOT_FOUND', '回收站里没有这条文案，可能已经被恢复或自动清除', '');
  }
  const item = trash[index];

  const targetModule = input.module === undefined ? item.module : validateModule(input.module);
  const targetKey = input.key === undefined ? item.key : validateKey(input.key);
  const operator = validateOperator(input.operator, UNNAMED);

  const conflict = findConflict(data, targetModule, targetKey);
  if (conflict) {
    throw new ApiError(409, 'RESTORE_KEY_CONFLICT',
      `模块 ${targetModule} 下的 ${targetKey} 已经被文案 ${conflict.key}（${conflict.id}）占用，换一个键再恢复，或者放弃这次恢复`,
      'key',
      {
        origin: { module: item.module, key: item.key },
        requested: { module: targetModule, key: targetKey },
        conflict: { id: conflict.id, module: conflict.module, key: conflict.key },
      });
  }

  const [removed] = trash.splice(index, 1);
  const now = new Date().toISOString();
  const known = new Set(data.languages.map((language) => language.code));
  const translations = {};
  Object.keys(removed.translations).forEach((code) => {
    // 恢复时只接回当前仍登记着的语言，已删除语言的译文留在回收站记录里随条目一起消失
    if (known.has(code)) translations[code] = removed.translations[code];
  });

  const record = {
    id: crypto.randomUUID(),
    originModule: removed.module,
    originKey: removed.key,
    restoredModule: targetModule,
    restoredKey: targetKey,
    restoredBy: operator,
    restoredAt: now,
  };
  const restored = {
    id: removed.id,
    module: targetModule,
    key: targetKey,
    translations,
    note: removed.note,
    updatedBy: operator,
    createdAt: removed.createdAt,
    updatedAt: now,
    restoreRecords: (removed.restoreRecords || []).concat(record),
  };

  data.entries.push(restored);
  save(data);
  return { entry: restored, record };
}

module.exports = {
  listTrash,
  restoreTrashItem,
};
