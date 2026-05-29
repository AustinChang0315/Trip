/**
 * ══════════════════════════════════════════════════
 *  Google Apps Script — 旅遊記帳接收端
 *  版本：1.0   用途：接收前端 POST，寫入 Google 試算表
 * ══════════════════════════════════════════════════
 *
 *  【設定步驟】
 *
 *  1. 打開你的 Google 試算表（Google Sheets）
 *
 *  2. 點選上方選單：擴充功能 → Apps Script
 *
 *  3. 刪除編輯器裡的所有預設程式碼
 *
 *  4. 把這整個檔案的內容全部貼上去
 *
 *  5. 點「部署」→「新增部署作業」
 *     - 類型：選「網頁應用程式」
 *     - 執行身分：「我（你的 Gmail 帳號）」
 *     - 具有存取權的使用者：「所有人」
 *     → 授權後，複製「網頁應用程式 URL」
 *
 *  6. 回到 index.html，找到這一行：
 *       const GAS_URL = 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE';
 *     把 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE' 替換成剛剛複製的網址
 *
 *  7. 完成！之後每次記帳，資料會自動出現在試算表第一個工作表
 *
 *  【試算表欄位格式】
 *  A: 日期（YYYY-MM-DD）
 *  B: 項目（說明）
 *  C: 分類（餐飲 / 交通 / 體驗 / 購物 / 其他）
 *  D: 金額(JPY)
 *  E: 記錄時間（日本時間）
 *
 * ══════════════════════════════════════════════════
 */

function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const sheet  = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // 若試算表是空的，自動建立標題列
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['日期', '項目', '分類', '金額(JPY)', '記錄時間']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    // 寫入記帳資料
    sheet.appendRow([
      data.date        || '',
      data.item        || '',
      data.category    || '其他',
      data.amount_jpy  || 0,
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

// GET 請求回應（用於測試連線是否正常）
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: '記帳 API 運作中' }))
    .setMimeType(ContentService.MimeType.JSON);
}
