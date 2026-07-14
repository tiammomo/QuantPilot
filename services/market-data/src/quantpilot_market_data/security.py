from __future__ import annotations

import hmac
import os
from ipaddress import ip_address

from fastapi import Header, HTTPException, status


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower().strip("[]")
    if normalized == "localhost":
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def market_admin_token_required() -> bool:
    mode = os.getenv("QUANTPILOT_DEGRADATION_MODE", "auto").strip().lower()
    host = os.getenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    return mode == "strict" or not _is_loopback_host(host)


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, separator, value = authorization.partition(" ")
    if separator and scheme.lower() == "bearer":
        return value.strip() or None
    return None


async def require_market_admin(
    authorization: str | None = Header(default=None),
    x_quantpilot_admin_token: str | None = Header(default=None),
) -> None:
    """Protect mutating market endpoints while keeping loopback development frictionless."""
    configured = os.getenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "").strip()
    if not configured:
        if market_admin_token_required():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "写接口已关闭：strict 或非 loopback 监听必须配置 "
                    "QUANTPILOT_MARKET_ADMIN_TOKEN。"
                ),
            )
        return

    presented = x_quantpilot_admin_token or _bearer_token(authorization)
    if not presented or not hmac.compare_digest(configured, presented):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少或无效的市场数据管理员令牌。",
            headers={"WWW-Authenticate": "Bearer"},
        )
