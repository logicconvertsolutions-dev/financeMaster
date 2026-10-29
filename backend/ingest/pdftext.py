"""Read text lines out of a (possibly password-protected) PDF, keeping horizontal positions.

Positions let the parser tell which column a number sits in (Withdrawals vs Deposits vs Balance),
which plain text can't.
"""
import io
from dataclasses import dataclass
from pathlib import Path

import pdfplumber
import pikepdf


class PdfLocked(Exception):
    pass


@dataclass
class Line:
    text: str
    x1: list[float] | None = None  # right edge (points) of each character of `text`; None when unknown

    def __str__(self) -> str:
        return self.text


def _open_bytes(path: Path, password: str | None) -> bytes:
    try:
        with pikepdf.open(path, password=password or "") as pdf:
            if not pdf.is_encrypted:
                return path.read_bytes()
            buf = io.BytesIO()
            pdf.save(buf)  # saving drops the encryption; only ever held in memory
            return buf.getvalue()
    except pikepdf.PasswordError as e:
        raise PdfLocked(str(e)) from e


def is_locked(path: Path) -> bool:
    try:
        _open_bytes(path, None)
        return False
    except PdfLocked:
        return True


def _line_positions(text: str, chars: list[dict]) -> list[float] | None:
    """Right edge of every character in `text`; spaces take the position of the char before them."""
    out: list[float] = []
    j = 0
    last = chars[0]["x0"] if chars else 0.0
    for ch in text:
        if j < len(chars) and chars[j]["text"] == ch:
            last = chars[j]["x1"]
            j += 1
        elif ch.isspace():
            pass
        else:
            # skip chars pdfplumber dropped from the text (duplicates, whitespace glyphs)
            while j < len(chars) and chars[j]["text"] != ch:
                j += 1
            if j < len(chars):
                last = chars[j]["x1"]
                j += 1
        out.append(last)
    return out


def extract_layout(path: Path, password: str | None = None) -> list[list[Line]]:
    """Text lines per page, in reading order, with per-character right edges."""
    data = _open_bytes(path, password)
    pages: list[list[Line]] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            lines = []
            for ln in page.extract_text_lines(layout=False, strip=True, return_chars=True,
                                              x_tolerance=1.5, y_tolerance=3):
                text = ln["text"].strip()
                if text:
                    lines.append(Line(text, _line_positions(text, ln.get("chars") or [])))
            pages.append(lines)
    return pages


def extract_lines(path: Path, password: str | None = None) -> list[list[str]]:
    """Plain text lines per page."""
    return [[ln.text for ln in page] for page in extract_layout(path, password)]
