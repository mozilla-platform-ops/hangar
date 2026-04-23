"""API routes for ronin_puppet PR tracking."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import RoninPR

router = APIRouter(prefix="/prs", tags=["prs"])


def _pr_to_dict(pr: RoninPR) -> dict[str, Any]:
    return {
        "number": pr.id,
        "title": pr.title,
        "url": pr.url,
        "state": pr.state,
        "author": pr.author,
        "labels": json.loads(pr.labels) if pr.labels else [],
        "created_at": pr.pr_created_at.isoformat() if pr.pr_created_at else None,
        "updated_at": pr.pr_updated_at.isoformat() if pr.pr_updated_at else None,
        "upvotes": pr.upvotes,
        "downvotes": pr.downvotes,
        "last_synced": pr.last_synced.isoformat() if pr.last_synced else None,
    }


@router.get("/ronin")
def list_ronin_prs(db: Session = Depends(get_db)) -> dict[str, Any]:
    prs = db.query(RoninPR).order_by(RoninPR.pr_updated_at.desc()).all()
    return {"total": len(prs), "prs": [_pr_to_dict(p) for p in prs]}


@router.post("/ronin/{pr_number}/upvote")
def upvote_pr(pr_number: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    pr = db.get(RoninPR, pr_number)
    if not pr:
        raise HTTPException(status_code=404, detail="PR not found")
    pr.upvotes = (pr.upvotes or 0) + 1
    db.commit()
    return _pr_to_dict(pr)


@router.post("/ronin/{pr_number}/downvote")
def downvote_pr(pr_number: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    pr = db.get(RoninPR, pr_number)
    if not pr:
        raise HTTPException(status_code=404, detail="PR not found")
    pr.downvotes = (pr.downvotes or 0) + 1
    db.commit()
    return _pr_to_dict(pr)
