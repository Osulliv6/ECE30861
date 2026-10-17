"""CLI bridge for Node backend: python -m parser.cli /path/to/document"""
import json
import sys
from .document_parser import parse_document, ParseError

def main():
    if len(sys.argv)!=2:
        print(json.dumps({'error':{'code':'BAD_REQUEST','message':'Usage: python -m parser.cli FILE'}}))
        return 2
    try:
        print(json.dumps(parse_document(sys.argv[1]),ensure_ascii=False))
        return 0
    except ParseError as exc:
        print(json.dumps({'error':{'code':exc.code,'message':str(exc)}}))
        return 1
if __name__=='__main__': sys.exit(main())
