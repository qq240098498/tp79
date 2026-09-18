const crypto = require('crypto');
const { load, save, UNNAMED } = require('./store');
const { ApiError, pickText } = require('./errors');
const { validateKey, validateOperator } = require('./entries');

// 回收站清单：按删除时间从新到旧排列，条目里带着到期时间，页面据此显示剩余多久
function listTrash() {
  const data = load();
  const trash = (data.trash || []).slice().sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return { trash };
}

function getTrashItem(data, id) {
  const found = (data.trash || []).find((item) => item.id === id);
  if (!found) {
    throw new ApiError(404, 'TRASH_NOT_FOUND', '回收站里没有这条文案，可能已经被恢复或自动清除', '');
  }
  return found;
}

// 恢复前先看原模块下这个键是不是已经被新文案占了：占了就把占位者一并指出来
function findOccupant(data, module, key) {
  return data.entries.find((item) => item.module === module
    && item.key.toLowerCase() === key.toLowerCase());
}

// 恢复回收站条目：默认用删除前的键；操作者也可以指定一个新键绕开冲突
function restoreTrashItem(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const item = getTrashItem(data, id);

  const originalKey = item.key;
  const targetKey = input.key === undefined ? originalKey : validateKey(input.key);
  const operator = validateOperator(input.operator, UNNAMED);

  const occupant = findOccupant(data, item.module, targetKey);
  if (occupant) {
    const err = new ApiError(
      409,
      'RESTORE_KEY_CONFLICT',
      `模块 ${item.module} 下的键 ${occupant.key} 已经被新文案占用（最近由 ${occupant.updatedBy} 更新），无法直接恢复。可以换一个键再恢复，或者放弃这次恢复`,
      'key',
    );
    err.conflict = {
      module: item.module,
      requestedKey: targetKey,
      occupiedBy: {
        id: occupant.id,
        key: occupant.key,
        updatedBy: occupant.updatedBy,
        updatedAt: occupant.updatedAt,
      },
    };
    throw err;
  }

  const trashIndex = data.trash.findIndex((entry) => entry.id === id);
  data.trash.splice(trashIndex, 1);

  const now = new Date().toISOString();
  const restored = {
    id: item.id,
    module: item.module,
    key: targetKey,
    translations: item.translations,
    note: item.note,
    updatedBy: operator,
    createdAt: item.createdAt,
    updatedAt: now,
  };
  data.entries.push(restored);

  // 页面上要留痕：什么时候、由谁恢复的，恢复后用的是哪个键（换过键时同时记下原来的键）
  const record = {
    id: crypto.randomUUID(),
    entryId: restored.id,
    module: restored.module,
    key: targetKey,
    restoredFromKey: originalKey,
    restoredBy: operator,
    restoredAt: now,
  };
  data.history = data.history || [];
  data.history.push(record);
  save(data);
  return { entry: restored, record };
}

module.exports = {
  listTrash,
  restoreTrashItem,
};
