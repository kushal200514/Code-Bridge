from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class TransferStatus(StrEnum):
    WAITING_FOR_RECEIVER = "waiting_for_receiver"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    COMPLETED = "completed"


class CreateTransferRequest(BaseModel):
    expires_in_seconds: int | None = Field(default=None, ge=60, le=3600)


class Transfer(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    code: str
    status: TransferStatus
    created_at: datetime
    expires_at: datetime


class CreateTransferResponse(BaseModel):
    transfer: Transfer
    expires_in_seconds: int


class LegacyCreateTransferResponse(BaseModel):
    session_id: str
    code: str
    expires_in_seconds: int
    qr_data_url: str | None = None
