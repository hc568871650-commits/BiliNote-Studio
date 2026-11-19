from app.db.models.models import Model
from app.db.models.providers import Provider
from app.db.models.video_tasks import VideoTask
from app.db.engine import get_engine, Base
from app.utils.secret_store import encrypt_secret, is_encrypted_secret
from sqlalchemy import inspect, text


def ensure_model_display_name(engine):
    if 'display_name' not in {column['name'] for column in inspect(engine).get_columns('models')}:
        with engine.begin() as connection:
            connection.execute(text('ALTER TABLE models ADD COLUMN display_name VARCHAR'))


def ensure_provider_protocol(engine):
    columns = {column['name'] for column in inspect(engine).get_columns('providers')}
    if 'protocol' not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE providers ADD COLUMN protocol VARCHAR DEFAULT 'openai-chat'"))


def migrate_provider_secrets(engine):
    """Transparently migrate legacy plaintext provider API keys to DPAPI storage."""
    try:
        with engine.begin() as connection:
            rows = connection.execute(text("SELECT id, api_key FROM providers")).fetchall()
            for row in rows:
                pid, raw_key = row[0], row[1]
                if raw_key and not is_encrypted_secret(raw_key):
                    protected = encrypt_secret(raw_key)
                    if protected != raw_key:
                        connection.execute(
                            text("UPDATE providers SET api_key = :api_key WHERE id = :id"),
                            {"api_key": protected, "id": pid},
                        )
    except Exception:
        # Never block database startup on optional key migration.
        pass


def init_db():
    engine = get_engine()

    Base.metadata.create_all(bind=engine)
    ensure_model_display_name(engine)
    ensure_provider_protocol(engine)
    migrate_provider_secrets(engine)
