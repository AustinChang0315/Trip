// ============================================================
// 東京動態自由行 — Google Apps Script 後端 API
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
// 【CORS 說明】
//   GAS 不支援 OPTIONS preflight，因此前端 POST 請求
//   必須使用 Content-Type: text/plain（簡單請求，不觸發預檢）
//   本腳本在 doPost 中以 e.postData.contents 讀取 JSON body
// ============================================================

const SHEET_NAME = 'itinerary';
const FLIGHT_SHEET_NAME = 'flights';
const FLIGHT_HEADERS = [
  'day',               // 行程第幾天
  'spot_name',         // 航班標題
  'description',       // 完整說明
  'transport_method',  // 入境/出境後的交通方式
  'transport_duration',// 預估交通時間
  'maps_url'           // Google Maps 導航連結
];
const HEADERS = [
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
  'day_start'     // 當天出發時間（HH:MM 字串）
];

// ──────────────────────────────────────────
//  公開 API
// ──────────────────────────────────────────

function doGet(e) {
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return jsonResponse({ itinerary: [] });
    }

    const headers = data[0];
    const rows = data.slice(1); // 跳過標題列

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
      day_start:    headers.indexOf('day_start')
    };

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

    // 讀取班機資訊（flights 頁籤）
    var flights = [];
    try {
      var fSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIGHT_SHEET_NAME);
      if (fSheet && fSheet.getLastRow() > 1) {
        var fData    = fSheet.getDataRange().getValues();
        var fHeaders = fData[0];
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
    const sheet   = getSheet();

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
  const day_title = payload.day_title || getDayTitle(sheet, payload.day) || '';

  // 取得當天最大 sort_order，新景點排在最後
  const existingSortOrder = payload.sort_order !== undefined
    ? Number(payload.sort_order)
    : getMaxSortOrder(sheet, payload.day) + 1;

  sheet.appendRow([
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
    String(payload.day_start || getDayStart(sheet, payload.day) || '09:00')
  ]);

  return jsonResponse({ success: true, message: '景點已新增：' + payload.spot_name });
}

function handleDelete(sheet, payload) {
  const targetName = String(payload.spot_name);
  const targetDay  = Number(payload.day);
  const data       = sheet.getDataRange().getValues();

  // 從最後一列往前掃，避免刪除後索引位移
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][3]) === targetName && Number(data[i][0]) === targetDay) {
      sheet.deleteRow(i + 1); // GAS 工作表列從 1 開始
      return jsonResponse({ success: true, message: '景點已刪除：' + targetName });
    }
  }

  return jsonResponse({ success: false, error: '找不到景點「' + targetName + '」（Day ' + targetDay + '）' });
}

function handleUpdateOrder(sheet, payload) {
  const targetDay = Number(payload.day);
  const spots     = payload.spots || []; // [{ spot_name, sort_order, travel_mins }, ...]

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  const nameCol    = headers.indexOf('spot_name');
  const dayCol     = headers.indexOf('day');
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

  // 建立 spot_name → { sort_order, travel_mins } 的快查 map
  var orderMap = {};
  spots.forEach(function(s) {
    orderMap[String(s.spot_name)] = {
      sort_order:  Number(s.sort_order  || 0),
      travel_mins: Number(s.travel_mins || 0)
    };
  });

  // 批次更新符合條件的列
  for (var r = 1; r < data.length; r++) {
    var rowDay  = Number(data[r][dayCol]);
    var rowName = String(data[r][nameCol]);
    if (rowDay === targetDay && orderMap[rowName] !== undefined) {
      sheet.getRange(r + 1, sortCol  + 1).setValue(orderMap[rowName].sort_order);
      sheet.getRange(r + 1, travelCol + 1).setValue(orderMap[rowName].travel_mins);
    }
  }

  return jsonResponse({ success: true, message: 'Day ' + targetDay + ' 順序已更新' });
}

function handleUpdateDayStart(sheet, payload) {
  const targetDay = Number(payload.day);
  const newStart  = String(payload.day_start || '09:00');

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  const dayCol   = headers.indexOf('day');
  var   startCol = headers.indexOf('day_start');

  if (startCol < 0) {
    startCol = headers.length;
    sheet.getRange(1, startCol + 1).setValue('day_start');
    headers.push('day_start');
  }

  for (var r = 1; r < data.length; r++) {
    if (Number(data[r][dayCol]) === targetDay) {
      sheet.getRange(r + 1, startCol + 1).setNumberFormat('@').setValue(newStart);
    }
  }

  return jsonResponse({ success: true, message: 'Day ' + targetDay + ' 出發時間已更新為 ' + newStart });
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

// 新增景點時若未傳 day_title，從既有資料補回同天的 day_title
function getDayTitle(sheet, targetDay) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (Number(data[i][0]) === Number(targetDay)) {
      return String(data[i][2]);
    }
  }
  return '';
}

// 取得當天的出發時間（新增景點時繼承同天已有的設定）
function getDayStart(sheet, targetDay) {
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var dayCol   = headers.indexOf('day');
  var startCol = headers.indexOf('day_start');
  if (startCol < 0) return '09:00';
  for (var i = 1; i < data.length; i++) {
    if (Number(data[i][dayCol]) === Number(targetDay) && data[i][startCol]) {
      return String(data[i][startCol]);
    }
  }
  return '09:00';
}

// 取得當天景點最大的 sort_order（新景點排在最後用）
function getMaxSortOrder(sheet, targetDay) {
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var dayCol  = headers.indexOf('day');
  var sortCol = headers.indexOf('sort_order');
  if (sortCol < 0) return -1;
  var max = -1;
  for (var i = 1; i < data.length; i++) {
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

  var toAdd = ['address', 'opening_hours', 'sort_order', 'travel_mins', 'day_start'].filter(function(h) {
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

  // 調整常用欄寬
  sheet.setColumnWidth(4, 220);  // spot_name
  sheet.setColumnWidth(3, 180);  // day_title
  sheet.setColumnWidth(9, 320);  // description

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
  //           （day_start 在下方另行設定）
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

  rows.forEach(function(row) { sheet.appendRow(row); });

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

  Logger.log('seedData() 完成，共匯入 ' + rows.length + ' 筆景點資料（6 天行程）。');
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
    1,
    '去程 CI 0220｜松山 09:00 → 羽田 13:10',
    '中華航空 CI 0220，飛行時間約 3 小時 10 分。台北松山 (TSA) 09:00 起飛，東京羽田 (HND) 13:10 抵達。訂位代號：DQ4JMF。入境後搭乘京急電鐵至五反田，飯店辦理入住預計 14:30-15:00。',
    '入境後搭乘京急空港線至品川站，轉 JR 山手線至五反田站',
    '入境 + 電車約 60-80 分鐘',
    'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination=羽田空港第3ターミナル駅&travelmode=transit'
  ]);
  sheet.appendRow([
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

  var toDelete = [];
  for (var r = 1; r < iData.length; r++) {
    var name = String(iData[r][nameCol] || '');
    if (name.indexOf('去程') !== -1 || name.indexOf('回程') !== -1) {
      fSheet.appendRow([Number(iData[r][dayCol]), name, String(iData[r][descCol] || ''), '', '', '']);
      toDelete.push(r + 1);
    }
  }
  for (var i = toDelete.length - 1; i >= 0; i--) {
    iSheet.deleteRow(toDelete[i]);
  }
  Logger.log('遷移完成，已移動 ' + toDelete.length + ' 筆班機資料至 flights 頁籤。');
}
