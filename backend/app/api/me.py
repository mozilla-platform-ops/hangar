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


def _pools(pref: UserPref | None) -> list[str]:
    if not pref or not pref.monitored_pools:
        return []
    try:
        value = json.loads(pref.monitored_pools)
        return [p for p in value if isinstance(p, str)] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


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
