from fastapi import FastAPI

from .edition import is_quick



def create_app(lifespan) -> FastAPI:
    from .routers import note, provider, model, config, chat, note_folders, note_library
    app = FastAPI(title="BiliNote Studio",lifespan=lifespan)
    from .services.media_io import UploadBodyLimit
    app.add_middleware(UploadBodyLimit)
    from .routers import ingestion
    app.include_router(ingestion.router, prefix="/api")
    app.include_router(note.router, prefix="/api")
    app.include_router(note_folders.router, prefix="/api")
    app.include_router(note_library.router, prefix="/api")
    from .routers import library_search
    app.include_router(library_search.router, prefix="/api")
    app.include_router(provider.router, prefix="/api")
    app.include_router(model.router,prefix="/api")
    app.include_router(config.router,  prefix="/api")
    app.include_router(chat.router, prefix="/api")
    from .routers import model_capabilities
    app.include_router(model_capabilities.router, prefix="/api")
    from .routers import note_refinement
    app.include_router(note_refinement.router, prefix="/api")
    from .routers import generation_comparisons
    app.include_router(generation_comparisons.router, prefix="/api")
    from .routers import jobs
    app.include_router(jobs.router, prefix="/api")
    from .domains.learning.router import router as learning_router
    app.include_router(learning_router, prefix="/api")
    from .domains.media.router import router as media_router
    app.include_router(media_router, prefix="/api")
    from .routers import system_maintenance
    app.include_router(system_maintenance.router, prefix="/api")
    if not is_quick():
        from .routers import organizer
        app.include_router(organizer.router, prefix="/api")

    return app
