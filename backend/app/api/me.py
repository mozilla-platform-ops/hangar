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


def _pools(pref: UserPref | None) -> list[str]:
    if not pref or not pref.monitored_pools:
        return []
    try:
        value = json.loads(pref.monitored_pools)
        return [p for p in value if isinstance(p, str)] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


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
