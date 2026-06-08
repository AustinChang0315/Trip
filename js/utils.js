/* ─── utils.js ──────────────────────────────────────────────────────────────
   Pure / lightly-mockable functions shared between index.html and tests.
   Browser : loaded as a plain <script> → all functions become globals.
   Node.js : UMD-lite module.exports at bottom → require('../js/utils.js').
   ──────────────────────────────────────────────────────────────────────── */

/* ─── Cluster 1: Geo / Distance ──────────────────────────────────────────── */

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  var R   = 6371;
  var d2r = Math.PI / 180;
  var dLat = (lat2 - lat1) * d2r;
  var dLon = (lon2 - lon1) * d2r;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2)
        + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r)
        * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateMinsByDistance(meters) {
  if (meters < 800) {
    return Math.max(1, Math.ceil(meters / 80));     // 步行 ~4.8 km/h
  } else if (meters < 15000) {
    return Math.max(5, Math.ceil(meters / 350));    // 市區電車/地鐵 ~21 km/h（含候車）
  } else {
    return Math.max(20, Math.ceil(meters / 450));   // 特急/JR ~27 km/h（直線距離+候車換車補正）
  }
}

/* ─── Cluster 2: Route Optimization ──────────────────────────────────────── */

// 全排列產生器（N ≤ 8 時暴力搜最短）
function allPermutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var rest = arr.filter(function(_, j){ return j !== i; });
    allPermutations(rest).forEach(function(p){
      out.push([arr[i]].concat(p));
    });
  }
  return out;
}

// 計算一組景點順序的總移動距離
function routeTotalKm(arr) {
  var total = 0;
  for (var i = 0; i < arr.length - 1; i++) {
    total += haversineKm(
      arr[i].latitude, arr[i].longitude,
      arr[i+1].latitude, arr[i+1].longitude
    );
  }
  return total;
}

// 最近鄰貪婪法（N > 8 的 fallback）
function nearestNeighborSort(arr) {
  var rem    = arr.slice();
  var sorted = [rem.shift()];
  while (rem.length) {
    var last = sorted[sorted.length - 1];
    var bestIdx = 0, bestDist = Infinity;
    for (var i = 0; i < rem.length; i++) {
      var d = haversineKm(last.latitude, last.longitude, rem[i].latitude, rem[i].longitude);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    sorted.push(rem.splice(bestIdx, 1)[0]);
  }
  return sorted;
}

// 有起終點的貪婪最近鄰：從 startSpot 出發，依序選最近未訪的中間景點
function nearestNeighborSortBetween(arr, startSpot, endSpot) {
  var remaining = arr.slice();
  var sorted = [];
  var current = startSpot;
  while (remaining.length) {
    var minDist = Infinity, minIdx = 0;
    remaining.forEach(function(s, i) {
      var d = haversineKm(current.latitude, current.longitude, s.latitude, s.longitude);
      if (d < minDist) { minDist = d; minIdx = i; }
    });
    current = remaining[minIdx];
    sorted.push(current);
    remaining.splice(minIdx, 1);
  }
  return sorted;
}

// 核心排序：分離航班節點，只對有座標的正常景點排序
function sortSpotsOptimal(spots) {
  if (!spots || spots.length <= 2) return spots;

  var first  = spots[0];
  var last   = spots[spots.length - 1];
  var middle = spots.slice(1, spots.length - 1);

  var heads = [], tails = [], sortable = [];
  var mid = Math.floor(middle.length / 2);

  middle.forEach(function(s, i) {
    var canSort = s.latitude && s.longitude && s.duration > 0;
    if (!canSort) {
      if (i < mid) heads.push(s); else tails.push(s);
    } else {
      sortable.push(s);
    }
  });

  // 中間景點不足：回退完整排序（含首尾一起找最優）
  if (sortable.length <= 1) {
    var allSortable = spots.filter(function(s){ return s.latitude && s.longitude && s.duration > 0; });
    if (allSortable.length <= 1) return spots;
    var allMidLine = spots.length / 2;
    var aHeads = spots.filter(function(s,i){ return !(s.latitude && s.longitude && s.duration > 0) && i < allMidLine; });
    var aTails  = spots.filter(function(s,i){ return !(s.latitude && s.longitude && s.duration > 0) && i >= allMidLine; });
    var bFull; var bdFull = Infinity;
    allPermutations(allSortable).forEach(function(p){ var d=routeTotalKm(p); if(d<bdFull){bdFull=d;bFull=p;} });
    return aHeads.concat(bFull).concat(aTails);
  }

  var best;
  if (sortable.length <= 8) {
    // 計算時把首尾也納入，找真正連接端點成本最低的中間排列
    var bestDist = Infinity;
    allPermutations(sortable).forEach(function(perm) {
      var d = routeTotalKm([first].concat(perm).concat([last]));
      if (d < bestDist) { bestDist = d; best = perm; }
    });
  } else {
    // 從 first 出發的貪婪最近鄰
    best = nearestNeighborSortBetween(sortable, first, last);
  }

  return [first].concat(heads).concat(best).concat(tails).concat([last]);
}

/* ─── Cluster 3: Time / Date ──────────────────────────────────────────────── */

function minsToTime(m) {
  return String(Math.floor(m/60)%24).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}

// 任何日期值 → YYYY-MM-DD 字串
function dateToYMD(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.getFullYear() + '-'
    + String(d.getMonth()+1).padStart(2,'0') + '-'
    + String(d.getDate()).padStart(2,'0');
}

// 強健日期解析：YYYY-MM-DD → 本地時間（避免 UTC 偏移跨日）
function parseLocalDate(val) {
  if (!val) return new Date(NaN);
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
  return new Date(s);
}

// 正規化 GAS 回傳的時間值（HH:MM 字串、Sheets 時間小數、或 Date 字串）
function normalizeHHMM(val) {
  if (!val && val !== 0) return '';
  var s = String(val).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;                    // 已是 HH:MM
  var n = parseFloat(s);
  if (!isNaN(n) && n > 0 && n < 1) {                          // Sheets 時間小數（如 0.5625 = 13:30）
    var totalMins = Math.round(n * 24 * 60);
    var h = Math.floor(totalMins / 60);
    var m = totalMins % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  }
  var dm = s.match(/\b(\d{1,2}):(\d{2}):\d{2}\b/);            // Date 物件字串（如 "...13:30:00..."）
  if (dm) return String(parseInt(dm[1],10)).padStart(2,'0') + ':' + dm[2];
  return '';
}

function normalizeDate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var MON = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  var m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2})/);
  if (m && MON[m[1]]) {
    var yr = new Date().getFullYear();
    return yr + '-' + String(MON[m[1]]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0');
  }
  return s;
}

// 解析 "HH:MM" 字串為分鐘數，無法解析則回傳 540（09:00）
function parseTimeMins(t) {
  if (!t) return 540;
  var parts = String(t).split(':');
  if (parts.length < 2) return 540;
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  return (!isNaN(h) && !isNaN(m)) ? h * 60 + m : 540;
}

/* ─── Cluster 4: Order / State ───────────────────────────────────────────── */

function stableSpotKey(spot, dayNum) {
  var raw = String(dayNum) + '|' + String(spot.spot_name || '') + '|'
          + String(spot.latitude || '') + '|' + String(spot.longitude || '');
  var h = 5381;
  for (var i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
    h = h >>> 0;
  }
  return 'local_' + dayNum + '_' + h.toString(16).slice(-6);
}

// 儲存當天景點順序到 localStorage（同時存 id 與 name，防止 spot_id 格式切換時失效）
function saveDayOrder(dayNum, spots) {
  try {
    localStorage.setItem('day_order_' + dayNum, JSON.stringify(
      spots.map(function(s) { return { id: s.spot_id || '', name: s.spot_name || '' }; })
    ));
  } catch(e) {}
}

// 從 localStorage 讀回儲存的順序並套用
// 支援新格式 [{id, name}] 與舊格式 [string]，id 找不到時 fallback 用 name 匹配
function applyDayOrder(dayNum, spots) {
  var saved = localStorage.getItem('day_order_' + dayNum);
  if (!saved) return spots;
  try {
    var order = JSON.parse(saved);
    // byId: id → {spot, idx}；byName: name → [{spot, idx}, ...] 支援同名多個
    var byId = {}, byName = {};
    spots.forEach(function(s, idx) {
      if (s.spot_id) byId[s.spot_id] = { spot: s, idx: idx };
      var n = s.spot_name || '';
      if (!byName[n]) byName[n] = [];
      byName[n].push({ spot: s, idx: idx });
    });
    var usedIdx = {}, reordered = [];
    order.forEach(function(entry) {
      var id   = (typeof entry === 'object') ? entry.id   : entry;
      var name = (typeof entry === 'object') ? entry.name : entry;
      var found = null, foundIdx = -1;
      if (id && byId[id] && !usedIdx[byId[id].idx]) {
        found = byId[id].spot; foundIdx = byId[id].idx;
      }
      if (!found && name && byName[name]) {
        for (var ci = 0; ci < byName[name].length; ci++) {
          var cand = byName[name][ci];
          if (!usedIdx[cand.idx]) { found = cand.spot; foundIdx = cand.idx; break; }
        }
      }
      if (found && foundIdx >= 0) {
        reordered.push(found);
        usedIdx[foundIdx] = true;
      }
    });
    // 新增的景點（不在舊順序中）補到最後
    spots.forEach(function(s, idx) {
      if (!usedIdx[idx]) reordered.push(s);
    });
    return reordered.length ? reordered : spots;
  } catch(e) { return spots; }
}

// 時間重算：從 startMins（預設 09:00 = 540 分）往後累加 duration
function reindexTimes(spots, startMins) {
  var mins = (startMins !== undefined) ? startMins : 9 * 60;
  return spots.map(function(s) {
    var copy = Object.assign({}, s);
    delete copy.travel_mins;
    if (copy.duration > 0) {
      copy.time = minsToTime(mins);
      mins += copy.duration;
    }
    return copy;
  });
}

// 對外介面：排序 + 重算時間（startTime 為 "HH:MM" 字串，預設 "09:00"）
function optimizeDayRoute(spots, startTime) {
  if (!spots || spots.length <= 1) return spots;
  return reindexTimes(sortSpotsOptimal(spots), parseTimeMins(startTime));
}

/* ─── UMD-lite export (Node.js only) ────────────────────────────────────── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversineMeters, haversineKm, estimateMinsByDistance,
    allPermutations, routeTotalKm, nearestNeighborSort,
    nearestNeighborSortBetween, sortSpotsOptimal,
    minsToTime, parseTimeMins, normalizeHHMM,
    dateToYMD, parseLocalDate, normalizeDate,
    stableSpotKey, saveDayOrder, applyDayOrder,
    reindexTimes, optimizeDayRoute
  };
}
