"""Audio settings reuse the existing Groq credential row; never expose its key."""
from urllib.parse import urlsplit

MASKED_KEY = "********"
DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1"


def _session():
    from app.db.engine import SessionLocal
    return SessionLocal()


def groq_connection():
    from app.db.models.providers import Provider
    with _session() as db:
        row = db.get(Provider, "groq")
        return {
            "base_url": row.base_url if row else DEFAULT_GROQ_URL,
            "api_key": MASKED_KEY if row and row.api_key else "",
            "enabled": bool(row.enabled) if row else True,
        }


def save_transcriber_settings(manager, *, connection=None, **settings):
    # Updating another engine never writes the hidden Groq connection.
    if connection is not None and settings["transcriber_type"] != "groq":
        raise ValueError("请在选择 Groq 时保存其连接设置")
    if connection is None:
        return manager.update_config(**settings)

    url = connection["base_url"].strip()
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError()
        parsed.port
    except ValueError:
        raise ValueError("请输入有效的 Groq HTTP API 地址，不要包含密钥或查询参数") from None
    key = connection["api_key"].strip()
    if "*" in key and key != MASKED_KEY:
        raise ValueError("请重新输入完整密钥，或保持原掩码不变")

    from app.db.models.providers import Provider
    existed = manager.path.exists()
    previous = manager.path.read_bytes() if existed else None
    with _session() as db:
        row = db.get(Provider, "groq")
        if key == MASKED_KEY and (row is None or not row.api_key):
            raise ValueError("尚未保存 Groq 密钥，请输入完整密钥")
        if row is None:
            row = Provider(id="groq", name="Groq", logo="groq", type="built-in", api_key="", base_url=url, enabled=1)
            db.add(row)
        row.base_url = url
        row.enabled = int(connection["enabled"])
        if key != MASKED_KEY:
            row.api_key = key
        written = False
        try:
            db.flush()
            result = manager.update_config(**settings)
            written = True
            db.commit()
        except Exception:
            db.rollback()
            if written:
                if existed:
                    manager.path.write_bytes(previous)
                else:
                    manager.path.unlink(missing_ok=True)
            raise
    return result
