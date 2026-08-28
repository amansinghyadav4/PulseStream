import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes_analytics import router as analytics_router
from app.api.routes_api_keys import router as api_keys_router
from app.api.routes_auth import router as auth_router
from app.api.routes_events import router as events_router
from app.api.routes_failures import router as failures_router
from app.api.routes_health import router as health_router
from app.api.routes_metrics import router as metrics_router
from app.api.ws import router as ws_router
from app.core.config import get_settings
from app.core.errors import DomainError, error_body
from app.core.logging import configure_logging
from app.db.base import Base
from app.db.session import engine
from app.middleware.body_size import BodySizeLimitMiddleware
import app.models  # noqa: F401 - registers all ORM tables on Base.metadata
from app.redis.client import close_redis
from app.services.broadcaster import start_broadcaster, stop_broadcaster
from app.core.metrics import HttpRequestMetricsMiddleware
from app.services.kafka_publisher import publisher

logger = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)
    if settings.app_env != "production":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    await publisher.start()
    await start_broadcaster(interval=1.0)
    yield
    await stop_broadcaster()
    await publisher.stop()
    await close_redis()
    await engine.dispose()


app = FastAPI(title="PulseStream", version="0.1.0", lifespan=lifespan)

app.add_middleware(BodySizeLimitMiddleware, max_body_bytes=settings.max_body_bytes)
app.add_middleware(HttpRequestMetricsMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(DomainError)
async def domain_error_handler(_: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, exc.details),
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{k: v for k, v in err.items() if k != "ctx"} for err in exc.errors()]
    return JSONResponse(
        status_code=422,
        content=error_body("validation_error", "request validation failed", errors),
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    message = exc.detail if isinstance(exc.detail, str) else "request failed"
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body("http_error", message),
    )


app.include_router(health_router)
app.include_router(events_router)
app.include_router(auth_router)
app.include_router(api_keys_router)
app.include_router(analytics_router)
app.include_router(failures_router)
app.include_router(ws_router)
app.include_router(metrics_router)
# Canonical versioned prefix per spec §4.1 — keep legacy routes for compatibility
app.include_router(health_router, prefix="/api/v1")
app.include_router(events_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(api_keys_router, prefix="/api/v1")
app.include_router(analytics_router, prefix="/api/v1")
app.include_router(failures_router, prefix="/api/v1")
app.include_router(metrics_router, prefix="/api/v1")
app.include_router(ws_router, prefix="/api/v1")

