"""
執行方式：python -m pytest tests/test_weather.py -v
需要：pip install pytest
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))

from fetch_weather import weather_alerts


def test_rain_alert():
    alerts = weather_alerts(20, 1.0)
    assert any('☔' in a for a in alerts), f"雨天警示缺失：{alerts}"


def test_cold_alert():
    alerts = weather_alerts(12, 0)
    assert any('🧥' in a for a in alerts), f"低溫警示缺失：{alerts}"


def test_heat_alert():
    alerts = weather_alerts(30, 0)
    assert any('🌞' in a for a in alerts), f"高溫警示缺失：{alerts}"


def test_no_alerts_in_normal_weather():
    alerts = weather_alerts(20, 0)
    assert alerts == [], f"正常天氣不應有警示：{alerts}"


def test_rain_and_cold_both_trigger():
    alerts = weather_alerts(10, 2.0)
    texts = ' '.join(alerts)
    assert '☔' in texts and '🧥' in texts, f"應同時觸發雨天與低溫警示：{alerts}"


def test_boundary_precipitation_zero():
    """降雨量 = 0 不觸發雨天警示"""
    alerts = weather_alerts(25, 0)
    assert not any('☔' in a for a in alerts)


def test_boundary_temp_15_no_cold():
    """氣溫 = 15 時不觸發低溫警示（threshold 是 < 15）"""
    alerts = weather_alerts(15, 0)
    assert not any('🧥' in a for a in alerts)
