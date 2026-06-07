import logging
import re
import sys
from typing import Final

_SECRET_PATTERNS: Final = (
    re.compile(r"(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", re.IGNORECASE),
    re.compile(r"((?:ark|api)[_-]?key\s*[:=]\s*)[^\s,;]+", re.IGNORECASE),
)


def redact(value: object) -> str:
    text = str(value)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(r"\1[REDACTED]", text)
    return text


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
