"""CLI bridge for the Node backend.

    python -m parser.cli FILE
        Prints the parsed document as JSON.
    python -m parser.cli remediate IN OUT [--language TAG] [--title TEXT]
        Writes a repaired copy of IN to OUT and prints {"changes", "before", "after"}.

On a document error both print {"error": {"code", "message"}} and exit with status 1.
"""
import argparse
import contextlib
import json
import sys
from .document_parser import parse_document, ParseError


def _run(argv):
    if len(argv) >= 1 and argv[0] == 'remediate':
        from .remediate import remediate
        parser = argparse.ArgumentParser(prog='parser.cli remediate')
        parser.add_argument('source')
        parser.add_argument('destination')
        parser.add_argument('--language')
        parser.add_argument('--title')
        args = parser.parse_args(argv[1:])
        return remediate(args.source, args.destination, language=args.language, title=args.title)
    if len(argv) != 1:
        raise SystemExit(2)
    return parse_document(argv[0])


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        # Libraries sometimes print warnings to stdout; keep stdout for the JSON result only.
        with contextlib.redirect_stdout(sys.stderr):
            result = _run(argv)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ParseError as exc:
        print(json.dumps({'error': {'code': exc.code, 'message': str(exc)}}))
        return 1
    except SystemExit:
        print(json.dumps({'error': {'code': 'BAD_REQUEST', 'message': 'Usage: python -m parser.cli FILE | remediate IN OUT [--language TAG] [--title TEXT]'}}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
