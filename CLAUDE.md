# 東京質感自由行 Web App — 專案規格書

## 專案核心宗旨

本專案為一個部署於 GitHub Pages 的靜態 PWA 行程管理應用，專為手機使用優化。核心原則：

- **非商業化防禦**：全面屏蔽連鎖藥妝店、大型百貨公司（LUMIN、PARCO 等）、免稅店及複製感嚴重的連鎖商圈。
- **高靈魂街區優先**：主攻具備在地日式生活氣息、職人工藝與文化底蘊的特色區域（代官山、藏前、下北澤、自由之丘、鎌倉、箱根）。
- **極致行動體驗**：唯讀（Read-Only）高質感日式極簡前端，透過手機 PWA（加入主畫面）提供流暢查詢與記帳體驗。

---

## 目錄結構

```
tokyo-trip-app/
├── CLAUDE.md                # 本規格說明書
├── .clauderc                # Sub-Agent 角色與 Guardrails 定義
├── index.html               # 手機版 RWD 前端（含密碼驗證）
├── manifest.json            # PWA 設定（使其可加入手機主畫面）
├── data/
│   ├── itinerary.json       # 核心行程資料庫
│   └── expenses_summary.json# 記帳統計資料庫（由 sync_expenses.py 生成）
└── tools/
    ├── fetch_weather.py     # [Skill 1] 跨區即時天氣同步腳本
    └── sync_expenses.py     # [Skill 2] Google 試算表記帳對帳腳本
```

---

## Sub-Agent 配置（.clauderc）

本專案啟用專屬子代理 `itinerary_architect`（東京交通與行程架構師）。

### 角色定義（Role）

精通東急東橫線、小田急私鐵、江之電與東京地鐵網絡的交通路由演算法專家，同時具備挑選非商業化日式美學景點的最高品味。

### 邊界防禦（Guardrails）

| 防禦規則 | 觸發條件 | 動作 |
|---|---|---|
| 反商業購物審查 | 輸入包含連鎖藥妝、大型百貨、免稅店等純逛街網段 | 觸發 `AssertionError`，拒絕寫入 |
| 交通路由反繞路檢查 | 同天出現「新宿 → 淺草 → 澀谷」等大幅度繞路排程 | 噴出 `Warning`，強制重新配置 |
| Schema 鎖定 | 所有輸出 | 必須寫入 `data/itinerary.json`，不允許多餘聊天文字 |

---

## 技能庫（Skills / Tools）

### Skill 1：`tools/fetch_weather.py`（地區天氣同步引擎）

- **資料來源**：Open-Meteo 免費 API（無需 API Key）
- **去重優化（Anti-Throttle）**：掃描 `itinerary.json` 當日所有景點的 `latitude` / `longitude`，過濾出不重複的地區後，每地區只發送一次請求。
- **寫回邏輯**：將即時氣溫與降雨量寫回 JSON，並在前端觸發穿搭提示：
  - 降雨量 > 0 → 自動提示帶傘
  - 郊區氣溫 < 15°C → 自動提示防風外套

### Skill 2：`tools/sync_expenses.py`（不落地記帳對帳引擎）

- **前端串接**：`index.html` 的記帳表單透過 Webhook / POST 直連 Google Forms。
- **對帳流程**：透過 Google Sheets API 定期撈回日圓花費，統計總支出與分類比例，渲染至 `data/expenses_summary.json`，供前端產出圖表。

---

## 前端規格（index.html）

### 功能清單

| 功能 | 實作方式 |
|---|---|
| 驗證防禦鎖 | 網頁載入強制彈出密碼框，預設密碼 `0315`；驗證成功後寫入 `localStorage`，3天免重複驗證 |
| 智慧頁籤切換 | JavaScript 偵測當前日本時間（JST），打開網頁自動定位至當天行程時間軸 |
| 一鍵喚醒導航 | 連結使用 `origin=My+Location&travelmode=transit`，點擊自動喚醒 Google Maps App，以使用者當下 GPS 為起點導航 |
| 離線防禦機制 | 優化 `@media print` 樣式 + 內建「下載離線備份」按鈕，可輸出完整 PDF / 長圖 |

### 設計風格

- 日式極簡（Wabi-Sabi 美學），低飽和色調，大量留白
- RWD，手機優先，不需 Desktop 版
- 唯讀介面，老婆只能查看行程，不能直接編輯 JSON

---

## 核心資料結構

### `data/itinerary.json`

```json
{
  "itinerary": [
    {
      "day": 1,
      "date": "2026-04-16",
      "day_title": "職人工藝與運河散策",
      "spots": [
        {
          "time": "13:00",
          "spot_name": "藏前 散策 (Kakimori / Dandelion)",
          "region_name": "東京市區",
          "latitude": 35.7013,
          "longitude": 139.7909,
          "description": "老舊工廠與倉庫改建的文青聚落，體驗客製化手工文具與職人巧克力工坊。",
          "transport": {
            "method": "從機場/飯店搭乘都營大江戶線至藏前站",
            "duration": "約 30 分鐘",
            "google_maps_url": "https://www.google.com/maps/dir/?api=1&origin=My+Location&destination=蔵前駅&travelmode=transit"
          }
        }
      ]
    }
  ]
}
```

**欄位規範（Schema 鎖定）：**

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `day` | integer | ✅ | 行程第幾天 |
| `date` | string (YYYY-MM-DD) | ✅ | 日期 |
| `day_title` | string | ✅ | 當日主題標題 |
| `spots[].time` | string (HH:MM) | ✅ | 抵達時間 |
| `spots[].spot_name` | string | ✅ | 景點名稱 |
| `spots[].region_name` | string | ✅ | 地區名（用於天氣去重） |
| `spots[].latitude` | float | ✅ | 緯度（天氣 API 必需） |
| `spots[].longitude` | float | ✅ | 經度（天氣 API 必需） |
| `spots[].description` | string | ✅ | 景點描述 |
| `spots[].transport` | object | ✅ | 交通資訊 |
| `spots[].transport.google_maps_url` | string | ✅ | 含 `origin=My+Location&travelmode=transit` |

### `data/expenses_summary.json`

```json
{
  "last_synced": "2026-04-17T10:30:00+09:00",
  "total_jpy": 45800,
  "total_twd": 9847,
  "categories": [
    { "name": "餐飲", "jpy": 18500, "percentage": 40 },
    { "name": "交通", "jpy": 12300, "percentage": 27 },
    { "name": "體驗", "jpy": 9000, "percentage": 20 },
    { "name": "其他", "jpy": 6000, "percentage": 13 }
  ],
  "daily_breakdown": []
}
```

---

## 旅行基本資訊

- **出發日期**：2026-06-24（松山 09:00 → 羽田 13:10）
- **返程日期**：2026-06-29（羽田 14:30 → 松山 16:55）
- **天數**：6 天 5 夜
- **飯店**：三井花園酒店五反田（品川區，JR 五反田站步行圈）
- **主要路線**：五反田周邊 → 下町 → 迪士尼海洋 → 川越 → 湘南 → 麻布台
- **鐵路通票**：Suica / PASMO IC 卡（通用）+ 江の島・鎌倉フリーパス（Day 5）
- **季節注意**：梅雨季，每日攜帶折傘

---

## 開發啟動指令

所有檔案建立完成後，執行以下指令啟動：

```bash
# 1. 天氣資料同步（需先填入 itinerary.json）
python tools/fetch_weather.py

# 2. 記帳對帳同步（需設定 Google API 憑證）
python tools/sync_expenses.py

# 3. 本地預覽（任一 HTTP Server）
python -m http.server 8000
```

部署：將整個資料夾推送至 GitHub，在 Repository Settings 開啟 GitHub Pages，指向 `main` 分支根目錄。

---

## Claude Code 啟動指令

專案就緒後，對 Claude Code 下達：

> 請讀取 `CLAUDE.md` 與 `data/itinerary.json`，根據裡面的系統架構與邏輯防禦，幫我把 `index.html`、`manifest.json`、以及 `tools/` 資料夾底下的 Python 天氣與記帳腳本程式碼完整寫出來。
