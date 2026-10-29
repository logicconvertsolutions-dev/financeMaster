"""Read CSV / Excel exports into rows of strings (dates normalized to ISO)."""
import csv
import io
from datetime import date, datetime
from pathlib import Path

TABLE_EXTENSIONS = {".csv", ".xlsx", ".xls"}


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer() and abs(v) >= 1e6:
        return str(int(v))  # long account numbers Excel turned into floats
    return str(v).strip()


def read_rows(path: Path) -> list[list[str]]:
    """All non-empty rows of the first sheet (or the CSV)."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        raw = path.read_bytes()
        for enc in ("utf-8-sig", "cp1252"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        sample = text[:4096]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]
    elif suffix == ".xlsx":
        import openpyxl

        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            rows = [[_cell(c) for c in r] for r in wb.worksheets[0].iter_rows(values_only=True)]
        finally:
            wb.close()
    elif suffix == ".xls":
        import xlrd

        book = xlrd.open_workbook(path)
        sheet = book.sheet_by_index(0)
        rows = []
        for i in range(sheet.nrows):
            row = []
            for cell in sheet.row(i):
                if cell.ctype == xlrd.XL_CELL_DATE:
                    row.append(xlrd.xldate_as_datetime(cell.value, book.datemode).date().isoformat())
                else:
                    row.append(_cell(cell.value))
            rows.append(row)
    else:
        raise ValueError(f"Not a table file: {path.name}")
    return [r for r in rows if any(c for c in r)]
