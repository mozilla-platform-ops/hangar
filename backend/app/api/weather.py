"""Weather proxy — opt-in dashboard nicety, backed by the keyless Open-Meteo API.

Open-Meteo needs no API key and is CORS-friendly, but we proxy it server-side to
keep a short TTL cache (current conditions move slowly) and to keep the data path
consistent with the rest of the app.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import requests
from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/weather", tags=["weather"])

log = logging.getLogger(__name__)

_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
_USER_AGENT = "relops-dashboard/1.0"
_CURRENT_FIELDS = "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m"
_WEATHER_TTL = 10 * 60   # current conditions — 10 min
_GEOCODE_TTL = 24 * 60 * 60  # city coordinates basically never change

# key -> (monotonic_ts, payload)
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def _cached(key: str, ttl: float) -> Any | None:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (time.monotonic() - hit[0]) < ttl:
            return hit[1]
    return None


def _store(key: str, payload: Any) -> None:
    with _cache_lock:
        if len(_cache) > 500:
            _cache.clear()  # crude bound; this cache is tiny and self-heals
        _cache[key] = (time.monotonic(), payload)


def _get_json(url: str, params: dict[str, Any]) -> Any:
    resp = requests.get(url, params=params, timeout=5, headers={"User-Agent": _USER_AGENT})
    resp.raise_for_status()
    return resp.json()


@router.get("")
def current_weather(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    unit: str = Query("fahrenheit"),
) -> dict[str, Any]:
    """Current conditions for a coordinate, normalized for the dashboard chip."""
    unit = "celsius" if unit.lower().startswith("c") else "fahrenheit"
    wind_unit = "kmh" if unit == "celsius" else "mph"
    # Round the key so nearby coords share a cache entry and don't hammer upstream.
    key = f"w:{round(lat, 2)}:{round(lon, 2)}:{unit}"
    cached = _cached(key, _WEATHER_TTL)
    if cached is not None:
        return cached

    try:
        data = _get_json(_FORECAST_URL, {
            "latitude": lat,
            "longitude": lon,
            "current": _CURRENT_FIELDS,
            "temperature_unit": unit,
            "wind_speed_unit": wind_unit,
        })
    except (requests.RequestException, ValueError) as exc:
        log.warning("Weather fetch failed (%s,%s): %s", lat, lon, exc)
        raise HTTPException(status_code=502, detail="Unable to fetch weather") from exc

    cur = data.get("current", {}) or {}
    result = {
        "temp": cur.get("temperature_2m"),
        "feels_like": cur.get("apparent_temperature"),
        "code": cur.get("weather_code"),
        "is_day": bool(cur.get("is_day", 1)),
        "wind": cur.get("wind_speed_10m"),
        "humidity": cur.get("relative_humidity_2m"),
        "temp_unit": "°C" if unit == "celsius" else "°F",
        "wind_unit": "km/h" if unit == "celsius" else "mph",
        "observed_at": cur.get("time"),
    }
    _store(key, result)
    return result


@router.get("/geocode")
def geocode(q: str = Query(..., min_length=1, max_length=120)) -> dict[str, Any]:
    """Resolve a city name to candidate coordinates for the location picker."""
    key = f"g:{q.strip().lower()}"
    cached = _cached(key, _GEOCODE_TTL)
    if cached is not None:
        return cached

    try:
        data = _get_json(_GEOCODE_URL, {"name": q, "count": 5, "language": "en", "format": "json"})
    except (requests.RequestException, ValueError) as exc:
        log.warning("Geocode failed (%s): %s", q, exc)
        raise HTTPException(status_code=502, detail="Unable to look up location") from exc

    results = [
        {
            "name": r.get("name"),
            "admin1": r.get("admin1"),
            "country": r.get("country"),
            "country_code": r.get("country_code"),
            "lat": r.get("latitude"),
            "lon": r.get("longitude"),
        }
        for r in (data.get("results") or [])
        if r.get("latitude") is not None and r.get("longitude") is not None
    ]
    payload = {"results": results}
    _store(key, payload)
    return payload
