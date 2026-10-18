"""CLI bridge for Node backend: python -m parser.cli /path/to/document"""
import contextlib
import json
import sys
from .document_parser import parse_document, ParseError

def main():
    if len(sys.argv)!=2:
        print(json.dumps({'error':{'code':'BAD_REQUEST','message':'Usage: python -m parser.cli FILE'}}))
        return 2
    try:
        # Libraries sometimes print warnings to stdout; keep stdout for the JSON result only.
        with contextlib.redirect_stdout(sys.stderr):
            result=parse_document(sys.argv[1])
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except ParseError as exc:
        print(json.dumps({'error':{'code':exc.code,'message':str(exc)}}))
        return 1
if __name__=='__main__': sys.exit(main())
