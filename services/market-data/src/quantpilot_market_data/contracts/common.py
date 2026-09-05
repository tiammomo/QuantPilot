from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

MarketCode = Literal["SH", "SZ", "BJ", "UNKNOWN"]


AssetType = Literal["stock", "index", "etf", "fund", "mixed", "unknown"]


DataQualityStatus = Literal["ok", "warning", "error"]


CacheStatus = Literal["hit", "miss", "disabled", "bypass", "redis-hit"]


class DataQuality(BaseModel):
    """统一数据质量摘要，供 Agent 和前端判断数据是否可直接使用。"""

    status: DataQualityStatus = Field(default="ok", description="数据质量状态")
    missing_fields: list[str] = Field(default_factory=list, description="缺失字段")
    warnings: list[str] = Field(default_factory=list, description="质量警告")


class FetchMetadata(BaseModel):
    """本服务获取数据时的缓存与新鲜度元信息。"""

    cache_status: CacheStatus = Field(default="bypass", description="缓存状态")
    cache_key: str | None = Field(default=None, description="本地缓存键")
    cache_ttl_seconds: int | None = Field(default=None, description="缓存 TTL，单位秒")
    cached_at: datetime | None = Field(default=None, description="写入缓存时间")
    expires_at: datetime | None = Field(default=None, description="缓存过期时间")
    cache_path: str | None = Field(default=None, description="本地缓存文件路径")


def _merge_data_quality(
    current: DataQuality,
    *,
    missing_fields: list[str] | None = None,
    warnings: list[str] | None = None,
    status: DataQualityStatus | None = None,
) -> DataQuality:
    merged_missing = list(dict.fromkeys([*current.missing_fields, *(missing_fields or [])]))
    merged_warnings = list(dict.fromkeys([*current.warnings, *(warnings or [])]))
    inferred_status: DataQualityStatus = "ok"
    if current.status == "error" or status == "error":
        inferred_status = "error"
    elif current.status == "warning" or status == "warning" or merged_missing or merged_warnings:
        inferred_status = "warning"

    return DataQuality(
        status=inferred_status,
        missing_fields=merged_missing,
        warnings=merged_warnings,
    )


def _missing_field_names(values: dict[str, Any]) -> list[str]:
    return [key for key, value in values.items() if value is None or value == ""]
