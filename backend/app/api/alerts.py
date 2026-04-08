"""Alert API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Alert

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _alert_to_dict(a: Alert) -> dict[str, Any]:
    return {
        "id": a.id,
        "alert_type": a.alert_type,
        "hostname": a.hostname,
        "detail": a.detail,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "acknowledged": a.acknowledged,
        "active": a.resolved_at is None,
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
    alerts = q.order_by(Alert.created_at.desc()).limit(500).all()
    return {"total": len(alerts), "alerts": [_alert_to_dict(a) for a in alerts]}


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
