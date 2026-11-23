# Phase 6 verification

## Performance and the upload boundary

Run `node scripts/benchmark-html.mjs BASE_URL` against the candidate build. After a confirmed idle interval on Render, add `--cold` to record the first health request separately. The script records three warm calls per fixture and validates report shape for accepted uploads.

| Fixture | Expected |
| --- | --- |
| 150,000 HTML elements | HTTP 200 and a valid report within 30 seconds |
| 150,001 HTML elements | HTTP 422 with `UNPROCESSABLE_FILE` within 30 seconds |
| Exactly 10 MiB, 110,005 HTML elements with styled text | HTTP 200 and a valid report within 30 seconds |

The exact-size fixture includes literal markup inside a comment and emits more than the former 16 MiB result buffer. Test the same fixtures on a Render instance with the candidate build before using the timings as release evidence. The recorded Phase 5 Render timings describe its deployed commit. The 10 MiB rejection case does not establish the performance of accepting a 10 MiB document.

On the local branch, the 150,000-element case took 1.27–1.36 s and returned 200, the 150,001-element case took 0.13 s and returned 422, and the 10 MiB text-heavy case took 4.68–5.35 s and returned 200. A local `cProfile` pass on the accepted element boundary placed most time in BeautifulSoup tree construction. Consolidating tree scans and avoiding a heading regex on every element reduced the profiled run from 4.39 s on Phase 5 to 3.53 s on the candidate. These are local measurements.

## Coverage and manual evidence

`testing/pod-spec.json` is the Team 20 draft based on [Team 19's published Pod F case definitions](https://github.com/RemleyGHooker/AccessAssist/blob/main/src/cases.js). The runtime totals count shared tests that reached a pass or fail verdict. Agreement on the mapping, MIME list, byte units, element limit, and machine-readable errors remains a Pod F decision.

| Item | Evidence outside the shared run |
| --- | --- |
| Test interface | `tests/test-interface.test.mjs` exercises setup and report. |
| AC-06 | Run the guidance review below with a person who edits course materials. |
| AC-09 | `tests/integration.test.mjs` simulates a missing and a hung parser. The 503 codes are `PROCESSING_UNAVAILABLE` and `PROCESSING_TIMEOUT`, respectively. |
| AC-10 | Integration tests check temp cleanup on success and failure. Server responses use `Cache-Control: no-store`. |
| AC-11 | Inspect the deployed HTTPS endpoint and HTTP redirect behavior. Local loopback is intentionally HTTP. |
| AC-12 | The local suite checks the accepted and rejected boundaries. Use the candidate deployment script for warm-host evidence. |

### AC-06 remediation guidance review

Use `fixtures/guidance.html`, `fixtures/documents/course.docx`, `fixtures/documents/tagged.pdf`, and `fixtures/documents/mixed-scan.pdf` (paths relative to this directory). Analyze each fixture and attempt one suggested fix in the appropriate authoring tool. For each, score **relevance**, **specificity**, and **actionability** from 0 to 2. A score of 0 means missing or misleading, 1 means useful with interpretation, and 2 means the author can act on it directly. Record the finding, location, scores, and attempted outcome. Revise any message that scores below 2 and repeat the affected case.

For the two reading-order fixtures, listen using a PDF reader and screen reader. The correct file should read down the left column and then down the right. The mismatched file presents the same visible layout and declares a left-right zigzag tag order. Record which reading order the screen reader actually uses. The automated note is a prompt for this check.

A local dry run confirmed three changes against the analyzer: adjusting the HTML text color cleared 1.4.3, setting the Word table's header row cleared its header finding, and assigning the PDF heading an H2 tag cleared its heading-gap finding. The scan fixture also produced guidance for page 2. The course-material author review and screen-reader check are still pending.
