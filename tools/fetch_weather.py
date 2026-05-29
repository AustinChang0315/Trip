"""
Skill 1: 跨區即時天氣同步引擎
- 資料來源: Open-Meteo 免費 API（無需 API Key）
- 去重優化: 每個不重複地區只發送一次請求
- 寫回: 氣溫與降雨量寫回 itinerary.json，並產生穿搭提示
"""

import json
import urllib.request
import urllib.parse
from pathlib import Path
from datetime import datetime, timezone, timedelta

ITINERARY_PATH = Path(__file__).parent.parent / "data" / "itinerary.json"
JST = timezone(timedelta(hours=9))
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def fetch_weather_for_region(lat: float, lon: float) -> dict:
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,precipitation,weathercode",
        "timezone": "Asia/Tokyo",
    })
    url = f"{OPEN_METEO_URL}?{params}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read())


def weather_alerts(temp: float, precipitation: float) -> list[str]:
    alerts = []
    if precipitation > 0:
        alerts.append("☔ 今日有降雨，記得帶傘")
    if temp < 15:
        alerts.append("🧥 氣溫偏低，建議穿防風外套")
    if temp > 28:
        alerts.append("🌞 氣溫較高，注意防曬補水")
    return alerts


def sync():
    with open(ITINERARY_PATH, encoding="utf-8") as f:
        data = json.load(f)

    today_str = datetime.now(JST).strftime("%Y-%m-%d")
    today_day = next(
        (d for d in data["itinerary"] if d["date"] == today_str), None
    )

    if not today_day or not today_day.get("spots"):
        print(f"[fetch_weather] 今日 ({today_str}) 無行程，略過。")
        return

    # 去重：以 region_name 為 key，只保留第一個出現的座標
    regions: dict[str, dict] = {}
    for spot in today_day["spots"]:
        name = spot["region_name"]
        if name not in regions:
            regions[name] = {
                "latitude": spot["latitude"],
                "longitude": spot["longitude"],
            }

    print(f"[fetch_weather] 今日地區：{list(regions.keys())}，共 {len(regions)} 次 API 請求\n")

    weather_cache: dict[str, dict] = {}
    for region_name, coords in regions.items():
        print(f"  → 正在查詢：{region_name} ({coords['latitude']}, {coords['longitude']})")
        raw = fetch_weather_for_region(coords["latitude"], coords["longitude"])
        current = raw["current"]
        temp = current["temperature_2m"]
        precipitation = current["precipitation"]
        alerts = weather_alerts(temp, precipitation)

        weather_cache[region_name] = {
            "temperature_c": temp,
            "precipitation_mm": precipitation,
            "alerts": alerts,
            "fetched_at": datetime.now(JST).isoformat(),
        }

        print(f"     氣溫: {temp}°C | 降雨: {precipitation}mm")
        for alert in alerts:
            print(f"     {alert}")

    # 將天氣資料寫回每個景點
    for spot in today_day["spots"]:
        spot["weather"] = weather_cache.get(spot["region_name"], {})

    with open(ITINERARY_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n[fetch_weather] 天氣資料已寫回 {ITINERARY_PATH}")


if __name__ == "__main__":
    sync()
