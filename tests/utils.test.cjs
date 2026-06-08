'use strict';
/* 執行方式：node --test tests/utils.test.cjs
   需要 Node.js 18+（內建 node:test，零 npm 依賴） */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

/* ── localStorage mock（applyDayOrder 需要）─────────────── */
global.localStorage = {
  _store: {},
  getItem(k)    { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
  clear()       { this._store = {}; }
};

const {
  haversineMeters, estimateMinsByDistance,
  haversineKm, routeTotalKm,
  sortSpotsOptimal, reindexTimes, optimizeDayRoute,
  minsToTime, parseTimeMins, normalizeHHMM,
  normalizeDate, dateToYMD, parseLocalDate,
  stableSpotKey, applyDayOrder
} = require('../js/utils.js');

/* ═══════════════════════════════════════════════════════════
   Cluster 1 — 地理 / 距離計算
   ═══════════════════════════════════════════════════════════ */
describe('haversineMeters', () => {
  it('同一點回傳 0', () => {
    assert.strictEqual(haversineMeters(35.6812, 139.7671, 35.6812, 139.7671), 0);
  });

  it('東京車站 → 澀谷站 ≈ 6400m（±300m）', () => {
    // 東京車站: 35.6812, 139.7671 / 澀谷: 35.6580, 139.7016
    const m = haversineMeters(35.6812, 139.7671, 35.6580, 139.7016);
    assert.ok(m > 6100 && m < 6700, `實際距離 ${Math.round(m)}m 不在預期範圍`);
  });

  it('回傳值為正數', () => {
    const m = haversineMeters(35.0, 139.0, 36.0, 140.0);
    assert.ok(m > 0);
  });
});

describe('estimateMinsByDistance', () => {
  it('300m → 步行 tier（≤ 10 分鐘）', () => {
    const mins = estimateMinsByDistance(300);
    assert.ok(mins >= 1 && mins <= 10, `得到 ${mins} 分鐘`);
  });

  it('500m 邊界 → 仍屬步行 tier', () => {
    const mins = estimateMinsByDistance(799);
    assert.ok(mins <= 10);
  });

  it('3000m → 地鐵 tier（使用 350m/min 公式）', () => {
    // 3000m 走地鐵：ceil(3000/350) = 9，步行公式是 ceil/80，確認落點在地鐵分支
    const mins = estimateMinsByDistance(3000);
    const expectedMetro = Math.max(5, Math.ceil(3000 / 350)); // = 9
    assert.strictEqual(mins, expectedMetro);
  });

  it('50000m → 快速鐵路 tier（最少 20 分鐘）', () => {
    assert.ok(estimateMinsByDistance(50000) >= 20);
  });

  it('距離增加，時間不減少', () => {
    assert.ok(estimateMinsByDistance(5000) <= estimateMinsByDistance(10000));
  });
});

/* ═══════════════════════════════════════════════════════════
   Cluster 2 — 路由最佳化
   ═══════════════════════════════════════════════════════════ */
const SPOTS_3 = [
  { spot_name: '澀谷', latitude: 35.6580, longitude: 139.7016, duration: 60 },
  { spot_name: '新宿', latitude: 35.6896, longitude: 139.6917, duration: 60 },
  { spot_name: '淺草', latitude: 35.7116, longitude: 139.7964, duration: 60 }
];

describe('sortSpotsOptimal', () => {
  it('不丟失景點（length 不變）', () => {
    const result = sortSpotsOptimal(SPOTS_3.slice());
    assert.strictEqual(result.length, SPOTS_3.length);
  });

  it('排序後總距離 ≤ 原始順序距離', () => {
    const original = routeTotalKm(SPOTS_3);
    const sorted   = sortSpotsOptimal(SPOTS_3.slice());
    assert.ok(routeTotalKm(sorted) <= original + 0.001,
      `sorted ${routeTotalKm(sorted).toFixed(2)} > original ${original.toFixed(2)}`);
  });

  it('單一景點原封不動回傳', () => {
    const single = [SPOTS_3[0]];
    assert.deepStrictEqual(sortSpotsOptimal(single), single);
  });

  it('空陣列回傳空陣列', () => {
    assert.deepStrictEqual(sortSpotsOptimal([]), []);
  });

  it('包含所有原始景點（set 內容一致）', () => {
    const result = sortSpotsOptimal(SPOTS_3.slice());
    const resultSet   = new Set(result.map(s => s.spot_name));
    const originalSet = new Set(SPOTS_3.map(s => s.spot_name));
    assert.deepStrictEqual(resultSet, originalSet);
  });
});

describe('reindexTimes', () => {
  it('第一個景點從 09:00 開始', () => {
    const result = reindexTimes([{ spot_name: 'A', duration: 60 }], 540);
    assert.strictEqual(result[0].time, '09:00');
  });

  it('第二個景點時間 = 第一個 + duration', () => {
    const spots = [
      { spot_name: 'A', duration: 90 },
      { spot_name: 'B', duration: 60 }
    ];
    const result = reindexTimes(spots, 540); // 09:00
    assert.strictEqual(result[0].time, '09:00');
    assert.strictEqual(result[1].time, '10:30'); // 540 + 90 = 630 = 10:30
  });

  it('duration = 0 的景點不覆寫 time', () => {
    const spots = [{ spot_name: 'Flight', duration: 0, time: '14:30' }];
    const result = reindexTimes(spots, 540);
    assert.strictEqual(result[0].time, '14:30');
  });

  it('清除 travel_mins 欄位', () => {
    const spots = [{ spot_name: 'A', duration: 60, travel_mins: 25 }];
    const result = reindexTimes(spots, 540);
    assert.strictEqual(result[0].travel_mins, undefined);
  });

  it('不修改原陣列', () => {
    const spots = [{ spot_name: 'A', duration: 60 }];
    reindexTimes(spots, 540);
    assert.strictEqual(spots[0].time, undefined);
  });
});

/* ═══════════════════════════════════════════════════════════
   Cluster 3 — 時間 / 日期
   ═══════════════════════════════════════════════════════════ */
describe('minsToTime', () => {
  it('0 → "00:00"',    () => assert.strictEqual(minsToTime(0),    '00:00'));
  it('540 → "09:00"',  () => assert.strictEqual(minsToTime(540),  '09:00'));
  it('570 → "09:30"',  () => assert.strictEqual(minsToTime(570),  '09:30'));
  it('1439 → "23:59"', () => assert.strictEqual(minsToTime(1439), '23:59'));
  it('630 → "10:30"',  () => assert.strictEqual(minsToTime(630),  '10:30'));
});

describe('parseTimeMins', () => {
  it('"09:30" → 570',     () => assert.strictEqual(parseTimeMins('09:30'),   570));
  it('"00:00" → 0',       () => assert.strictEqual(parseTimeMins('00:00'),   0));
  it('"23:59" → 1439',    () => assert.strictEqual(parseTimeMins('23:59'),   1439));
  it('無效字串 → 540',    () => assert.strictEqual(parseTimeMins('invalid'), 540));
  it('null → 540',        () => assert.strictEqual(parseTimeMins(null),      540));
  it('空字串 → 540',      () => assert.strictEqual(parseTimeMins(''),        540));
});

describe('normalizeHHMM', () => {
  it('已是 HH:MM 直接回傳', () => {
    assert.strictEqual(normalizeHHMM('09:30'), '09:30');
    assert.strictEqual(normalizeHHMM('13:00'), '13:00');
  });

  it('Sheets 時間小數 0.625 → "15:00"', () => {
    assert.strictEqual(normalizeHHMM(0.625), '15:00');
  });

  it('Sheets 時間小數 0.5 → "12:00"', () => {
    assert.strictEqual(normalizeHHMM(0.5), '12:00');
  });

  it('Date 字串含 HH:MM:SS → 萃取 HH:MM', () => {
    assert.strictEqual(normalizeHHMM('Mon Jan 01 2024 09:30:00 GMT+0900'), '09:30');
  });

  it('null → ""', () => {
    assert.strictEqual(normalizeHHMM(null), '');
  });
});

describe('normalizeDate', () => {
  it('已是 YYYY-MM-DD 直接回傳', () => {
    assert.strictEqual(normalizeDate('2026-06-24'), '2026-06-24');
  });

  it('YYYY-MM-DD 帶時間只取日期', () => {
    assert.strictEqual(normalizeDate('2026-06-24T09:00:00'), '2026-06-24');
  });

  it('"Jun 24" → 當年 YYYY-06-24', () => {
    const yr = new Date().getFullYear();
    assert.strictEqual(normalizeDate('Jun 24'), `${yr}-06-24`);
  });

  it('空字串 → 空字串', () => {
    assert.strictEqual(normalizeDate(''), '');
  });
});

/* ═══════════════════════════════════════════════════════════
   Cluster 4 — 排序 / 狀態
   ═══════════════════════════════════════════════════════════ */
describe('stableSpotKey', () => {
  it('相同輸入每次回傳相同 ID', () => {
    const spot = { spot_name: '代官山蔦屋書店', latitude: 35.6485, longitude: 139.7034 };
    assert.strictEqual(stableSpotKey(spot, 1), stableSpotKey(spot, 1));
  });

  it('格式為 local_N_xxxxxx', () => {
    const spot = { spot_name: '代官山蔦屋書店', latitude: 35.6485, longitude: 139.7034 };
    assert.match(stableSpotKey(spot, 2), /^local_2_[0-9a-f]{6}$/);
  });

  it('不同 spot 產生不同 ID', () => {
    const a = { spot_name: '代官山', latitude: 35.6485, longitude: 139.7034 };
    const b = { spot_name: '中目黑', latitude: 35.6441, longitude: 139.6979 };
    assert.notStrictEqual(stableSpotKey(a, 1), stableSpotKey(b, 1));
  });

  it('不同 day 產生不同 ID', () => {
    const spot = { spot_name: '飯店', latitude: 35.6, longitude: 139.7 };
    assert.notStrictEqual(stableSpotKey(spot, 1), stableSpotKey(spot, 2));
  });
});

describe('applyDayOrder', () => {
  before(() => { localStorage.clear(); });

  it('無 localStorage 記錄時原序回傳', () => {
    const spots = [
      { spot_id: 'sid_1', spot_name: 'A' },
      { spot_id: 'sid_2', spot_name: 'B' }
    ];
    assert.deepStrictEqual(applyDayOrder(99, spots), spots);
  });

  it('根據儲存的 id order 重排', () => {
    const spots = [
      { spot_id: 'sid_1', spot_name: 'A' },
      { spot_id: 'sid_2', spot_name: 'B' },
      { spot_id: 'sid_3', spot_name: 'C' }
    ];
    localStorage.setItem('day_order_1', JSON.stringify([
      { id: 'sid_3', name: 'C' },
      { id: 'sid_1', name: 'A' },
      { id: 'sid_2', name: 'B' }
    ]));
    const result = applyDayOrder(1, spots);
    assert.strictEqual(result[0].spot_id, 'sid_3');
    assert.strictEqual(result[1].spot_id, 'sid_1');
    assert.strictEqual(result[2].spot_id, 'sid_2');
    localStorage.removeItem('day_order_1');
  });

  it('同名景點用 index 去重（不重複使用同一個）', () => {
    const spots = [
      { spot_id: 'sid_a', spot_name: '三景花園五反田' },
      { spot_id: 'sid_b', spot_name: '三景花園五反田' }
    ];
    localStorage.setItem('day_order_4', JSON.stringify([
      { id: 'sid_b', name: '三景花園五反田' },
      { id: 'sid_a', name: '三景花園五反田' }
    ]));
    const result = applyDayOrder(4, spots);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].spot_id, 'sid_b');
    assert.strictEqual(result[1].spot_id, 'sid_a');
    localStorage.removeItem('day_order_4');
  });

  it('order 中有不存在的 id 時，不在結果中出現幽靈景點', () => {
    const spots = [{ spot_id: 'sid_1', spot_name: 'A' }];
    localStorage.setItem('day_order_2', JSON.stringify([
      { id: 'sid_ghost', name: 'GHOST' },
      { id: 'sid_1',    name: 'A' }
    ]));
    const result = applyDayOrder(2, spots);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].spot_id, 'sid_1');
    localStorage.removeItem('day_order_2');
  });
});
