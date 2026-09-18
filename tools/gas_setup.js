/**
 * ══════════════════════════════════════════════════
 *  Google Apps Script — 旅遊記帳接收 + 即時統計
 *  版本：4.0（記帳金額統一輸入 TWD，外幣估算改由前端即時匯率負責）
 * ══════════════════════════════════════════════════
 *
 *  【設定步驟】（如果是第一次設定）
 *
 *  1. 打開你的 Google 試算表
 *  2. 擴充功能 → Apps Script
 *  3. 刪除所有程式碼，貼上這整個檔案的內容
 *  4. 部署 → 新增部署作業
 *     - 類型：網頁應用程式
 *     - 執行身分：我
 *     - 具有存取權：所有人
 *  5. 複製網址貼回 index.html 的 GAS_URL
 *
 *  【已有設定，更新腳本】
 *  1. 貼上新程式碼後
 *  2. 部署 → 管理部署作業 → 編輯（鉛筆圖示）
 *  3. 版本選「建立新版本」→ 部署
 *  （網址不變，不需要改 index.html）
 *  4. 若試算表已有舊資料（沒有 trip_id 欄位），
 *     在 G 欄手動補上 trip_id = 'tokyo-2026-06'
 *     （跟 google-backend.js 的 DEFAULT_TRIP_ID 一致）
 *  5. 這次改版把金額欄位的意義從「日圓」統一改成「新台幣」。
 *     舊資料（東京行程）本來存的是真實日圓數字，需要執行一次
 *     migrateAmountsToTWD() 把既有東京資料換算成 TWD，其他行程不受影響。
 *
 *  【試算表欄位格式】
 *  A: 日期　B: 項目　C: 分類　D: 金額(TWD)　E: 支付方式　F: 記錄時間　G: trip_id
 * ══════════════════════════════════════════════════
 */

var CATS = ['餐飲', '交通', '體驗', '購物', '購物-寶寶', '購物-ㄚ鼻', '其他'];
var COLS = 7; // A~G

// 既有東京行程升級時使用的固定 ID（與 google-backend.js 的 DEFAULT_TRIP_ID 一致）
var DEFAULT_TRIP_ID  = 'tokyo-2026-06';
// 東京舊資料原本是日圓，一次性遷移換算成 TWD 用的匯率（跟舊版 JPY_TWD 常數相同）
var LEGACY_JPY_TO_TWD = 0.215;

// 日期欄位可能是 Date 物件、YYYY-MM-DD 字串，或「Wed Nov 18 2026 ...」這種
// toString() 字串（Sheets 有時不會把日期字串自動轉成 Date 型別，讀回來就是這種格式）。
// 一律正規化成 YYYY-MM-DD，直接從字串裡的月/日/年 token 取值，不透過 Date 物件運算，
// 避免 Apps Script 專案預設時區跟 Asia/Tokyo 不一致時，日期被前後位移一天。
function normalizeExpenseDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var m = s.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/); // 例如 "Wed Nov 18 2026 ..."
  if (m) {
    var MON = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
    var mm = MON[m[1]];
    if (mm) return m[3] + '-' + mm + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]);
  }
  return s.substring(0, 10);
}

// ── POST：接收前端記帳資料，寫入試算表 ──────────────
function doPost(e) {
  try {
    var data  = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // 刪除明細
    if (data.action === 'delete') {
      if (data.rowIndex && data.rowIndex > 1) {
        sheet.deleteRow(data.rowIndex);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 編輯行程日期時，把被移出日期範圍的記帳資料一併刪除
    if (data.action === 'delete_by_dates') {
      var tripId = String(data.trip_id || '');
      var dateSet = {};
      (data.dates || []).forEach(function(d) { dateSet[String(d)] = true; });
      var lastRow = sheet.getLastRow();
      var removed = 0;
      if (tripId && lastRow > 1) {
        var rows = sheet.getRange(2, 1, lastRow - 1, COLS).getValues();
        for (var r = rows.length - 1; r >= 0; r--) {
          var row = rows[r];
          var rowTripId = String(row[6] || '');
          if (rowTripId !== tripId) continue;
          var rowDate = normalizeExpenseDate(row[0]);
          if (dateSet[rowDate]) {
            sheet.deleteRow(r + 2); // +2：跳過標題列 + 轉回 1-based
            removed++;
          }
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, removed: removed }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 未知的 action：代表前端版本比目前部署的後端新（例如忘記重新部署）。
    // 一定要在這裡擋下來，否則會落到最下面的「新增記帳」邏輯，
    // 誤把一筆不完整的資料寫成一筆金額 0、日期空白的假記帳。
    if (data.action && data.action !== 'add') {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: '不支援的 action: ' + data.action }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['日期', '項目', '分類', '金額(TWD)', '支付方式', '記錄時間', 'trip_id']);
      sheet.getRange(1, 1, 1, COLS).setFontWeight('bold');
    }

    sheet.appendRow([
      data.date       || '',
      data.item       || '',
      data.category   || '其他',
      data.amount_twd || 0,
      data.payment    || '現金',
      new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      data.trip_id    || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── GET：即時計算統計資料，回傳給前端圖表（依 trip_id 過濾）───
// 金額欄位一律是 TWD 原始數字，不在後端做任何幣別換算——
// 「估算外幣」是純顯示需求，且每個行程當地幣別不同，換算交給前端處理。
function doGet(e) {
  try {
    var tripId = e && e.parameter && e.parameter.trip_id;
    if (!tripId) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'trip_id is required' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet   = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var lastRow = sheet.getLastRow();

    var catTotals = {};
    CATS.forEach(function(c) { catTotals[c] = 0; });
    var total = 0;
    var daily = {};
    var records = [];

    if (lastRow > 1) {
      var rows = sheet.getRange(2, 1, lastRow - 1, COLS).getValues();
      rows.forEach(function(row, i) {
        var rowTripId = String(row[6] || '');
        if (rowTripId !== String(tripId)) return; // 只統計當前行程的記帳資料

        var date = normalizeExpenseDate(row[0]);
        var cat  = String(row[2] || '其他').trim();
        var twd  = parseInt(row[3]) || 0;

        total += twd;

        if (catTotals.hasOwnProperty(cat)) {
          catTotals[cat] += twd;
        } else {
          catTotals['其他'] += twd;
        }

        if (date) {
          daily[date] = (daily[date] || 0) + twd;
          records.push({
            rowIndex:   i + 2,
            date:       date,
            item:       String(row[1] || ''),
            category:   cat,
            amount_twd: twd,
            payment:    String(row[4] || '現金')
          });
        }
      });
    }

    var categories = CATS.map(function(name) {
      return {
        name: name,
        twd:  catTotals[name],
        percentage: total > 0 ? Math.round(catTotals[name] / total * 100) : 0
      };
    });

    var dailyBreakdown = Object.keys(daily).sort().map(function(date) {
      return { date: date, twd: daily[date] };
    });

    var result = {
      total_twd:       total,
      categories:      categories,
      daily_breakdown: dailyBreakdown,
      records:         records,
      last_synced:     new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Tokyo' })
    };

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ──────────────────────────────────────────
//  一次性資料遷移（記帳金額改成 TWD 計價時執行一次）
// ──────────────────────────────────────────

// 執行方式：Apps Script 編輯器 → 選擇 migrateAmountsToTWD → 點執行
// 只處理 trip_id = DEFAULT_TRIP_ID（東京行程）的既有資料列——
// 這些數字原本真的是日圓，換算成 TWD 才能跟其他行程用同一套欄位意義。
// 其他行程（本來就沒有資料，或已經是用 TWD 輸入）完全不受影響。
function migrateAmountsToTWD() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('沒有資料，跳過。'); return; }

  // 表頭文字順便更新成 TWD
  var headerCell = sheet.getRange(1, 4);
  if (String(headerCell.getValue()).indexOf('JPY') >= 0) {
    headerCell.setValue('金額(TWD)');
  }

  var rows  = sheet.getRange(2, 1, lastRow - 1, COLS).getValues();
  var count = 0;
  for (var r = 0; r < rows.length; r++) {
    var tripId = String(rows[r][6] || '');
    if (tripId !== DEFAULT_TRIP_ID) continue; // 只換算東京舊資料
    var oldAmount = Number(rows[r][3]) || 0;
    var newAmount = Math.round(oldAmount * LEGACY_JPY_TO_TWD);
    sheet.getRange(r + 2, 4).setValue(newAmount);
    count++;
  }
  Logger.log('migrateAmountsToTWD() 完成，共轉換 ' + count + ' 筆（日圓 → TWD，僅限東京行程）。');
}

// 執行方式：Apps Script 編輯器 → 選擇 fixLegacyTwdMigration → 點執行
// migrateAmountsToTWD() 用的是 App 裡舊的寫死匯率（0.215），跟實際匯率有落差
// （2026-09 實際約 0.204），換算出來的 TWD 金額偏高。這裡改抓即時匯率，
// 把已經換算過的東京資料再校正一次。只需要執行一次；如果已經校正過，
// 不要再執行第二次，否則會被重複校正變成錯誤數字。
function fixLegacyTwdMigration() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('沒有資料，跳過。'); return; }

  var liveRate;
  try {
    var resp = UrlFetchApp.fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/jpy.json');
    var json = JSON.parse(resp.getContentText());
    liveRate = json && json.jpy && json.jpy.twd;
  } catch (err) {
    Logger.log('抓即時匯率失敗，中止校正：' + err);
    return;
  }
  if (!liveRate) { Logger.log('即時匯率回傳格式異常，中止校正。'); return; }

  var correctionFactor = liveRate / LEGACY_JPY_TO_TWD; // 把舊版 0.215 的結果修正成即時匯率
  var rows  = sheet.getRange(2, 1, lastRow - 1, COLS).getValues();
  var count = 0;
  for (var r = 0; r < rows.length; r++) {
    var tripId = String(rows[r][6] || '');
    if (tripId !== DEFAULT_TRIP_ID) continue; // 只校正東京舊資料
    var oldTwd = Number(rows[r][3]) || 0;
    var newTwd = Math.round(oldTwd * correctionFactor);
    sheet.getRange(r + 2, 4).setValue(newTwd);
    count++;
  }
  Logger.log('fixLegacyTwdMigration() 完成，即時匯率 1 JPY ≈ ' + liveRate + ' TWD，'
    + '校正係數 ' + correctionFactor.toFixed(4) + '，共修正 ' + count + ' 筆。');
}
