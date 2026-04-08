"""Alert API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Alert, Worker

router = APIRouter(prefix="/alerts", tags=["alerts"])

# Lower number = higher priority in sort
_TYPE_PRIORITY = {
    "missing_from_tc": 0,
    "quarantined": 1,
    "mdm_unenrolled": 2,
    "pool_mismatch": 3,
}


def _alert_to_dict(a: Alert, worker: Worker | None = None) -> dict[str, Any]:
    return {
        "id": a.id,
        "alert_type": a.alert_type,
        "hostname": a.hostname,
        "detail": a.detail,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "acknowledged": a.acknowledged,
        "active": a.resolved_at is None,
        "worker": {
            "generation": worker.generation if worker else None,
            "worker_pool": worker.worker_pool if worker else None,
            "state": worker.effective_state if worker else None,
        },
    }


@router.get("")
def list_alerts(
    db: Session = Depends(get_db),
    active_only: bool = True,
    alert_type: str | None = None,
) -> dict[str, Any]:
    q = db.query(Alert)
    if active_only:
        q = q.filter(Alert.resolved_at == None)  # noqa: E711
    if alert_type:
        q = q.filter(Alert.alert_type == alert_type)

    priority_order = case(
        {t: p for t, p in _TYPE_PRIORITY.items()},
        value=Alert.alert_type,
        else_=99,
    )
    alerts = q.order_by(priority_order, Alert.created_at.desc()).limit(500).all()

    # Bulk-load workers to avoid N+1
    hostnames = {a.hostname for a in alerts}
    workers = {w.hostname: w for w in db.query(Worker).filter(Worker.hostname.in_(hostnames)).all()}

    return {"total": len(alerts), "alerts": [_alert_to_dict(a, workers.get(a.hostname)) for a in alerts]}


@router.post("/{alert_id}/resolve")
def resolve_alert(alert_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    alert = db.get(Alert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.resolved_at = datetime.utcnow()
    alert.acknowledged = True
    db.commit()
    return _alert_to_dict(alert)


@router.post("/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    alert = db.get(Alert, alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.acknowledged = True
    db.commit()
    return _alert_to_dict(alert)
