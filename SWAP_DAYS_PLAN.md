# 整天行程對調功能（從手機 App 直接觸發，免電腦）— 設計記錄

> 狀態：分析/設計已完成，**尚未實作**。先存檔記錄，待確認後再動工。

## Context

使用者（Austin）有時候規劃到一半，想把 Day3 跟 Day5 的「整天行程」直接互換（含景點與「周邊美食」區塊），但目前只能：
1. 手動刪除兩天全部景點，重新一個個加回去，或
2. 直接改兩個檔案：`data/itinerary.json`（spots/dining）+ `index.html` 裡的 `STATIC_DINING`（過去 `d7fb9ed` + `f87910e` 兩個 commit 就是在做這件事的子集——只交換 dining，沒交換 spots）。

深入看程式碼後發現關鍵事實：**App 正常上線時，景點 (`spots`) 其實是即時從 Google Sheet（GAS 後端）讀出來、整批取代 `itinerary.json` 的內容**（`index.html:834-835` 的 `mergeGAS()`），`itinerary.json` 只是離線備援/初始骨架。但 `dining`（周邊美食）與 `note` 這兩個欄位，GAS 的 Sheet schema 完全沒有對應欄位，永遠只從 `itinerary.json` 讀。

使用者明確表示：不想每次對調都要開電腦操作 Apps Script 或改 git 檔案，希望直接在手機上的 App 裡按一按就完成。要達成這個目標，**dining 資料必須也搬進 Google Sheet**，否則「對調」永遠有一半資料（dining）改不到。

## 設計方案

### 1. GAS 後端（`google-backend.js`）

- 新增一個 `dining` 工作表（仿照現有 `flights` sheet 的模式），欄位：`day, name, category, type, description, maps_url`。
- 新增 `initDiningSheet()` + 一次性 `seedDiningFromItinerary(jsonString)`／手動 seed 函式，把現有 `data/itinerary.json` 六天的 `dining` 陣列灌入這個新 sheet（一次性，只需要在 Apps Script 編輯器跑一次）。
- `doGet(e)`：仿照讀 `flights` sheet 的邏輯，多讀一次 `dining` sheet，按 `day` 分組後 attach 到回傳的 `itinerary[].dining`。
- `doPost(e)` 新增 `action: 'swap_days'`（payload: `{ day_a, day_b }`）→ `handleSwapDays(sheet, payload)`：
  - 自動從現有資料讀出 day_a / day_b 目前各自的 `date` 值（不需前端傳）。
  - 對 `itinerary` sheet：列的 `day===day_a` → 改成 `day=day_b, date=date_b`；`day===day_b` → 改成 `day=day_a, date=date_a`（其餘欄位包括 `day_title`、`spot_name`、座標等都留在原列上，自然跟著移動）。
  - 對新的 `dining` sheet：同樣邏輯，只需要換 `day` 欄（dining 項目沒有 `date` 欄）。
  - 對 `flights` sheet：防禦性地做同樣處理（目前 Day3/Day5 沒有班機節點，但保持通用性）。

### 2. 前端 (`index.html`)

- `mergeGAS()`：擴充成當 `gas.dining` 存在且非空時，取代 `day.dining`（與目前 `spots` 整批取代的邏輯一致）；維持「GAS > itinerary.json 的 dining > `STATIC_DINING` 硬編碼」三層備援順序（`prepareAndRender` 既有 fallback 不用動）。
- UI：在現有「↓ 下載離線備份」按鈕（`index.html:600-602`）附近，新增一個全域「⇄ 對調兩天行程」按鈕（這是跨天操作，不適合放在單一 day panel 裡）。點擊後彈出一個簡單 modal（仿照既有 `#confirm-modal` 樣式）：兩個 `<select>`（Day1~Day6）選 Day A / Day B + 確認按鈕。
- 確認後：`POST` 到 `API_URL`，`action: 'swap_days'`；成功後清除 `gas_cache`、呼叫既有 `manualRefresh()` 邏輯重新抓資料渲染，並 `showToast()` 回饋結果。失敗則照現有錯誤處理模式顯示 toast。

### 3. 一次性資料搬遷

- 用一個小腳本（或直接在 Apps Script 編輯器跑）把 `data/itinerary.json` 現有六天的 `dining` 陣列轉成 `seedDiningFromItinerary()` 要吃的格式並執行一次性匯入。這一步是唯一還需要碰電腦/Apps Script 編輯器的步驟，之後對調都只需要在手機上按按鈕。

### 4. `data/itinerary.json` 與 `sw.js`

- `itinerary.json` 本身的 `dining`/`spots` 維持原狀（離線備援用），不用因為這個功能再手動同步——之後對調都走 GAS，不會再像過去那樣需要同時改兩個檔案。
- `index.html`/`sw.js` 改完後記得把 `sw.js` 的 `CACHE` 版本號 +1（沿用既有慣例，如 `3d00c4c`），強制 PWA 端更新快取。

### 已知限制（不在這次範圍內自動處理）

`note` 欄位（例如 Day3 現在的「週五入場，比週末少人」）是針對特定日期星期幾寫的建議文字，對調後若新日期是不同星期，文字會對不上。這是內容問題，不是機制問題——`swap_days` 不會、也無法自動改寫這種自由文字，對調後需要使用者自己看一下 note 內容是否要微調。

## 關鍵檔案

- `google-backend.js` — 新增 dining sheet 相關函式 + `handleSwapDays`
- `index.html` — `mergeGAS()` 擴充、新增對調 modal UI + `swapDays()` JS 函式
- `sw.js` — bump cache 版本

## 驗證方式

1. 在 Apps Script 編輯器執行一次性 dining 搬遷函式，用 `doGet` 確認回傳的 JSON 每天都帶有正確的 `dining` 陣列。
2. 本地 `python -m http.server 8000` 開啟頁面，登入後點擊「⇄ 對調兩天行程」選 Day3/Day5 並確認；檢查：
   - Day3 分頁顯示原 Day5 的景點與美食，Day5 分頁顯示原 Day3 的內容。
   - 日期 (`date`) 跟分頁編號維持原位（Day3 還是 6/26、Day5 還是 6/28）。
   - 重新整理頁面（重新從 GAS 抓資料）後對調結果仍然存在（確認真的寫回 Sheet，不是只改了本地 state）。
3. 若有改到 `js/utils.js` 的共用函式，跑既有測試：`npx mocha tests/utils.test.cjs`（或專案慣用指令）與 `pytest tests/test_weather.py`。
