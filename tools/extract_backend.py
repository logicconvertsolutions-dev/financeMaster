"""Recover backend/**/*.py from the phone app's built engine worker.

The phone build imports every backend file with Vite's `?raw`, so engine.worker-*.js carries each one
verbatim as a JS string, listed in a map like {"../../../backend/app.py": b, ...}. This decodes them back.

    python tools/extract_backend.py recovered/phone-dist/assets/engine.worker-CkDu_gOc.js [out_dir]
"""
import re
import sys
from pathlib import Path

ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "`": "`", "\\": "\\", "$": "$", '"': '"', "'": "'", "0": "\0"}


def js_string(text: str, var: str) -> str:
    """The value of the string literal assigned to `var` (template or double-quoted), unescaped."""
    m = re.search(r"(?:^|[,;\s])(?:var |let |const )?" + re.escape(var) + r'=(`|")', text)
    if not m:
        raise ValueError(f"no string literal for {var}")
    quote, i, out = m.group(1), m.end(), []
    while True:
        c = text[i]
        if c == "\\":
            n = text[i + 1]
            if n == "u":
                out.append(chr(int(text[i + 2:i + 6], 16)))
                i += 6
                continue
            if n == "x":
                out.append(chr(int(text[i + 2:i + 4], 16)))
                i += 4
                continue
            out.append(ESCAPES.get(n, n))
            i += 2
            continue
        if c == quote:
            return "".join(out)
        if quote == "`" and text.startswith("${", i):
            raise ValueError(f"{var} has a template interpolation; not a raw file")
        out.append(c)
        i += 1


def file_map(text: str) -> dict[str, str]:
    m = re.search(r"Object\.assign\(\{((?:\"(?:\.\./)+backend/[^\"]+\":\w+,?)+)\}\)", text)
    if not m:
        raise ValueError("backend file map not found")
    return {path: var for path, var in re.findall(r'"(?:\.\./)+(backend/[^"]+)":(\w+)', m.group(1))}


def main() -> None:
    worker = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
    text = worker.read_text(encoding="utf-8")
    for path, var in sorted(file_map(text).items()):
        source = js_string(text, var)
        dest = out_dir / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(source, encoding="utf-8", newline="")
        print(f"{source.count(chr(10)):5d} lines  {path}")


if __name__ == "__main__":
    main()
