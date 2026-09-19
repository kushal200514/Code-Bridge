from datetime import UTC, datetime, timedelta
import secrets
from uuid import uuid4

from app.models.transfer import Transfer, TransferStatus


DEFAULT_TRANSFER_TTL_SECONDS = 10 * 60


class TransferService:
    def __init__(self) -> None:
        self._transfers: dict[str, Transfer] = {}

    def create_transfer(self, expires_in_seconds: int | None = None) -> tuple[Transfer, int]:
        ttl = expires_in_seconds or DEFAULT_TRANSFER_TTL_SECONDS
        now = datetime.now(UTC)
        transfer = Transfer(
            id=str(uuid4()),
            code=self._new_code(),
            status=TransferStatus.WAITING_FOR_RECEIVER,
            created_at=now,
            expires_at=now + timedelta(seconds=ttl),
        )
        self._transfers[transfer.id] = transfer
        return transfer, ttl

    def _new_code(self) -> str:
        for _ in range(10):
            code = f"{secrets.randbelow(1_000_000):06d}"
            if all(existing.code != code for existing in self._transfers.values()):
                return code
        return f"{secrets.randbelow(1_000_000):06d}"


transfer_service = TransferService()
