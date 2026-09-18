// ============================================================
// 多行程自由行 — Google Apps Script 後端 API
// ============================================================
//
// 【部署步驟】
//   1. 開啟 Google 試算表 → 擴充功能 → Apps Script
//   2. 貼上此程式碼，儲存（Ctrl+S）
//   3. 執行一次 initSheet() 建立工作表結構
//   4. 執行一次 seedData()  匯入初始 6 天行程資料
//   5. 部署 → 管理部署項目 → 新增部署
//      - 類型：網路應用程式
//      - 執行身分：我（你的 Google 帳號）
//      - 誰可以存取：所有人
//   6. 複製產生的「網路應用程式 URL」
//      填入 index.html 的 const API_URL = '貼在這裡'
//
//   【改版為多行程時的升級步驟（既有專案）】
//   a. 貼上本次更新後的程式碼並儲存
//   b. 執行一次 backfillTripId()：把既有 itinerary / flights 資料列
//      補上 trip_id = 'tokyo-2026-06'
//   c. 執行一次 seedTripsTab()：建立 trips 頁籤並登記既有東京行程
//   d. 部署 → 管理部署項目 → 編輯（鉛筆圖示）→ 版本選「新版本」→ 部署
//      （URL 維持不變，index.html 的 API_URL 不需要修改）
//
// 【CORS 說明】
//   GAS 不支援 OPTIONS preflight，因此前端 POST 請求
//   必須使用 Content-Type: text/plain（簡單請求，不觸發預檢）
//   本腳本在 doPost 中以 e.postData.contents 讀取 JSON body
// ============================================================

const SHEET_NAME       = 'itinerary';
const FLIGHT_SHEET_NAME = 'flights';
const TRIPS_SHEET_NAME  = 'trips';

// 既有東京行程升級為多行程後使用的固定 ID（一次性遷移用）
const DEFAULT_TRIP_ID = 'tokyo-2026-06';

const TRIPS_HEADERS = [
  'trip_id',                 // 行程唯一識別碼（前端產生，例如 tokyo-2026-06）
  'title',                   // 行程標題
  'country_or_destination',  // 目的地／國家
  'start_date',               // 起始日期 YYYY-MM-DD
  'end_date',                 // 結束日期 YYYY-MM-DD
  'created_at'                 // 建立時間
];

const FLIGHT_HEADERS = [
  'trip_id',            // 所屬行程 ID
  'day',                // 行程第幾天
  'spot_name',          // 航班標題
  'description',        // 完整說明
  'transport_method',   // 入境/出境後的交通方式
  'transport_duration', // 預估交通時間
  'maps_url'            // Google Maps 導航連結
];
const HEADERS = [
  'trip_id',      // 所屬行程 ID
  'day',          // 行程第幾天（integer）
  'date',         // 日期 YYYY-MM-DD
  'day_title',    // 當日主題標題
  'spot_name',    // 景點名稱
  'duration',     // 停留分鐘數（integer，0 = 不計入排序演算法）
  'region_name',  // 地區名（用於天氣去重）
  'latitude',     // 緯度（float）
  'longitude',    // 經度（float）
  'description',  // 景點描述（editorial summary）
  'address',      // Google formatted_address（顯示用）
  'opening_hours',// JSON 字串，weekday_text 陣列（Mon-Sun）
  'sort_order',   // 景點在當天的顯示順序（integer，從 0 開始）
  'travel_mins',  // 到達此景點的交通時間（分鐘，integer）
  'day_start',    // 當天出發時間（HH:MM 字串）
  'spot_id'       // 景點唯一識別碼（用於同名景點的正確操作）
];

// ──────────────────────────────────────────
//  公開 API
// ──────────────────────────────────────────

function doGet(e) {
  try {
    var params   = (e && e.parameter) || {};
    var resource = params.resource;

    // 行程列表畫面只需要 trips 頁籤資料，不用拉整份行程景點
    if (resource === 'trips') {
      return jsonResponse({ trips: readTrips() });
    }

    var tripId = params.trip_id;
    if (!tripId) {
      // 沒帶 trip_id 一律回空結果，避免多行程資料混在一起回傳
      return jsonResponse({ itinerary: [], flights: [], error: 'trip_id is required' });
    }

    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return jsonResponse({ itinerary: [], flights: [] });
    }

    const headers = data[0];
    const tripCol = headers.indexOf('trip_id');

    // 取得各欄索引（相容舊版 sheet，欄位不存在時回傳 -1）
    const COL = {
      day:          headers.indexOf('day'),
      date:         headers.indexOf('date'),
      day_title:    headers.indexOf('day_title'),
      spot_name:    headers.indexOf('spot_name'),
      duration:     headers.indexOf('duration'),
      region_name:  headers.indexOf('region_name'),
      latitude:     headers.indexOf('latitude'),
      longitude:    headers.indexOf('longitude'),
      description:  headers.indexOf('description'),
      address:      headers.indexOf('address'),
      opening_hours:headers.indexOf('opening_hours'),
      sort_order:   headers.indexOf('sort_order'),
      travel_mins:  headers.indexOf('travel_mins'),
      day_start:    headers.indexOf('day_start'),
      spot_id:      headers.indexOf('spot_id')
    };

    // 只保留當前 trip_id 的資料列，避免不同行程的景點混在一起
    const rows = data.slice(1).filter(function(row) {
      return tripCol >= 0 && String(row[tripCol]) === String(tripId);
    });

    const dayMap = new Map(); // Map 保持天數插入順序

    rows.forEach(function(row) {
      const day       = Number(row[COL.day]);
      const date      = toYMD(row[COL.date]);
      const day_title = String(row[COL.day_title]);
      const spot_name = String(row[COL.spot_name]);
      const duration  = Number(row[COL.duration]);
      const region    = String(row[COL.region_name]);
      const lat       = Number(row[COL.latitude]);
      const lng       = Number(row[COL.longitude]);
      const desc      = String(row[COL.description]);
      const address   = String(row[COL.address] || '');
      const sort_order  = COL.sort_order  >= 0 && row[COL.sort_order]  !== '' ? Number(row[COL.sort_order])  : 9999;
      const travel_mins = COL.travel_mins >= 0 && row[COL.travel_mins] !== '' ? Number(row[COL.travel_mins]) : 0;
      const day_start   = COL.day_start   >= 0 ? formatTimeStr(row[COL.day_start])   : '';
      const spot_id     = COL.spot_id     >= 0 && row[COL.spot_id] ? String(row[COL.spot_id]) : '';

      var opening_hours = [];
      try { opening_hours = JSON.parse(String(row[COL.opening_hours] || '[]')); } catch(e) {}

      if (!dayMap.has(day)) {
        // day_start 取第一個 spot 的值（整天共用）
        dayMap.set(day, { day: day, date: date, day_title: day_title, day_start: day_start, spots: [] });
      }

      dayMap.get(day).spots.push({
        spot_name:     spot_name,
        duration:      duration,
        region_name:   region,
        latitude:      lat,
        longitude:     lng,
        description:   desc,
        address:       address,
        opening_hours: opening_hours,
        sort_order:    sort_order,
        travel_mins:   travel_mins,
        spot_id:       spot_id,
        transport: {
          google_maps_url: buildNavUrl(spot_name)
        }
      });
    });

    // 每天的景點依 sort_order 升冪排列
    dayMap.forEach(function(dayObj) {
      dayObj.spots.sort(function(a, b) { return a.sort_order - b.sort_order; });
    });

    const itinerary = Array.from(dayMap.values())
      .sort(function(a, b) { return a.day - b.day; });

    // 讀取班機資訊（flights 頁籤，同樣依 trip_id 過濾）
    var flights = [];
    try {
      var fSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIGHT_SHEET_NAME);
      if (fSheet && fSheet.getLastRow() > 1) {
        var fData    = fSheet.getDataRange().getValues();
        var fHeaders = fData[0];
        var fTripCol = fHeaders.indexOf('trip_id');
        var FC = {
          day:                fHeaders.indexOf('day'),
          spot_name:          fHeaders.indexOf('spot_name'),
          description:        fHeaders.indexOf('description'),
          transport_method:   fHeaders.indexOf('transport_method'),
          transport_duration: fHeaders.indexOf('transport_duration'),
          maps_url:           fHeaders.indexOf('maps_url')
        };
        fData.slice(1).forEach(function(row) {
          if (!row[FC.spot_name]) return;
          if (fTripCol >= 0 && String(row[fTripCol]) !== String(tripId)) return;
          flights.push({
            day:         Number(row[FC.day]),
            spot_name:   String(row[FC.spot_name]   || ''),
            description: String(row[FC.description] || ''),
            transport: {
              method:          String(row[FC.transport_method]   || ''),
              duration:        String(row[FC.transport_duration] || ''),
              google_maps_url: String(row[FC.maps_url]           || '')
            }
          });
        });
      }
    } catch(fe) {}

    return jsonResponse({ itinerary: itinerary, flights: flights });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  try {
    // 前端以 Content-Type: text/plain 傳送 JSON，避免 CORS preflight
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    if (action === 'add_trip')    return handleAddTrip(payload);
    if (action === 'update_trip') return handleUpdateTrip(payload);

    const sheet = getSheet();

    if (action === 'add')              return handleAdd(sheet, payload);
    if (action === 'delete')           return handleDelete(sheet, payload);
    if (action === 'update_order')     return handleUpdateOrder(sheet, payload);
    if (action === 'update_day_start') return handleUpdateDayStart(sheet, payload);

    return jsonResponse({ success: false, error: '不支援的 action: ' + action });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ──────────────────────────────────────────
//  私有處理函數
// ──────────────────────────────────────────

function handleAdd(sheet, payload) {
  const tripId    = String(payload.trip_id || '');
  const day_title = payload.day_title || getDayTitle(sheet, tripId, payload.day) || '';

  // 取得當天最大 sort_order，新景點排在最後
  const existingSortOrder = payload.sort_order !== undefined
    ? Number(payload.sort_order)
    : getMaxSortOrder(sheet, tripId, payload.day) + 1;

  sheet.appendRow([
    tripId,
    Number(payload.day),
    String(payload.date        || ''),
    String(day_title),
    String(payload.spot_name   || ''),
    Number(payload.duration    || 60),
    String(payload.region_name || ''),
    Number(payload.latitude    || 0),
    Number(payload.longitude   || 0),
    String(payload.description || ''),
    String(payload.address     || ''),
    String(payload.opening_hours || '[]'),
    existingSortOrder,
    0,                                               // travel_mins 預設 0，待 update_order 更新
    String(payload.day_start || getDayStart(sheet, tripId, payload.day) || '09:00'),
    'sid_' + Date.now() + '_' + Math.floor(Math.random() * 9999)
  ]);

  return jsonResponse({ success: true, message: '景點已新增：' + payload.spot_name });
}

function handleDelete(sheet, payload) {
  const tripId      = String(payload.trip_id || '');
  const targetName = String(payload.spot_name);
  const targetId   = String(payload.spot_id || '');
  const targetDay  = Number(payload.day);
  const data       = sheet.getDataRange().getValues();
  const headers    = data[0];
  const dayCol     = headers.indexOf('day');
  const nameCol    = headers.indexOf('spot_name');
  const idCol      = headers.indexOf('spot_id');
  const tripCol    = headers.indexOf('trip_id');

  // 從最後一列往前掃，避免刪除後索引位移
  // 有 spot_id 時優先用 id 比對（解決同名景點問題），否則 fallback 到 spot_name
  // trip_id 必須相符，避免刪到其他行程同天數/同名的景點
  for (var i = data.length - 1; i >= 1; i--) {
    var rowTrip = tripCol >= 0 ? String(data[i][tripCol]) : '';
    var rowDay  = Number(data[i][dayCol]);
    var rowName = String(data[i][nameCol]);
    var rowId   = idCol >= 0 ? String(data[i][idCol]) : '';
    var matched = rowTrip === tripId && rowDay === targetDay &&
      (targetId && rowId ? rowId === targetId : rowName === targetName);
    if (matched) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ success: true, message: '景點已刪除：' + targetName });
    }
  }

  return jsonResponse({ success: false, error: '找不到景點「' + targetName + '」（Day ' + targetDay + '）' });
}

function handleUpdateOrder(sheet, payload) {
  const tripId    = String(payload.trip_id || '');
  const targetDay = Number(payload.day);
  const spots     = payload.spots || []; // [{ spot_name, sort_order, travel_mins }, ...]

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  const nameCol    = headers.indexOf('spot_name');
  const dayCol     = headers.indexOf('day');
  const tripCol    = headers.indexOf('trip_id');
  var   sortCol    = headers.indexOf('sort_order');
  var   travelCol  = headers.indexOf('travel_mins');

  // 欄位不存在時自動新增（相容舊版 sheet）
  if (sortCol < 0) {
    sortCol = headers.length;
    sheet.getRange(1, sortCol + 1).setValue('sort_order');
    headers.push('sort_order');
  }
  if (travelCol < 0) {
    travelCol = headers.length;
    sheet.getRange(1, travelCol + 1).setValue('travel_mins');
    headers.push('travel_mins');
  }

  const idCol = headers.indexOf('spot_id');

  // 建立 spot_id（優先）或 spot_name → { sort_order, travel_mins } 的快查 map
  var orderMap = {};
  spots.forEach(function(s) {
    var key = s.spot_id ? String(s.spot_id) : String(s.spot_name);
    orderMap[key] = {
      sort_order:  Number(s.sort_order  || 0),
      travel_mins: Number(s.travel_mins || 0)
    };
  });

  // 批次更新符合條件的列（同時比對 trip_id，避免跨行程誤更新）
  for (var r = 1; r < data.length; r++) {
    var rowTrip = tripCol >= 0 ? String(data[r][tripCol]) : '';
    if (rowTrip !== tripId) continue;
    var rowDay  = Number(data[r][dayCol]);
    var rowId   = idCol >= 0 ? String(data[r][idCol]) : '';
    var rowName = String(data[r][nameCol]);
    var key     = (rowId && orderMap[rowId] !== undefined) ? rowId : rowName;
    if (rowDay === targetDay && orderMap[key] !== undefined) {
      sheet.getRange(r + 1, sortCol  + 1).setValue(orderMap[key].sort_order);
      sheet.getRange(r + 1, travelCol + 1).setValue(orderMap[key].travel_mins);
    }
  }

  return jsonResponse({ success: true, message: 'Day ' + targetDay + ' 順序已更新' });
}

function handleUpdateDayStart(sheet, payload) {
  const tripId    = String(payload.trip_id || '');
  const targetDay = Number(payload.day);
  const newStart  = String(payload.day_start || '09:00');

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  const dayCol   = headers.indexOf('day');
  const tripCol  = headers.indexOf('trip_id');
  var   startCol = headers.indexOf('day_start');

  if (startCol < 0) {
    startCol = headers.length;
    sheet.getRange(1, startCol + 1).setValue('day_start');
    headers.push('day_start');
  }

  for (var r = 1; r < data.length; r++) {
    var rowTrip = tripCol >= 0 ? String(data[r][tripCol]) : '';
    if (rowTrip !== tripId) continue;
    if (Number(data[r][dayCol]) === targetDay) {
      sheet.getRange(r + 1, startCol + 1).setNumberFormat('@').setValue(newStart);
    }
  }

  return jsonResponse({ success: true, message: 'Day ' + targetDay + ' 出發時間已更新為 ' + newStart });
}

// 新增行程：寫入 trips 頁籤一列，trip_id 由前端產生後傳入
function handleAddTrip(payload) {
  const tripId = String(payload.trip_id || '');
  if (!tripId) {
    return jsonResponse({ success: false, error: 'trip_id is required' });
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRIPS_SHEET_NAME);
  if (!sheet) sheet = createTripsSheet(ss);

  sheet.appendRow([
    tripId,
    String(payload.title || ''),
    String(payload.country_or_destination || ''),
    String(payload.start_date || ''),
    String(payload.end_date   || ''),
    new Date()
  ]);

  return jsonResponse({ success: true, trip_id: tripId, message: '行程已建立：' + (payload.title || tripId) });
}

// 編輯行程：更新 trips 頁籤的中繼資料，並依「舊/新日期範圍」的差集
// 自動刪除被移出範圍的日期（itinerary + flights），保留的日期重新編號 day
function handleUpdateTrip(payload) {
  const tripId = String(payload.trip_id || '');
  if (!tripId) return jsonResponse({ success: false, error: 'trip_id is required' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tripsSheet = ss.getSheetByName(TRIPS_SHEET_NAME);
  if (!tripsSheet) return jsonResponse({ success: false, error: '找不到 trips 頁籤，請先執行 seedTripsTab()' });

  var tData    = tripsSheet.getDataRange().getValues();
  var tHeaders = tData[0];
  var tIdCol      = tHeaders.indexOf('trip_id');
  var tTitleCol   = tHeaders.indexOf('title');
  var tCountryCol = tHeaders.indexOf('country_or_destination');
  var tStartCol   = tHeaders.indexOf('start_date');
  var tEndCol     = tHeaders.indexOf('end_date');

  var rowIdx = -1, oldStart = '', oldEnd = '';
  for (var i = 1; i < tData.length; i++) {
    if (String(tData[i][tIdCol]) === tripId) {
      rowIdx = i;
      oldStart = toYMD(tData[i][tStartCol]);
      oldEnd   = toYMD(tData[i][tEndCol]);
      break;
    }
  }
  if (rowIdx < 0) return jsonResponse({ success: false, error: '找不到行程：' + tripId });

  var newStart = String(payload.start_date || oldStart);
  var newEnd   = String(payload.end_date   || oldEnd);

  // 更新中繼資料（trip_id 不變）
  tripsSheet.getRange(rowIdx + 1, tTitleCol + 1).setValue(String(payload.title || ''));
  if (tCountryCol >= 0) tripsSheet.getRange(rowIdx + 1, tCountryCol + 1).setValue(String(payload.country_or_destination || ''));
  tripsSheet.getRange(rowIdx + 1, tStartCol + 1).setValue(newStart);
  tripsSheet.getRange(rowIdx + 1, tEndCol + 1).setValue(newEnd);

  var oldDates = dateRange(oldStart, oldEnd);
  var newDates = dateRange(newStart, newEnd);
  var newDateIndex = {}; // date → 新的 1-based day 編號
  newDates.forEach(function(d, idx) { newDateIndex[d] = idx + 1; });
  var removedSet = {};
  var removedDates = oldDates.filter(function(d) { return newDateIndex[d] === undefined; });
  removedDates.forEach(function(d) { removedSet[d] = true; });

  // ── itinerary 分頁：刪除被移除日期的列；保留的列重編號 day ──
  var iSheet   = getSheet();
  var iData    = iSheet.getDataRange().getValues();
  var iHeaders = iData[0];
  var iTripCol = iHeaders.indexOf('trip_id');
  var iDayCol  = iHeaders.indexOf('day');
  var iDateCol = iHeaders.indexOf('date');

  for (var r = iData.length - 1; r >= 1; r--) {
    if (String(iData[r][iTripCol]) !== tripId) continue;
    var rowDate = toYMD(iData[r][iDateCol]);
    if (removedSet[rowDate]) {
      iSheet.deleteRow(r + 1);
    } else if (newDateIndex[rowDate] !== undefined) {
      iSheet.getRange(r + 1, iDayCol + 1).setValue(newDateIndex[rowDate]);
    }
  }

  // ── flights 分頁：沒有 date 欄位，用「舊日期陣列 + 舊 day 數字」換算出每列對應的日期 ──
  var fSheet = ss.getSheetByName(FLIGHT_SHEET_NAME);
  if (fSheet && fSheet.getLastRow() > 1) {
    var fData    = fSheet.getDataRange().getValues();
    var fHeaders = fData[0];
    var fTripCol = fHeaders.indexOf('trip_id');
    var fDayCol  = fHeaders.indexOf('day');
    for (var fr = fData.length - 1; fr >= 1; fr--) {
      if (String(fData[fr][fTripCol]) !== tripId) continue;
      var oldDayNum   = Number(fData[fr][fDayCol]);
      var flightDate  = oldDates[oldDayNum - 1];
      if (!flightDate || removedSet[flightDate]) {
        fSheet.deleteRow(fr + 1);
      } else if (newDateIndex[flightDate] !== undefined) {
        fSheet.getRange(fr + 1, fDayCol + 1).setValue(newDateIndex[flightDate]);
      }
    }
  }

  return jsonResponse({ success: true, removed_dates: removedDates, message: '行程已更新' });
}

// 讀取 trips 頁籤所有行程（供行程列表畫面使用）
function readTrips() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRIPS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var C = {
    trip_id:    headers.indexOf('trip_id'),
    title:      headers.indexOf('title'),
    country:    headers.indexOf('country_or_destination'),
    start_date: headers.indexOf('start_date'),
    end_date:   headers.indexOf('end_date'),
    created_at: headers.indexOf('created_at')
  };

  return data.slice(1)
    .filter(function(row) { return C.trip_id >= 0 && row[C.trip_id]; })
    .map(function(row) {
      return {
        trip_id:                 String(row[C.trip_id]),
        title:                   String(row[C.title] || ''),
        country_or_destination:  C.country >= 0 ? String(row[C.country] || '') : '',
        start_date:              toYMD(row[C.start_date]),
        end_date:                toYMD(row[C.end_date]),
        created_at:              C.created_at >= 0 && row[C.created_at] ? String(row[C.created_at]) : ''
      };
    });
}

// ──────────────────────────────────────────
//  工具函數
// ──────────────────────────────────────────

// Sheets 時間欄位可能是數字小數（0.5625 = 13:30）或 Date 物件，強制轉成 HH:MM 字串
function formatTimeStr(val) {
  if (!val && val !== 0) return '';
  if (typeof val === 'number') {
    var totalMins = Math.round(val * 24 * 60);
    var h = Math.floor(totalMins / 60) % 24;
    var m = totalMins % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  }
  if (val instanceof Date) {
    return String(val.getHours()).padStart(2,'0') + ':' + String(val.getMinutes()).padStart(2,'0');
  }
  var s = String(val).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  return '';
}

// 展開連續日期區間為 YYYY-MM-DD 字串陣列（含頭尾），用於編輯行程時的日期差集運算
function dateRange(startStr, endStr) {
  var start = new Date(String(startStr) + 'T00:00:00');
  var end   = new Date(String(endStr)   + 'T00:00:00');
  var out = [];
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  var cursor = new Date(start.getTime());
  while (cursor <= end) {
    out.push(toYMD(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// Google Sheets 的日期欄位可能是 Date 物件，強制轉成 YYYY-MM-DD 字串
function toYMD(val) {
  if (!val) return '';
  var d = (val instanceof Date) ? val : new Date(String(val));
  if (isNaN(d.getTime())) return String(val);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function getSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('找不到工作表「' + SHEET_NAME + '」，請先執行 initSheet()');
  }
  return sheet;
}

// 建立 trips 頁籤（表頭樣式與 initSheet/initFlightSheet 一致）
function createTripsSheet(ss) {
  var sheet = ss.insertSheet(TRIPS_SHEET_NAME);
  sheet.appendRow(TRIPS_HEADERS);
  var hr = sheet.getRange(1, 1, 1, TRIPS_HEADERS.length);
  hr.setFontWeight('bold');
  hr.setBackground('#e6f4ea');
  sheet.setFrozenRows(1);
  return sheet;
}

// 新增景點時若未傳 day_title，從既有資料補回同天的 day_title
function getDayTitle(sheet, tripId, targetDay) {
  var data     = sheet.getDataRange().getValues();
  var headers  = data[0];
  var dayCol   = headers.indexOf('day');
  var titleCol = headers.indexOf('day_title');
  var tripCol  = headers.indexOf('trip_id');
  for (var i = 1; i < data.length; i++) {
    var rowTrip = tripCol >= 0 ? String(data[i][tripCol]) : '';
    if (rowTrip === String(tripId) && Number(data[i][dayCol]) === Number(targetDay)) {
      return String(data[i][titleCol]);
    }
  }
  return '';
}

// 取得當天的出發時間（新增景點時繼承同天已有的設定）
function getDayStart(sheet, tripId, targetDay) {
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var dayCol   = headers.indexOf('day');
  var startCol = headers.indexOf('day_start');
  var tripCol  = headers.indexOf('trip_id');
  if (startCol < 0) return '09:00';
  for (var i = 1; i < data.length; i++) {
    var rowTrip = tripCol >= 0 ? String(data[i][tripCol]) : '';
    if (rowTrip === String(tripId) && Number(data[i][dayCol]) === Number(targetDay) && data[i][startCol]) {
      return String(data[i][startCol]);
    }
  }
  return '09:00';
}

// 取得當天景點最大的 sort_order（新景點排在最後用）
function getMaxSortOrder(sheet, tripId, targetDay) {
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var dayCol  = headers.indexOf('day');
  var sortCol = headers.indexOf('sort_order');
  var tripCol = headers.indexOf('trip_id');
  if (sortCol < 0) return -1;
  var max = -1;
  for (var i = 1; i < data.length; i++) {
    var rowTrip = tripCol >= 0 ? String(data[i][tripCol]) : '';
    if (rowTrip !== String(tripId)) continue;
    if (Number(data[i][dayCol]) === Number(targetDay)) {
      var v = Number(data[i][sortCol]);
      if (!isNaN(v) && v > max) max = v;
    }
  }
  return max;
}

// 景點名稱版導航 URL（不用座標，避免 Google Maps 顯示「已放置圖釘」）
function buildNavUrl(spotName) {
  return 'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination='
    + encodeURIComponent(String(spotName))
    + '&travelmode=transit';
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────
//  欄位遷移（新增欄位時執行一次）
// ──────────────────────────────────────────

// 執行方式：Apps Script 編輯器 → 選擇 addMissingColumns → 點執行
function addMissingColumns() {
  var sheet   = getSheet();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  var toAdd = ['address', 'opening_hours', 'sort_order', 'travel_mins', 'day_start', 'spot_id'].filter(function(h) {
    return headers.indexOf(h) === -1;
  });

  if (toAdd.length === 0) {
    Logger.log('欄位已是最新，無需新增');
    return;
  }

  toAdd.forEach(function(col) {
    var nextCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextCol).setValue(col);
    Logger.log('已新增欄位：' + col + '（第 ' + nextCol + ' 欄）');
  });

  Logger.log('遷移完成！新增了：' + toAdd.join(', '));
}

// ──────────────────────────────────────────
//  sort_order 重新編號（刪除景點後修復缺口）
// ──────────────────────────────────────────

// 執行方式：Apps Script 編輯器 → 選擇 renumberSortOrders → 點執行
// 為既有景點補填 spot_id（執行一次即可）
function generateSpotIds() {
  var sheet   = getSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol   = headers.indexOf('spot_id');
  if (idCol < 0) { Logger.log('請先執行 addMissingColumns() 新增 spot_id 欄位'); return; }
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (!data[r][idCol]) {
      sheet.getRange(r + 1, idCol + 1).setValue('sid_' + Date.now() + '_' + r);
      Utilities.sleep(2);
      count++;
    }
  }
  Logger.log('generateSpotIds() 完成，補填了 ' + count + ' 筆 ID。');
}

function renumberSortOrders() {
  var sheet   = getSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var dayCol  = headers.indexOf('day');
  var sortCol = headers.indexOf('sort_order');

  if (sortCol < 0) { Logger.log('找不到 sort_order 欄位'); return; }

  // 依天分組，記錄 { row(1-based), sortOrder }
  var groups = {};
  for (var r = 1; r < data.length; r++) {
    var d = Number(data[r][dayCol]);
    if (!groups[d]) groups[d] = [];
    groups[d].push({ row: r + 1, sortOrder: Number(data[r][sortCol]) });
  }

  // 每天依現有 sort_order 升冪排列，再從 0 重新連續編號
  Object.keys(groups).forEach(function(day) {
    groups[day].sort(function(a, b) { return a.sortOrder - b.sortOrder; });
    groups[day].forEach(function(item, idx) {
      sheet.getRange(item.row, sortCol + 1).setValue(idx);
    });
  });

  Logger.log('renumberSortOrders() 完成。');
}

// ──────────────────────────────────────────
//  多行程升級遷移（既有專案改版時，各執行一次）
// ──────────────────────────────────────────

// 執行方式：Apps Script 編輯器 → 選擇 backfillTripId → 點執行
// 將 itinerary / flights 既有（改版前）資料列的 trip_id 補填為 DEFAULT_TRIP_ID
function backfillTripId() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  [SHEET_NAME, FLIGHT_SHEET_NAME].forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 1) return;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var tripCol = headers.indexOf('trip_id');

    if (tripCol < 0) {
      // 舊版 sheet 沒有 trip_id 欄位，插入在最前面，跟新版 HEADERS 順序一致
      sheet.insertColumnBefore(1);
      sheet.getRange(1, 1).setValue('trip_id');
      tripCol = 0;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var count = 0;
    for (var r = 2; r <= lastRow; r++) {
      var cell = sheet.getRange(r, tripCol + 1);
      if (!cell.getValue()) {
        cell.setValue(DEFAULT_TRIP_ID);
        count++;
      }
    }
    Logger.log(name + '：補填 trip_id 完成，共 ' + count + ' 筆。');
  });
}

// 執行方式：Apps Script 編輯器 → 選擇 seedTripsTab → 點執行
// 建立 trips 頁籤（若不存在）並登記既有東京行程
function seedTripsTab() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRIPS_SHEET_NAME);
  if (!sheet) sheet = createTripsSheet(ss);

  var data   = sheet.getDataRange().getValues();
  var exists = data.slice(1).some(function(row) { return String(row[0]) === DEFAULT_TRIP_ID; });
  if (exists) {
    Logger.log('trips 頁籤已有東京行程登記列，跳過。');
    return;
  }

  sheet.appendRow([
    DEFAULT_TRIP_ID,
    '東京質感自由行 2026',
    '日本・東京',
    '2026-06-24',
    '2026-06-29',
    new Date()
  ]);
  Logger.log('seedTripsTab() 完成，已登記東京行程（trip_id = ' + DEFAULT_TRIP_ID + '）。');
}

// ──────────────────────────────────────────
//  初始化（只需執行一次）
// ──────────────────────────────────────────

function initSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    Logger.log('工作表「' + SHEET_NAME + '」已建立');
  }

  if (sheet.getLastRow() > 0) {
    Logger.log('工作表已有資料，跳過 initSheet()。若需重設請手動清空工作表後再執行。');
    return;
  }

  // 寫入標題列
  sheet.appendRow(HEADERS);

  // 標題樣式
  var headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e8f0fe');
  sheet.setFrozenRows(1);

  // 調整常用欄寬（HEADERS 現在以 trip_id 開頭，欄位序號 +1）
  sheet.setColumnWidth(5, 220);  // spot_name
  sheet.setColumnWidth(4, 180);  // day_title
  sheet.setColumnWidth(10, 320); // description

  Logger.log('initSheet() 完成。請接著執行 seedData() 匯入初始行程資料。');
}

// ──────────────────────────────────────────
//  初始資料填入（只需執行一次）
//  duration 單位：分鐘（0 = 不計入排序演算法，如航班節點）
// ──────────────────────────────────────────

function seedData() {
  var sheet = getSheet();

  if (sheet.getLastRow() > 1) {
    Logger.log('工作表已有資料（' + (sheet.getLastRow() - 1) + ' 筆），跳過 seedData()。若需重置請手動清除資料列。');
    return;
  }

  // 欄位順序：day, date, day_title, spot_name, duration, region_name,
  //           latitude, longitude, description, address, opening_hours, sort_order, travel_mins
  //           （trip_id 統一在寫入時補在最前面，day_start 在下方另行設定）
  var rows = [
    // ── Day 1：2026-06-24 入境輕落地：五反田周邊三角散步 ──────────────────
    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '去程 CI 0220｜松山 09:00 → 羽田 13:10', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '中華航空 CI 0220。入境後搭京急電鐵至品川，轉 JR 山手線至五反田，辦理入住約 15:00。訂位代號：DQ4JMF。',
      '', '[]', 0, 0],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '惠比壽 ガーデンプレイス 散策', 60,
      '東京市區', 35.6467, 139.7100,
      '昔日札幌啤酒廠改建的歐式廣場，下午茶氛圍絕佳，無須消費也可散步拍照。',
      '', '[]', 1, 20],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '代官山 蔦屋書店（T-SITE）', 60,
      '東京市區', 35.6485, 139.7034,
      '日本最具代表性的選物型書店，三棟白色建築，內有旅遊書、藝術品、咖啡廳。感受代官山氣質的最直接方式。',
      '', '[]', 2, 10],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '中目黑 目黑川沿岸', 90,
      '東京市區', 35.6441, 139.6979,
      '目黑川兩側林立獨立咖啡廳、麵包店、選物店。6 月梅雨後綠意濃厚，傍晚水岸光線極美。',
      '', '[]', 3, 10],

    // ── Day 2：2026-06-25 下町時光：谷中老街與淺草燈火 ──────────────────
    [2, '2026-06-25', '下町時光：谷中老街與淺草燈火',
      '谷中銀座商店街', 90,
      '東京市區', 35.7268, 139.7698,
      '昭和氣息最濃厚的在地小商店街，貓咪遍佈的石板老巷，豆腐店、煎餅鋪、古董小物。東京最有人情味的散步路線。',
      '', '[]', 0, 0],

    [2, '2026-06-25', '下町時光：谷中老街與淺草燈火',
      '淺草 雷門・仲見世通', 90,
      '東京市區', 35.7116, 139.7964,
      '江戶風情的標誌大門，仲見世通可買到正統人形燒與草餅。站在吾妻橋即可遠眺晴空塔，無需購票。',
      '', '[]', 1, 20],

    // ── Day 3：2026-06-26 東京迪士尼海洋 全日沉浸 ───────────────────────
    [3, '2026-06-26', '東京迪士尼海洋 全日沉浸',
      '東京迪士尼海洋 (Tokyo DisneySea)', 600,
      '舞濱・千葉', 35.6270, 139.8845,
      '全球唯一以「海洋」為主題的迪士尼樂園，七大港灣各有異國情調。6 月梅雨季人潮相對少，建議 08:30 前抵達閘口。',
      '', '[]', 0, 0],

    // ── Day 4：2026-06-27 小江戶川越 + 回程澀谷天空 ────────────────────
    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '藏造老街（一番街）', 60,
      '川越', 35.9249, 139.4878,
      '江戶時代商人街區，黑色蔵造倉庫連棟而立。兩側藏著老醬油店、和菓子鋪與手工雜貨，氣息比淺草更為清靜。',
      '', '[]', 0, 0],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '時之鐘（時の鐘）', 30,
      '川越', 35.9239, 139.4880,
      '川越最具代表性的木造地標，每天 12:00、15:00、18:00 整點報時。與藏造老街相鄰，步行可達。',
      '', '[]', 1, 5],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '菓子屋橫丁', 30,
      '川越', 35.9221, 139.4894,
      '明治時代保留至今的糖果小巷，十幾間老舖販賣江戶糖果、炸饅頭、麥芽糖棒，是日本現存最完整的糖果街景。',
      '', '[]', 2, 5],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '川越冰川神社', 45,
      '川越', 35.9299, 139.4843,
      '粉色系結緣神社，每月更換限定御守設計，以緣結び聞名關東。社境內有古木參道，氣氛清靜。',
      '', '[]', 3, 10],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '澀谷 SKY 觀景台', 90,
      '東京市區', 35.6580, 139.7016,
      '360 度全開放天空觀景台。從川越返回東京卡黃金時段俯瞰夜景。務必提前線上購票。',
      '', '[]', 4, 45],

    // ── Day 5：2026-06-28 湘南日歸：鎌倉老街影巷與江之島神社 ──────────
    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '御霊神社（権五郎神社）', 45,
      '鎌倉', 35.3186, 139.5350,
      '江之電穿越鳥居的奇景，6月梅雨時節境內繡球花盛開，是鎌倉最具電影感的神社。',
      '', '[]', 0, 0],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      'Tanaka Barber Shop（田中理髪店）', 20,
      '鎌倉', 35.3166, 139.5371,
      '坂ノ下的昭和老理髮廳，復古細緻的店面外觀是江ノ電沿線最受攝影師喜愛的靜物取景地。',
      '', '[]', 1, 5],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '極楽寺（極楽寺）', 45,
      '鎌倉', 35.3132, 139.5359,
      '江ノ電最神祕的小站，苔蘚覆蓋的山門與古寺。6 月梅雨期青苔翠綠飽滿，氣氛幽靜如進入另一個時空。',
      '', '[]', 2, 10],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '片瀬漁港 白灯台', 30,
      '湘南・江之島', 35.3049, 139.4782,
      '片瀬漁港盡頭的白色小燈台，背景是平靜入江與江ノ島本島，是湘南海岸少有人知的清靜攝影點。',
      '', '[]', 3, 20],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '江ノ島郵便局（韓劇《愛情怎麼翻譯》取景地）', 30,
      '湘南・江之島', 35.3019, 139.4816,
      '位於江ノ島入口的昭和紅色郵筒，是韓劇《愛情怎麼翻譯》的知名取景地。在此寄一張明信片回台灣。',
      '', '[]', 4, 5],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '江島神社（辺津宮・中津宮・奥津宮）', 60,
      '湘南・江之島', 35.2997, 139.4831,
      '從島口沿參道依序走過三座神社：辺津宮（財運）→ 中津宮（藝術）→ 奥津宮（海洋守護），全程步行約 40 分鐘。',
      '', '[]', 5, 10],

    // ── Day 6：2026-06-29 最終早晨：麻布台之丘 → 羽田起飛 ──────────────
    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '麻布台之丘（Azabudai Hills）', 90,
      '東京市區', 35.6596, 139.7390,
      '2023 年末開幕的複合文化建築群，早上 9 點人最少，可悠閒欣賞森 JP 塔的建築量體與空中花園。',
      '', '[]', 0, 0],

    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '羽田空港 國際線ターミナル', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '班機 14:30，國際線建議 12:30 前抵達辦理報到。從麻布台搭日比谷線至大門，轉京急空港線，約 40-50 分鐘。',
      '', '[]', 1, 45],

    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '回程 CI 0221｜羽田 14:30 → 松山 16:55', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '中華航空 CI 0221，飛行時間約 3 小時 25 分。東京羽田 (HND) 14:30 → 台北松山 (TSA) 16:55。訂位代號：DQ4JMF。',
      '', '[]', 2, 0]
  ];

  rows.forEach(function(row) { sheet.appendRow([DEFAULT_TRIP_ID].concat(row)); });

  // 設定各天的預設出發時間
  var dayStartMap = { 1: '13:00', 2: '10:30', 3: '08:30', 4: '10:00', 5: '10:30', 6: '09:00' };
  var h2      = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var startCol = h2.indexOf('day_start');
  var dayColN  = h2.indexOf('day');
  if (startCol >= 0) {
    var allData = sheet.getDataRange().getValues();
    for (var r2 = 1; r2 < allData.length; r2++) {
      var d2 = Number(allData[r2][dayColN]);
      if (dayStartMap[d2]) sheet.getRange(r2 + 1, startCol + 1).setValue(dayStartMap[d2]);
    }
  }

  Logger.log('seedData() 完成，共匯入 ' + rows.length + ' 筆景點資料（6 天行程，trip_id = ' + DEFAULT_TRIP_ID + '）。');
}

// ──────────────────────────────────────────
//  班機頁籤管理（flights sheet）
// ──────────────────────────────────────────

function initFlightSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(FLIGHT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(FLIGHT_SHEET_NAME);
  if (sheet.getLastRow() > 0) {
    Logger.log('flights 工作表已有資料，跳過 initFlightSheet()');
    return;
  }
  sheet.appendRow(FLIGHT_HEADERS);
  var hr = sheet.getRange(1, 1, 1, FLIGHT_HEADERS.length);
  hr.setFontWeight('bold');
  hr.setBackground('#fce8e6');
  sheet.setFrozenRows(1);
  Logger.log('flights 工作表建立完成。請執行 seedFlightData() 填入班機資料。');
}

function seedFlightData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIGHT_SHEET_NAME);
  if (!sheet) { Logger.log('請先執行 initFlightSheet()'); return; }
  if (sheet.getLastRow() > 1) { Logger.log('flights 已有資料，跳過'); return; }
  sheet.appendRow([
    DEFAULT_TRIP_ID,
    1,
    '去程 CI 0220｜松山 09:00 → 羽田 13:10',
    '中華航空 CI 0220，飛行時間約 3 小時 10 分。台北松山 (TSA) 09:00 起飛，東京羽田 (HND) 13:10 抵達。訂位代號：DQ4JMF。入境後搭乘京急電鐵至五反田，飯店辦理入住預計 14:30-15:00。',
    '入境後搭乘京急空港線至品川站，轉 JR 山手線至五反田站',
    '入境 + 電車約 60-80 分鐘',
    'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination=羽田空港第3ターミナル駅&travelmode=transit'
  ]);
  sheet.appendRow([
    DEFAULT_TRIP_ID,
    6,
    '回程 CI 0221｜羽田 14:30 → 松山 16:55',
    '中華航空 CI 0221，飛行時間約 3 小時 25 分。東京羽田 (HND) 14:30 → 台北松山 (TSA) 16:55。訂位代號：DQ4JMF。國際線建議 12:30 前完成報到手續。',
    '羽田空港第3ターミナル 辦理登機手續，行李可事先寄放飯店輕裝出發',
    '建議 12:30 前抵達機場',
    'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination=羽田空港第3ターミナル駅&travelmode=transit'
  ]);
  Logger.log('seedFlightData() 完成，已新增 2 筆班機資料。');
}

// 從 itinerary 頁籤把班機資料移至 flights 頁籤（執行一次即可）
function migrateFlightsFromItinerary() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var iSheet = getSheet();
  var fSheet = ss.getSheetByName(FLIGHT_SHEET_NAME);
  if (!fSheet) { Logger.log('請先執行 initFlightSheet()'); return; }

  var iData    = iSheet.getDataRange().getValues();
  var iHeaders = iData[0];
  var nameCol  = iHeaders.indexOf('spot_name');
  var dayCol   = iHeaders.indexOf('day');
  var descCol  = iHeaders.indexOf('description');
  var tripCol  = iHeaders.indexOf('trip_id');

  var toDelete = [];
  for (var r = 1; r < iData.length; r++) {
    var name = String(iData[r][nameCol] || '');
    if (name.indexOf('去程') !== -1 || name.indexOf('回程') !== -1) {
      var tripId = tripCol >= 0 ? String(iData[r][tripCol] || '') : '';
      fSheet.appendRow([tripId, Number(iData[r][dayCol]), name, String(iData[r][descCol] || ''), '', '', '']);
      toDelete.push(r + 1);
    }
  }
  for (var i = toDelete.length - 1; i >= 0; i--) {
    iSheet.deleteRow(toDelete[i]);
  }
  Logger.log('遷移完成，已移動 ' + toDelete.length + ' 筆班機資料至 flights 頁籤。');
}
