"""Admin health API — provider ping, key validity, model auto-tests, notifications, config, export."""

from __future__ import annotations

import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.config import AppConfig
from app.db.models.provider import Provider, ProviderKey, ProviderModel
from app.db.models.model import Model, ModelGroup, ModelGroupMember
from app.db.models.stats import AdminNotification, UsageRecord
from app.db.models.user import User
from app.db.session import get_db
from app.deps import get_current_admin
from app.services.audit import log_action
from app.services.notifications import create_notification
from app.tasks.healthchecks import run_healthchecks

router = APIRouter()


# --- Health checks ---


@router.get("/health/providers")
async def health_check_providers(
    admin: Annotated[User, Depends(get_current_admin)],
):
    return await run_healthchecks()


@router.get("/health/providers/{provider_id}")
async def health_provider_detail(
    provider_id: uuid.UUID,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(Provider).where(Provider.id == provider_id))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    keys = (
        (
            await db.execute(
                select(ProviderKey).where(ProviderKey.provider_id == provider_id).order_by(ProviderKey.created_at)
            )
        )
        .scalars()
        .all()
    )
    models = (
        (
            await db.execute(
                select(ProviderModel)
                .where(ProviderModel.provider_id == provider_id)
                .order_by(ProviderModel.display_name)
            )
        )
        .scalars()
        .all()
    )

    from app.tasks.healthchecks import check_provider_health

    health = await check_provider_health(provider, keys)

    return {
        **health,
        "models": [
            {
                "id": str(m.id),
                "native_name": m.native_name,
                "display_name": m.display_name,
                "is_active": m.is_active,
                "supports_streaming": m.supports_streaming,
                "supports_tools": m.supports_tools,
                "supports_vision": m.supports_vision,
                "max_tokens": m.max_tokens,
            }
            for m in models
        ],
        "keys_detail": [
            {
                "id": str(k.id),
                "key_suffix": k.key_suffix,
                "label": k.label,
                "native_model": k.native_model,
                "status": k.status,
                "error_count": k.error_count,
                "total_requests": k.total_requests,
                "last_error_code": k.last_error_code,
                "last_error_at": k.last_error_at.isoformat() if k.last_error_at else None,
                "blocked_until": k.blocked_until.isoformat() if k.blocked_until else None,
            }
            for k in keys
        ],
    }


@router.post("/health/providers/{provider_id}/test-all-models")
async def test_all_models(
    provider_id: uuid.UUID,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    import time as _time
    from app.services.routing.resolver import ModelResolver
    from app.services.routing.fallback import FallbackExecutor
    from app.services.routing.thresholds import get_thresholds

    result = await db.execute(select(Provider).where(Provider.id == provider_id))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    models = (
        (
            await db.execute(
                select(ProviderModel).where(ProviderModel.provider_id == provider_id, ProviderModel.is_active.is_(True))
            )
        )
        .scalars()
        .all()
    )

    resolver = ModelResolver(db)
    thresholds = await get_thresholds(db)
    results = []
    for m in models:
        canonical = f"{provider.prefix}/{m.native_name.split('/')[-1]}"
        chain = await resolver.resolve(canonical)
        if not chain:
            results.append({"model": canonical, "status": "fail", "error": "not found", "latency_ms": 0})
            continue
        request_body = {
            "model": canonical,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "max_tokens": 10,
        }
        executor = FallbackExecutor(thresholds)
        start = _time.time()
        result = await executor.execute_completion(chain, request_body, stream=False)
        latency_ms = int((_time.time() - start) * 1000)
        results.append(
            {
                "model": canonical,
                "native_name": m.native_name,
                "status": "pass" if result.success else "fail",
                "latency_ms": latency_ms,
                "error": result.error if not result.success else None,
            }
        )
    return {"provider": provider.name, "results": results}


@router.post("/health/providers/{provider_id}/reactivate-keys")
async def reactivate_provider_keys(
    provider_id: uuid.UUID,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from sqlalchemy import update as sa_update

    result = await db.execute(select(Provider).where(Provider.id == provider_id))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    from app.db.models.provider import ProviderKey

    res = await db.execute(
        sa_update(ProviderKey)
        .where(ProviderKey.provider_id == provider_id, ProviderKey.status.in_(["blocked", "cooldown"]))
        .values(
            status="active", blocked_until=None, block_reason=None,
            error_count=0, last_error_code=None, last_error_at=None,
        )
    )
    count = res.rowcount
    await db.commit()

    from app.services.routing.cache_invalidator import on_provider_keys_bulk_changed

    await on_provider_keys_bulk_changed(provider_id)

    return {"status": "ok", "reactivated": count, "provider": provider.name}


@router.post("/health/compare-latency")
async def compare_latency(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
    model: str = Query(..., description="Canonical model name to test across providers"),
):
    import time as _time
    from app.services.routing.resolver import ModelResolver
    from app.services.routing.fallback import FallbackExecutor
    from app.services.routing.thresholds import get_thresholds

    resolver = ModelResolver(db)
    chain = await resolver.resolve(model)
    if not chain:
        raise HTTPException(status_code=404, detail=f"Model '{model}' not found")

    thresholds = await get_thresholds(db)
    results = []
    seen_providers = set()
    for candidate in chain:
        if candidate.provider_id in seen_providers:
            continue
        seen_providers.add(candidate.provider_id)
        request_body = {
            "model": candidate.canonical_name,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "max_tokens": 10,
        }
        single_chain = [candidate]
        executor = FallbackExecutor(thresholds)
        start = _time.time()
        result = await executor.execute_completion(single_chain, request_body, stream=False)
        latency_ms = int((_time.time() - start) * 1000)
        results.append(
            {
                "provider": candidate.provider_prefix,
                "canonical_name": candidate.canonical_name,
                "status": "pass" if result.success else "fail",
                "latency_ms": latency_ms,
                "error": result.error if not result.success else None,
            }
        )
    results.sort(key=lambda r: r["latency_ms"] if r["latency_ms"] > 0 else 999999)
    return {"model": model, "results": results}


# --- Model auto-tests ---


class ModelTestRequest(BaseModel):
    model: str
    prompt: str = "Say hello in one word."
    max_tokens: int = 100


def _extract_response_content(response) -> tuple[str | None, dict | None]:
    if response is None:
        return None, None
    try:
        if isinstance(response, dict):
            choices = response.get("choices", [])
            if choices:
                msg = choices[0].get("message", {})
                content = msg.get("content")
                usage = response.get("usage")
                return content, usage
    except Exception:
        pass
    return None, None


@router.post("/health/model-test")
async def model_test(
    req: ModelTestRequest,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from app.services.routing.resolver import ModelResolver
    from app.services.routing.fallback import FallbackExecutor
    from app.services.routing.thresholds import get_thresholds

    resolver = ModelResolver(db)
    chain = await resolver.resolve(req.model)
    if not chain:
        raise HTTPException(status_code=404, detail=f"Model '{req.model}' not found")

    request_body = {
        "model": req.model,
        "messages": [{"role": "user", "content": req.prompt}],
        "max_tokens": req.max_tokens,
    }
    thresholds = await get_thresholds(db)
    executor = FallbackExecutor(thresholds)

    start = time.time()
    result = await executor.execute_completion(chain, request_body, stream=False)
    latency_ms = int((time.time() - start) * 1000)

    content, usage = _extract_response_content(result.response) if result.success else (None, None)

    return {
        "model": req.model,
        "status": "pass" if result.success else "fail",
        "latency_ms": latency_ms,
        "error": result.error if not result.success else None,
        "content": content,
        "usage": usage,
        "attempts": result.tracker.to_list() if result.tracker else [],
    }


@router.post("/health/providers/{provider_id}/models/{model_id}/test")
async def test_provider_model(
    provider_id: uuid.UUID,
    model_id: uuid.UUID,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
    prompt: str = "Say hello in one word.",
    max_tokens: int = 100,
):
    import time as _time
    from app.services.routing.resolver import ModelResolver, Candidate
    from app.services.routing.fallback import FallbackExecutor
    from app.services.routing.thresholds import get_thresholds

    result = await db.execute(select(Provider).where(Provider.id == provider_id))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    pm_result = await db.execute(select(ProviderModel).where(ProviderModel.id == model_id))
    pmodel = pm_result.scalar_one_or_none()
    if not pmodel:
        raise HTTPException(status_code=404, detail="Model not found")

    canonical = f"{provider.prefix}/{pmodel.native_name.split('/')[-1]}"

    resolver = ModelResolver(db)
    chain = await resolver.resolve(canonical)
    if not chain:
        raise HTTPException(status_code=404, detail=f"Model '{canonical}' not found")

    single_chain = [c for c in chain if c.provider_id == provider_id]
    if not single_chain:
        single_chain = chain

    request_body = {
        "model": canonical,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }
    thresholds = await get_thresholds(db)
    executor = FallbackExecutor(thresholds)

    start = _time.time()
    result = await executor.execute_completion(single_chain, request_body, stream=False)
    latency_ms = int((_time.time() - start) * 1000)

    content, usage = _extract_response_content(result.response) if result.success else (None, None)

    return {
        "model": canonical,
        "native_name": pmodel.native_name,
        "display_name": pmodel.display_name,
        "provider": provider.name,
        "status": "pass" if result.success else "fail",
        "latency_ms": latency_ms,
        "error": result.error if not result.success else None,
        "content": content,
        "usage": usage,
        "attempts": result.tracker.to_list() if result.tracker else [],
    }


# --- Notifications ---


class NotificationMarkRead(BaseModel):
    is_read: bool = True


@router.get("/notifications")
async def list_notifications(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200),
    unread_only: bool = Query(False),
):
    query = select(AdminNotification).order_by(desc(AdminNotification.created_at)).limit(limit)
    if unread_only:
        query = query.where(AdminNotification.is_read.is_(False))
    result = await db.execute(query)
    notifs = result.scalars().all()
    return [
        {
            "id": str(n.id),
            "type": n.type,
            "severity": n.severity,
            "message": n.message,
            "data": n.data,
            "is_read": n.is_read,
            "created_at": str(n.created_at),
        }
        for n in notifs
    ]


@router.put("/notifications/{notif_id}")
async def mark_notification(
    notif_id: uuid.UUID,
    req: NotificationMarkRead,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AdminNotification).where(AdminNotification.id == notif_id))
    notif = result.scalar_one_or_none()
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.is_read = req.is_read
    await db.commit()
    return {"status": "ok"}


@router.post("/notifications/mark-all-read")
async def mark_all_notifications_read(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(AdminNotification).where(AdminNotification.is_read.is_(False))
    )
    notifs = result.scalars().all()
    for n in notifs:
        n.is_read = True
    await db.commit()
    return {"status": "ok", "marked": len(notifs)}


# --- Config / Settings ---


class ConfigUpdate(BaseModel):
    value: dict


@router.get("/config")
async def list_config(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).order_by(AppConfig.key))
    return [{"key": c.key, "value": c.value, "updated_at": str(c.updated_at)} for c in result.scalars().all()]


# --- Feature flag toggles (global chat, launcher download) ---
# Registered BEFORE the generic PUT /config/{key} so they take precedence over
# the catch-all route (Starlette matches in registration order).


class FeatureFlagUpdate(BaseModel):
    enabled: bool


@router.get("/config/global-chat")
async def get_global_chat_flag(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "global_chat"))
    row = result.scalar_one_or_none()
    enabled = bool(row.value.get("enabled", True)) if row else True
    return {"enabled": enabled}


@router.put("/config/global-chat")
async def set_global_chat_flag(
    req: FeatureFlagUpdate,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from app.core.permissions import require_admin
    require_admin(admin.role)
    result = await db.execute(select(AppConfig).where(AppConfig.key == "global_chat"))
    row = result.scalar_one_or_none()
    if row:
        row.value = {"enabled": req.enabled}
    else:
        db.add(AppConfig(key="global_chat", value={"enabled": req.enabled}))
    await log_action(db, admin.id, "config_update", "config", details={"key": "global_chat", "enabled": req.enabled})
    await db.commit()
    from app.services.config.feature_flags import invalidate
    await invalidate("global_chat")
    return {"status": "ok", "enabled": req.enabled}


@router.get("/config/launcher")
async def get_launcher_flag(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "launcher_download_open"))
    row = result.scalar_one_or_none()
    enabled = bool(row.value.get("enabled", False)) if row else False
    return {"enabled": enabled}


@router.put("/config/launcher")
async def set_launcher_flag(
    req: FeatureFlagUpdate,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from app.core.permissions import require_admin
    require_admin(admin.role)
    result = await db.execute(select(AppConfig).where(AppConfig.key == "launcher_download_open"))
    row = result.scalar_one_or_none()
    if row:
        row.value = {"enabled": req.enabled}
    else:
        db.add(AppConfig(key="launcher_download_open", value={"enabled": req.enabled}))
    await log_action(db, admin.id, "config_update", "config", details={"key": "launcher_download_open", "enabled": req.enabled})
    await db.commit()
    from app.services.config.feature_flags import invalidate
    await invalidate("launcher_download_open")
    return {"status": "ok", "enabled": req.enabled}


@router.get("/config/response-cache")
async def get_response_cache_flag(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "response_cache"))
    row = result.scalar_one_or_none()
    enabled = bool(row.value.get("enabled", True)) if row else True
    return {"enabled": enabled}


@router.put("/config/response-cache")
async def set_response_cache_flag(
    req: FeatureFlagUpdate,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from app.core.permissions import require_admin
    require_admin(admin.role)
    result = await db.execute(select(AppConfig).where(AppConfig.key == "response_cache"))
    row = result.scalar_one_or_none()
    if row:
        row.value = {"enabled": req.enabled}
    else:
        db.add(AppConfig(key="response_cache", value={"enabled": req.enabled}))
    await log_action(db, admin.id, "config_update", "config", details={"key": "response_cache", "enabled": req.enabled})
    await db.commit()
    from app.services.config.feature_flags import invalidate
    await invalidate("response_cache")
    return {"status": "ok", "enabled": req.enabled}


@router.put("/config/{key}")
async def update_config(
    key: str,
    req: ConfigUpdate,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == key))
    cfg = result.scalar_one_or_none()
    if cfg:
        cfg.value = req.value
    else:
        cfg = AppConfig(key=key, value=req.value)
        db.add(cfg)
    await log_action(db, admin.id, "config_update", "config", details={"key": key})
    await db.commit()
    if key == "thresholds":
        from app.services.routing.cache_invalidator import on_thresholds_changed

        await on_thresholds_changed()
    return {"status": "ok", "key": key, "value": req.value}


# --- Audit toggle ---


@router.get("/audit/status")
async def audit_status(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "audit_logging_enabled"))
    cfg = result.scalar_one_or_none()
    enabled = cfg.value.get("enabled", True) if cfg else True
    return {"enabled": enabled}


@router.put("/audit/toggle")
async def audit_toggle(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
    enabled: bool = True,
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "audit_logging_enabled"))
    cfg = result.scalar_one_or_none()
    if cfg:
        cfg.value = {"enabled": enabled}
    else:
        cfg = AppConfig(key="audit_logging_enabled", value={"enabled": enabled})
        db.add(cfg)
    await db.commit()
    # Always log the toggle itself, even if audit is now disabled.
    from app.db.models.config import AuditLog

    db.add(
        AuditLog(
            admin_id=admin.id,
            action="audit_toggle",
            resource_type="config",
            details={"enabled": enabled},
        )
    )
    await db.commit()
    return {"status": "ok", "enabled": enabled}


# --- Stats export ---


@router.get("/export/usage")
async def export_usage(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
    format: str = Query("json", regex="^(json|csv)$"),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(1000, ge=1, le=10000),
):
    from datetime import datetime, timedelta, timezone

    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    result = await db.execute(
        select(UsageRecord).where(UsageRecord.created_at >= since).order_by(desc(UsageRecord.created_at)).limit(limit)
    )
    records = result.scalars().all()

    data = [
        {
            "id": str(r.id),
            "request_id": str(r.request_id),
            "user_id": str(r.user_id),
            "model_name": r.model_name,
            "input_tokens": r.input_tokens,
            "output_tokens": r.output_tokens,
            "cost_to_user": float(r.cost_to_user),
            "cost_to_provider": float(r.cost_to_provider),
            "profit": float(r.profit),
            "latency_ms": r.latency_ms,
            "status": r.status,
            "is_stream": r.is_stream,
            "api_format": r.api_format,
            "created_at": str(r.created_at),
        }
        for r in records
    ]

    if format == "csv":
        import csv
        import io
        from fastapi.responses import StreamingResponse

        output = io.StringIO()
        if data:
            writer = csv.DictWriter(output, fieldnames=data[0].keys())
            writer.writeheader()
            writer.writerows(data)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=usage_export.csv"},
        )

    return {"format": "json", "count": len(data), "data": data}


# --- Notifications config ---


@router.get("/config/notifications")
async def get_notification_config(
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(AppConfig).where(AppConfig.key == "notifications"))
    row = result.scalar_one_or_none()
    if not row:
        return {
            "webhook_url": None,
            "email": None,
            "alert_thresholds": {"error_rate": 10, "latency": 5000, "key_failures": 3},
        }
    return row.value


class NotificationConfigUpdate(BaseModel):
    webhook_url: str | None = None
    email: str | None = None
    alert_thresholds: dict | None = None


@router.put("/config/notifications")
async def set_notification_config(
    req: NotificationConfigUpdate,
    admin: Annotated[User, Depends(get_current_admin)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    from app.core.permissions import require_admin

    require_admin(admin.role)
    result = await db.execute(select(AppConfig).where(AppConfig.key == "notifications"))
    row = result.scalar_one_or_none()
    cfg = row.value if row else {}
    for field, value in req.model_dump(exclude_unset=True).items():
        cfg[field] = value
    if row:
        row.value = cfg
    else:
        db.add(AppConfig(key="notifications", value=cfg))
    await log_action(db, admin.id, "config_update", "config", details={"key": "notifications"})
    await db.commit()
    return {"status": "ok", "config": cfg}
