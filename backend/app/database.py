"""SQLAlchemy database setup."""
from __future__ import annotations

import logging
from collections.abc import Generator

from sqlalchemy import Boolean, DateTime, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ddl_type(col_type) -> str:
    if isinstance(col_type, String) and col_type.length:
        return f"VARCHAR({col_type.length})"
    if isinstance(col_type, (String, Text)):
        return "TEXT"
    if isinstance(col_type, Integer):
        return "INTEGER"
    if isinstance(col_type, Boolean):
        return "BOOLEAN"
    if isinstance(col_type, DateTime):
        return "TIMESTAMP"
    return "TEXT"


def init_db() -> None:
    """Create all tables and add any columns missing from existing tables."""
    from .models import Alert, SyncLog, Worker  # noqa: F401
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {col["name"] for col in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    ddl = _ddl_type(col.type)
                    log.info("Adding missing column %s.%s %s", table.name, col.name, ddl)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN IF NOT EXISTS "{col.name}" {ddl}'))
