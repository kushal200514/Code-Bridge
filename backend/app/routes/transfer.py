from fastapi import APIRouter, status

from app.models.transfer import (
    CreateTransferRequest,
    CreateTransferResponse,
    LegacyCreateTransferResponse,
)
from app.services.transfer_service import transfer_service


router = APIRouter(tags=["transfers"])


@router.post(
    "/api/transfers",
    response_model=CreateTransferResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_transfer(payload: CreateTransferRequest | None = None) -> CreateTransferResponse:
    transfer, ttl = transfer_service.create_transfer(
        payload.expires_in_seconds if payload else None
    )
    return CreateTransferResponse(transfer=transfer, expires_in_seconds=ttl)


@router.post(
    "/transfer/create",
    response_model=LegacyCreateTransferResponse,
    include_in_schema=False,
)
async def create_transfer_legacy() -> LegacyCreateTransferResponse:
    transfer, ttl = transfer_service.create_transfer()
    return LegacyCreateTransferResponse(
        session_id=transfer.id,
        code=transfer.code,
        expires_in_seconds=ttl,
    )
