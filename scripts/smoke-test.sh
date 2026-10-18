#!/bin/sh
# Post-deploy check: ./scripts/smoke-test.sh https://your-service.example.com
set -eu
BASE="${1:?usage: smoke-test.sh BASE_URL}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "GET  $BASE/health"
curl -fsS "$BASE/health" | grep -q '"status":"ok"'
echo "GET  $BASE/formats"
curl -fsS "$BASE/formats" | grep -q 'application/pdf'
echo "GET  $BASE/ (UI)"
curl -fsS "$BASE/" | grep -q 'ECE 30861 Group ADA Project'
echo "POST $BASE/analyze (DOCX fixture)"
curl -fsS -F "file=@$DIR/tests/fixtures/documents/course.docx;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document" \
  -F wcag_level=AA "$BASE/analyze" | grep -q '"wcag_criterion":"1.1.1"'
echo "POST $BASE/analyze (PDF fixture)"
curl -fsS -F "file=@$DIR/tests/fixtures/documents/course.pdf;type=application/pdf" "$BASE/analyze" | grep -q '"issues"'
echo "Smoke test passed."
