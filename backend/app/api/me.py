"""Per-user preferences, scoped to the IAP-authenticated identity."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import current_user
from ..database import get_db
from ..models import UserPref

router = APIRouter()

MAX_MONITORED = 8


class MonitoredPools(BaseModel):
    pools: list[str]


class TrackedPoolsUpdate(BaseModel):
    section: str
    pools: list[str]


class WeatherPref(BaseModel):
    enabled: bool = False
    label: str = ""
    lat: float | None = None
    lon: float | None = None
    unit: str = "fahrenheit"


_DEFAULT_WEATHER: dict = {"enabled": False, "label": "", "lat": None, "lon": None, "unit": "fahrenheit"}


def _pools(pref: UserPref | None) -> list[str]:
    if not pref or not pref.monitored_pools:
        return []
    try:
        value = json.loads(pref.monitored_pools)
        return [p for p in value if isinstance(p, str)] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _weather(pref: UserPref | None) -> dict:
    if not pref or not pref.weather:
        return dict(_DEFAULT_WEATHER)
    try:
        value = json.loads(pref.weather)
    except (json.JSONDecodeError, TypeError):
        return dict(_DEFAULT_WEATHER)
    if not isinstance(value, dict):
        return dict(_DEFAULT_WEATHER)
    return {**_DEFAULT_WEATHER, **value}


def _tracked(pref: UserPref | None) -> dict[str, list[str]]:
    if not pref or not pref.tracked_pools:
        return {}
    try:
        value = json.loads(pref.tracked_pools)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        str(section): [p for p in pools if isinstance(p, str)]
        for section, pools in value.items()
        if isinstance(pools, list)
    }


@router.get("/me/monitored-pools")
def get_monitored_pools(user: str = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return {"email": user, "pools": _pools(db.get(UserPref, user))}


@router.put("/me/monitored-pools")
def set_monitored_pools(
    body: MonitoredPools,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    pools = [p for p in body.pools if isinstance(p, str)][:MAX_MONITORED]
    pref = db.get(UserPref, user)
    if pref is None:
        pref = UserPref(email=user)
        db.add(pref)
    pref.monitored_pools = json.dumps(pools)
    db.commit()
    return {"email": user, "pools": pools}


@router.get("/me/tracked-pools")
def get_tracked_pools(user: str = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return {"email": user, "tracked": _tracked(db.get(UserPref, user))}


@router.put("/me/tracked-pools")
def set_tracked_pools(
    body: TrackedPoolsUpdate,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    pref = db.get(UserPref, user)
    if pref is None:
        pref = UserPref(email=user)
        db.add(pref)
    tracked = _tracked(pref)
    tracked[body.section] = [p for p in body.pools if isinstance(p, str)][:MAX_MONITORED]
    pref.tracked_pools = json.dumps(tracked)
    db.commit()
    return {"email": user, "tracked": tracked}


@router.get("/me/weather")
def get_weather_pref(user: str = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return {"email": user, "weather": _weather(db.get(UserPref, user))}


@router.put("/me/weather")
def set_weather_pref(
    body: WeatherPref,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    unit = "celsius" if body.unit.lower().startswith("c") else "fahrenheit"
    weather = {
        "enabled": bool(body.enabled),
        "label": body.label[:120],
        "lat": body.lat if body.lat is None else max(-90.0, min(90.0, body.lat)),
        "lon": body.lon if body.lon is None else max(-180.0, min(180.0, body.lon)),
        "unit": unit,
    }
    pref = db.get(UserPref, user)
    if pref is None:
        pref = UserPref(email=user)
        db.add(pref)
    pref.weather = json.dumps(weather)
    db.commit()
    return {"email": user, "weather": weather}
