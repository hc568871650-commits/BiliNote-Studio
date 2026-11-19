from app.db.engine import get_db
from app.db.models.models import Model
from app.db.models.providers import Provider


def get_model_by_provider_and_name(provider_id: int, model_name: str):
    db = next(get_db())
    try:
        model = db.query(Model).filter_by(provider_id=provider_id, model_name=model_name).first()
        if model:
            return {
                "id": model.id,
                "provider_id": model.provider_id,
                "model_name": model.model_name,
                "display_name": model.display_name,
                "created_at": model.created_at,
            }
        return None
    finally:
        db.close()


def insert_model(provider_id: int, model_name: str, display_name: str | None = None):
    db = next(get_db())
    try:
        model = Model(provider_id=provider_id, model_name=model_name, display_name=display_name)
        db.add(model)
        db.commit()
        db.refresh(model)
        return {
            "id": model.id,
            "provider_id": model.provider_id,
            "model_name": model.model_name,
            "display_name": model.display_name,
            "created_at": model.created_at,
        }
    finally:
        db.close()


def get_models_by_provider(provider_id: int):
    db = next(get_db())
    try:
        models = db.query(Model).filter_by(provider_id=provider_id).all()
        return [{"id": m.id, "provider_id": m.provider_id, "model_name": m.model_name,
                 "display_name": m.display_name} for m in models]
    finally:
        db.close()


def delete_model(model_id: int):
    db = next(get_db())
    try:
        model = db.query(Model).filter_by(id=model_id).first()
        if model:
            db.delete(model)
            db.commit()
    finally:
        db.close()


def get_all_models():
    db = next(get_db())
    try:
        # 只查询启用状态供应商的模型
        models = db.query(Model).join(Provider, Model.provider_id == Provider.id).filter(Provider.enabled == 1).all()
        return [
            {"id": m.id, "provider_id": m.provider_id, "model_name": m.model_name,
             "display_name": m.display_name}
            for m in models
        ]
    finally:
        db.close()


def update_model_display_name(model_id: int, display_name: str | None):
    db = next(get_db())
    try:
        model = db.query(Model).filter_by(id=model_id).first()
        if not model:
            return None
        model.display_name = display_name.strip() or None if display_name is not None else None
        db.commit()
        db.refresh(model)
        return {"id": model.id, "provider_id": model.provider_id, "model_name": model.model_name,
                "display_name": model.display_name}
    finally:
        db.close()


def update_model(model_id: int, *, model_name: str | None = None, display_name: str | None = None, update_display_name: bool = False):
    db = next(get_db())
    try:
        model = db.query(Model).filter_by(id=model_id).first()
        if not model:
            return None
        if model_name is not None:
            cleaned_name = model_name.strip()
            if not cleaned_name:
                raise ValueError("模型调用名不能为空")
            conflict = (
                db.query(Model)
                .filter(Model.provider_id == model.provider_id, Model.model_name == cleaned_name, Model.id != model_id)
                .first()
            )
            if conflict:
                raise ValueError(f"同供应商下已存在模型 {cleaned_name}")
            model.model_name = cleaned_name
        if update_display_name:
            model.display_name = display_name.strip() or None if display_name is not None else None
        db.commit()
        db.refresh(model)
        return {
            "id": model.id,
            "provider_id": model.provider_id,
            "model_name": model.model_name,
            "display_name": model.display_name,
        }
    finally:
        db.close()


def insert_models_batch(provider_id: str, items: list[dict]):
    db = next(get_db())
    try:
        existing_names = {
            m.model_name for m in db.query(Model).filter_by(provider_id=provider_id).all()
        }
        inserted = []
        skipped = []
        for item in items:
            raw_name = str(item.get("model_name") or "").strip()
            if not raw_name:
                continue
            if raw_name in existing_names:
                skipped.append(raw_name)
                continue
            raw_display = item.get("display_name")
            display = str(raw_display).strip() or None if raw_display is not None else None
            model = Model(provider_id=provider_id, model_name=raw_name, display_name=display)
            db.add(model)
            db.flush()
            existing_names.add(raw_name)
            inserted.append({
                "id": model.id,
                "provider_id": model.provider_id,
                "model_name": model.model_name,
                "display_name": model.display_name,
            })
        db.commit()
        return {"inserted": inserted, "skipped": skipped}
    finally:
        db.close()


def delete_models_batch(model_ids: list[int]) -> int:
    if not model_ids:
        return 0
    db = next(get_db())
    try:
        count = db.query(Model).filter(Model.id.in_(model_ids)).delete(synchronize_session=False)
        db.commit()
        return int(count or 0)
    finally:
        db.close()
