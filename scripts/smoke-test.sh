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
echo "POST $BASE/analyze (tagged PDF fixture: figure alt text read from tags)"
curl -fsS -F "file=@$DIR/tests/fixtures/documents/tagged.pdf;type=application/pdf" "$BASE/analyze" | grep -q '"snippet":"Figure 1"'
echo "POST $BASE/analyze (stylesheet contrast)"
printf '<!doctype html><html lang="en"><head><title>T</title><style>.m{color:#aaa}</style></head><body><p class="m">Faint</p></body></html>' \
  | curl -fsS -F "file=@-;filename=s.html;type=text/html" "$BASE/analyze" | grep -q '"wcag_criterion":"1.4.3"'
echo "POST $BASE/remediate (DOCX fixture)"
curl -fsS -F "file=@$DIR/tests/fixtures/documents/course.docx;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document" \
  "$BASE/remediate" | grep -q '"content_base64"'
echo "POST $BASE/tester/test/setup + run (tester against this system)"
SESSION=$(curl -fsS -X POST -H 'Content-Type: application/json' -d "{\"target_url\":\"$BASE\"}" "$BASE/tester/test/setup" \
  | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
test -n "$SESSION"
curl -fsS -X POST -H 'Content-Type: application/json' -d "{\"session_id\":\"$SESSION\"}" "$BASE/tester/test/run" | grep -q '"coverage"'
echo "GET  $BASE/test/report (system coverage)"
curl -fsS "$BASE/test/report?session_id=$SESSION" | grep -q '"basis"'
echo "Smoke test passed."
