"""
Skill 2: 不落地記帳對帳引擎（更新版）
- 從 Google Sheets 撈回前端寫入的記帳資料
- 分類直接讀「分類」欄，無需關鍵字比對
- 寫入 data/expenses_summary.json，供前端圖表顯示

環境變數設定：
  GOOGLE_SHEET_ID      試算表 ID（URL 中段的長字串）
  GOOGLE_CREDENTIALS   Service Account JSON 憑證路徑（預設: credentials.json）
  JPY_TO_TWD_RATE      匯率（預設: 0.215）

依賴安裝：
  pip install gspread google-auth

【Google Service Account 取得方式】
  1. Google Cloud Console → 建立專案
  2. 啟用 Google Sheets API
  3. IAM 與管理 → 服務帳戶 → 建立 → 下載 JSON 金鑰
  4. 回到你的 Google 試算表 → 共用 → 貼上服務帳戶 Email（以編輯者身分）
"""

import json
import os
from pathlib import Path
from datetime import datetime, timezone, timedelta

EXPENSES_PATH = Path(__file__).parent.parent / "data" / "expenses_summary.json"
JST = timezone(timedelta(hours=9))

SHEET_ID       = os.environ.get("GOOGLE_SHEET_ID", "")
CREDS_FILE     = os.environ.get("GOOGLE_CREDENTIALS", "credentials.json")
JPY_TO_TWD     = float(os.environ.get("JPY_TO_TWD_RATE", "0.215"))
VALID_CATS     = {"餐飲", "交通", "體驗", "購物", "購物-寶寶", "購物-ㄚ鼻", "其他"}


def sync():
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        print("[sync_expenses] 請先安裝依賴：pip install gspread google-auth")
        return

    if not SHEET_ID:
        print("[sync_expenses] 請設定環境變數 GOOGLE_SHEET_ID")
        return

    if not Path(CREDS_FILE).exists():
        print(f"[sync_expenses] 找不到憑證檔案：{CREDS_FILE}")
        return

    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    creds  = Credentials.from_service_account_file(CREDS_FILE, scopes=scopes)
    client = gspread.authorize(creds)

    print(f"[sync_expenses] 連接試算表 {SHEET_ID[:20]}...")
    sheet   = client.open_by_key(SHEET_ID).sheet1
    records = sheet.get_all_records()
    print(f"[sync_expenses] 取得 {len(records)} 筆記錄")

    total_jpy = 0
    cat_totals = {c: 0 for c in ["餐飲", "交通", "體驗", "購物", "購物-寶寶", "購物-ㄚ鼻", "其他"]}
    daily: dict[str, int] = {}

    for r in records:
        try:
            amount = int(str(r.get("金額(JPY)", 0) or 0).replace(",", ""))
        except ValueError:
            continue

        cat  = str(r.get("分類", "其他")).strip()
        date = str(r.get("日期", "")).strip()

        if cat not in VALID_CATS:
            cat = "其他"

        total_jpy += amount
        cat_totals[cat] += amount

        if date:
            daily[date] = daily.get(date, 0) + amount

    categories = [
        {
            "name": name,
            "jpy": jpy,
            "percentage": round(jpy / total_jpy * 100) if total_jpy > 0 else 0
        }
        for name, jpy in cat_totals.items()
    ]

    daily_breakdown = [
        {"date": d, "jpy": jpy, "twd": int(jpy * JPY_TO_TWD)}
        for d, jpy in sorted(daily.items())
    ]

    summary = {
        "last_synced": datetime.now(JST).isoformat(),
        "total_jpy": total_jpy,
        "total_twd": int(total_jpy * JPY_TO_TWD),
        "exchange_rate_jpy_to_twd": JPY_TO_TWD,
        "categories": categories,
        "daily_breakdown": daily_breakdown,
    }

    with open(EXPENSES_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"\n  總花費：JPY {total_jpy:,} ≈ TWD {int(total_jpy * JPY_TO_TWD):,}")
    for c in categories:
        if c["jpy"] > 0:
            print(f"  {c['name']:4s}：JPY {c['jpy']:>8,}（{c['percentage']}%）")
    print(f"\n[sync_expenses] 已寫入 {EXPENSES_PATH}")


if __name__ == "__main__":
    sync()
