from fastapi import FastAPI

from .routers import note, provider, model, config, chat, note_folders, note_library
from .edition import is_quick



def create_app(lifespan) -> FastAPI:
    app = FastAPI(title="BiliNote Studio",lifespan=lifespan)
    app.include_router(note.router, prefix="/api")
    app.include_router(note_folders.router, prefix="/api")
    app.include_router(note_library.router, prefix="/api")
    app.include_router(provider.router, prefix="/api")
    app.include_router(model.router,prefix="/api")
    app.include_router(config.router,  prefix="/api")
    app.include_router(chat.router, prefix="/api")
    if not is_quick():
        from .routers import organizer
        app.include_router(organizer.router, prefix="/api")

    return app
