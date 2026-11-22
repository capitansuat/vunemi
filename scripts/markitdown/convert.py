"""
Vunemi's way into MarkItDown: converts several files in one run, so Python
and MarkItDown start once for all of them, not once a file.

    convert IN OUT [IN OUT ...]

Each IN is converted to Markdown and written to OUT. One line of JSON per
file goes to stdout, in order: {"ok": true, "chars": N} or
{"ok": false, "error": "..."}. The exit code is 0 unless the arguments were
wrong; a file that fails does not stop the others.
"""
import codecs
import importlib
import json
import os
import sys
import types

# Kinds read as text, whose charset MarkItDown guesses from the first 64 KiB.
TEXT_KINDS = {".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".txt", ".md", ".markdown"}


def all_utf8(path):
    """
    True when the whole file is UTF-8. MarkItDown guesses the charset from
    its start: an ASCII start with a "–" further on was guessed as ASCII and
    then failed to decode.
    """
    decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
    try:
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                decoder.decode(chunk)
        decoder.decode(b"", final=True)
        return True
    except (UnicodeDecodeError, OSError):
        return False


def lazy(name):
    """
    Imported when first used: pandas costs about two seconds and only Excel
    needs it. MarkItDown imports it up front; it gets this stand-in, which
    imports the real module the first time anything is asked of it.
    """

    class Later(types.ModuleType):
        def __getattr__(self, attr):
            del sys.modules[name]
            real = importlib.import_module(name)
            self.__dict__.update(real.__dict__)
            return getattr(real, attr)

    sys.modules[name] = Later(name)


def main(argv):
    if len(argv) == 0 or len(argv) % 2:
        print("usage: convert IN OUT [IN OUT ...]", file=sys.stderr)
        return 2
    lazy("pandas")
    from markitdown import MarkItDown, StreamInfo

    md = MarkItDown()
    for src, dst in zip(argv[::2], argv[1::2]):
        try:
            utf8 = os.path.splitext(src)[1].lower() in TEXT_KINDS and all_utf8(src)
            text = md.convert(src, stream_info=StreamInfo(charset="utf-8") if utf8 else None).markdown or ""
            with open(dst, "w", encoding="utf-8") as f:
                f.write(text)
            print(json.dumps({"ok": True, "chars": len(text)}), flush=True)
        except Exception as error:  # noqa: BLE001 - every failure is reported, none stops the run
            message = f"{type(error).__name__}: {error}".strip()
            # The start says why; Vunemi shortens it further.
            print(json.dumps({"ok": False, "error": message[:2000]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
