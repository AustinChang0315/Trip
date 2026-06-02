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
const HEADERS = [
  'day',          // 行程第幾天（integer）
  'date',         // 日期 YYYY-MM-DD
  'day_title',    // 當日主題標題
  'spot_name',    // 景點名稱
  'duration',     // 停留分鐘數（integer，0 = 不計入排序）
  'region_name',  // 地區名（用於天氣去重）
  'latitude',     // 緯度（float）
  'longitude',    // 經度（float）
  'description'   // 景點描述
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

    const rows = data.slice(1); // 跳過標題列
    const dayMap = new Map();   // Map 保持天數插入順序

    rows.forEach(function(row) {
      const day       = Number(row[0]);
      const date      = toYMD(row[1]);
      const day_title = String(row[2]);
      const spot_name = String(row[3]);
      const duration  = Number(row[4]);
      const region    = String(row[5]);
      const lat       = Number(row[6]);
      const lng       = Number(row[7]);
      const desc      = String(row[8]);

      if (!dayMap.has(day)) {
        dayMap.set(day, { day: day, date: date, day_title: day_title, spots: [] });
      }

      dayMap.get(day).spots.push({
        spot_name:   spot_name,
        duration:    duration,
        region_name: region,
        latitude:    lat,
        longitude:   lng,
        description: desc,
        transport: {
          google_maps_url: buildNavUrl(lat, lng, spot_name) // 優先用座標，避免同名店家導航錯誤
        }
      });
    });

    const itinerary = Array.from(dayMap.values())
      .sort(function(a, b) { return a.day - b.day; });

    return jsonResponse({ itinerary: itinerary });

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

    if (action === 'add')    return handleAdd(sheet, payload);
    if (action === 'delete') return handleDelete(sheet, payload);

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

  sheet.appendRow([
    Number(payload.day),
    String(payload.date       || ''),
    String(day_title),
    String(payload.spot_name  || ''),
    Number(payload.duration   || 60),
    String(payload.region_name|| ''),
    Number(payload.latitude   || 0),
    Number(payload.longitude  || 0),
    String(payload.description|| '')
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

// ──────────────────────────────────────────
//  工具函數
// ──────────────────────────────────────────

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

function buildMapsUrl(spotName) {
  return 'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination='
    + encodeURIComponent(String(spotName))
    + '&travelmode=transit';
}

// 優先用精確座標當 destination，避免同名店家導航跑錯
function buildNavUrl(lat, lng, spotName) {
  if (lat && lng) {
    return 'https://www.google.com/maps/dir/?api=1&origin=My+Location&destination='
      + lat + ',' + lng + '&travelmode=transit';
  }
  return buildMapsUrl(spotName);
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
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

  var rows = [
    // ── Day 1：2026-06-24 入境輕落地：五反田周邊三角散步 ──────────────────
    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '去程 CI 0220｜松山 09:00 → 羽田 13:10', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '中華航空 CI 0220。入境後搭京急電鐵至品川，轉 JR 山手線至五反田，辦理入住約 15:00。訂位代號：DQ4JMF。'],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '惠比壽 ガーデンプレイス 散策', 60,
      '東京市區', 35.6467, 139.7100,
      '昔日札幌啤酒廠改建的歐式廣場，下午茶氛圍絕佳，無須消費也可散步拍照。'],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '代官山 蔦屋書店（T-SITE）', 60,
      '東京市區', 35.6485, 139.7034,
      '日本最具代表性的選物型書店，三棟白色建築，內有旅遊書、藝術品、咖啡廳。感受代官山氣質的最直接方式。'],

    [1, '2026-06-24', '入境輕落地：五反田周邊三角散步',
      '中目黑 目黑川沿岸', 90,
      '東京市區', 35.6441, 139.6979,
      '目黑川兩側林立獨立咖啡廳、麵包店、選物店。6 月梅雨後綠意濃厚，傍晚水岸光線極美。'],

    // ── Day 2：2026-06-25 下町時光：谷中老街與淺草燈火 ──────────────────
    [2, '2026-06-25', '下町時光：谷中老街與淺草燈火',
      '谷中銀座商店街', 90,
      '東京市區', 35.7268, 139.7698,
      '昭和氣息最濃厚的在地小商店街，貓咪遍佈的石板老巷，豆腐店、煎餅鋪、古董小物。東京最有人情味的散步路線。'],

    [2, '2026-06-25', '下町時光：谷中老街與淺草燈火',
      '淺草 雷門・仲見世通', 90,
      '東京市區', 35.7116, 139.7964,
      '江戶風情的標誌大門，仲見世通可買到正統人形燒與草餅。站在吾妻橋即可遠眺晴空塔，無需購票。'],

    // ── Day 3：2026-06-26 東京迪士尼海洋 全日沉浸 ───────────────────────
    [3, '2026-06-26', '東京迪士尼海洋 全日沉浸',
      '東京迪士尼海洋 (Tokyo DisneySea)', 600,
      '舞濱・千葉', 35.6270, 139.8845,
      '全球唯一以「海洋」為主題的迪士尼樂園，七大港灣各有異國情調。6 月梅雨季人潮相對少，建議 08:30 前抵達閘口。'],

    // ── Day 4：2026-06-27 小江戶川越 + 回程澀谷天空 ────────────────────
    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '藏造老街（一番街）', 60,
      '川越', 35.9249, 139.4878,
      '江戶時代商人街區，黑色蔵造倉庫連棟而立。兩側藏著老醬油店、和菓子鋪與手工雜貨，氣息比淺草更為清靜。'],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '時之鐘（時の鐘）', 30,
      '川越', 35.9239, 139.4880,
      '川越最具代表性的木造地標，每天 12:00、15:00、18:00 整點報時。與藏造老街相鄰，步行可達。'],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '菓子屋橫丁', 30,
      '川越', 35.9221, 139.4894,
      '明治時代保留至今的糖果小巷，十幾間老舖販賣江戶糖果、炸饅頭、麥芽糖棒，是日本現存最完整的糖果街景。'],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '川越冰川神社', 45,
      '川越', 35.9299, 139.4843,
      '粉色系結緣神社，每月更換限定御守設計，以緣結び聞名關東。社境內有古木參道，氣氛清靜。'],

    [4, '2026-06-27', '小江戶川越 + 回程澀谷天空',
      '澀谷 SKY 觀景台', 90,
      '東京市區', 35.6580, 139.7016,
      '360 度全開放天空觀景台。從川越返回東京卡黃金時段俯瞰夜景。務必提前線上購票。'],

    // ── Day 5：2026-06-28 湘南日歸：鎌倉老街影巷與江之島神社 ──────────
    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '御霊神社（権五郎神社）', 45,
      '鎌倉', 35.3186, 139.5350,
      '江之電穿越鳥居的奇景，6月梅雨時節境內繡球花盛開，是鎌倉最具電影感的神社。'],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      'Tanaka Barber Shop（田中理髪店）', 20,
      '鎌倉', 35.3166, 139.5371,
      '坂ノ下的昭和老理髮廳，復古細緻的店面外觀是江ノ電沿線最受攝影師喜愛的靜物取景地。'],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '極楽寺（極楽寺）', 45,
      '鎌倉', 35.3132, 139.5359,
      '江ノ電最神祕的小站，苔蘚覆蓋的山門與古寺。6 月梅雨期青苔翠綠飽滿，氣氛幽靜如進入另一個時空。'],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '片瀬漁港 白灯台', 30,
      '湘南・江之島', 35.3049, 139.4782,
      '片瀬漁港盡頭的白色小燈台，背景是平靜入江與江ノ島本島，是湘南海岸少有人知的清靜攝影點。'],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '江ノ島郵便局（韓劇《愛情怎麼翻譯》取景地）', 30,
      '湘南・江之島', 35.3019, 139.4816,
      '位於江ノ島入口的昭和紅色郵筒，是韓劇《愛情怎麼翻譯》的知名取景地。在此寄一張明信片回台灣。'],

    [5, '2026-06-28', '湘南日歸：鎌倉老街影巷與江之島神社',
      '江島神社（辺津宮・中津宮・奥津宮）', 60,
      '湘南・江之島', 35.2997, 139.4831,
      '從島口沿參道依序走過三座神社：辺津宮（財運）→ 中津宮（藝術）→ 奥津宮（海洋守護），全程步行約 40 分鐘。'],

    // ── Day 6：2026-06-29 最終早晨：麻布台之丘 → 羽田起飛 ──────────────
    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '麻布台之丘（Azabudai Hills）', 90,
      '東京市區', 35.6596, 139.7390,
      '2023 年末開幕的複合文化建築群，早上 9 點人最少，可悠閒欣賞森 JP 塔的建築量體與空中花園。'],

    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '羽田空港 國際線ターミナル', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '班機 14:30，國際線建議 12:30 前抵達辦理報到。從麻布台搭日比谷線至大門，轉京急空港線，約 40-50 分鐘。'],

    [6, '2026-06-29', '最終早晨：麻布台之丘 → 羽田起飛',
      '回程 CI 0221｜羽田 14:30 → 松山 16:55', 0,
      '羽田・東京灣', 35.5494, 139.7798,
      '中華航空 CI 0221，飛行時間約 3 小時 25 分。東京羽田 (HND) 14:30 → 台北松山 (TSA) 16:55。訂位代號：DQ4JMF。']
  ];

  rows.forEach(function(row) { sheet.appendRow(row); });
  Logger.log('seedData() 完成，共匯入 ' + rows.length + ' 筆景點資料（6 天行程）。');
}
