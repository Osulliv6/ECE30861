# Frontend Verification

Verified on October 8, 2026.

## Automated checks

`node --test tests/core.test.mjs`: 7 tests passed, 0 failed.

`node --check` passed for the application, API utilities, and preview server.

The tests exercise the frontend interpretation of the shared contract, client input boundaries, transport settings, incomplete-response rejection, and abort behavior. They do not verify a live backend contract. See `core.test.mjs` for assertions.

## Browser checks

The Codex in-app browser was used to operate the local frontend. Real browser uploads used generated synthetic HTML fixtures and the local test double. No real accessibility-engine findings are claimed by these checks.

| Check | Observed result |
| --- | --- |
| Service connection | Health and format discovery succeeded; supported extensions and 10 MB limit displayed |
| Valid fixture upload | Three complete findings with WCAG mappings, locations, and suggested fixes |
| No-issue response | Explicit no-supported-violations state and compliance limitation |
| Required AI service failure | Error displayed; no report shown |
| Corrupt fixture response | HTTP 422 error displayed; no report shown |
| Incomplete finding | Invalid response rejected; no report shown |
| Empty file | Rejected before upload |
| Cancel | Browser request canceled; report not displayed |
| Slow response | Error after 30 seconds; no report displayed |
| Severity filter | Moderate filter showed 1 of 3 findings |
| Fixed sample | Sample banner clearly indicated no uploaded document was analyzed |
| Desktop visual review | Upload and findings layout inspected |
| Mobile visual review | 390-pixel viewport inspected; document width was 390 pixels with no horizontal overflow |

The temporary mobile viewport override was reset after testing. The preview was left on a labeled sample report with no connected test backend.

## Remaining integrated checks

Use the actual team backend to verify parsing, WCAG detection, AI remediation quality, HTTPS deployment, cross-origin permissions, server-side cleanup, and real response latency. A full screen-reader audit and user testing have not been performed.
