from app.db.models.models import Model
from app.db.models.providers import Provider
from app.db.models.video_tasks import VideoTask
from app.db.engine import get_engine, Base
from sqlalchemy import inspect, text

def ensure_model_display_name(engine):
    if 'display_name' not in {column['name'] for column in inspect(engine).get_columns('models')}:
        with engine.begin() as connection:
            connection.execute(text('ALTER TABLE models ADD COLUMN display_name VARCHAR'))

def init_db():
    engine = get_engine()

    Base.metadata.create_all(bind=engine)
    ensure_model_display_name(engine)
