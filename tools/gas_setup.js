/**
 * ══════════════════════════════════════════════════
 *  Google Apps Script — 旅遊記帳接收 + 即時統計
 *  版本：2.0
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
 *
 *  【試算表欄位格式】
 *  A: 日期　B: 項目　C: 分類　D: 金額(JPY)　E: 記錄時間
 * ══════════════════════════════════════════════════
 */

var JPY_TWD = 0.215; // 匯率，可自行調整
var CATS    = ['餐飲', '交通', '體驗', '購物', '購物-寶寶', '購物-ㄚ鼻', '其他'];

// ── POST：接收前端記帳資料，寫入試算表 ──────────────
function doPost(e) {
  try {
    var data  = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['日期', '項目', '分類', '金額(JPY)', '記錄時間']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    sheet.appendRow([
      data.date       || '',
      data.item       || '',
      data.category   || '其他',
      data.amount_jpy || 0,
      new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
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

// ── GET：即時計算統計資料，回傳給前端圖表 ────────────
function doGet() {
  try {
    var sheet   = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var lastRow = sheet.getLastRow();

    var catTotals = {};
    CATS.forEach(function(c) { catTotals[c] = 0; });
    var total = 0;
    var daily = {};

    if (lastRow > 1) {
      var rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
      rows.forEach(function(row) {
        var date = row[0] ? String(row[0]).substring(0, 10) : '';
        var cat  = String(row[2] || '其他').trim();
        var jpy  = parseInt(row[3]) || 0;

        total += jpy;

        if (catTotals.hasOwnProperty(cat)) {
          catTotals[cat] += jpy;
        } else {
          catTotals['其他'] += jpy;
        }

        if (date) {
          daily[date] = (daily[date] || 0) + jpy;
        }
      });
    }

    var categories = CATS.map(function(name) {
      return {
        name: name,
        jpy:  catTotals[name],
        percentage: total > 0 ? Math.round(catTotals[name] / total * 100) : 0
      };
    });

    var dailyBreakdown = Object.keys(daily).sort().map(function(date) {
      return { date: date, jpy: daily[date], twd: Math.round(daily[date] * JPY_TWD) };
    });

    var result = {
      total_jpy:       total,
      total_twd:       Math.round(total * JPY_TWD),
      categories:      categories,
      daily_breakdown: dailyBreakdown,
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
