// System side of the cross-team testing interface (POST /test/setup, GET /test/report).
// The project API is stateless, so setup only registers the session; there are no
// per-session resources to prepare or reset.

const MAX_SESSIONS = 1000;
const CODE_COVERAGE_BASIS = 'Source lines; line-coverage instrumentation is not enabled in the deployed service';

export class TestInterfaceError extends Error {
  constructor(status, message, source) { super(message); this.status = status; this.source = source; }
}

// Remembers at most `limit` IDs, dropping the oldest, so a long-running service stays bounded.
export class SessionStore {
  constructor(limit = MAX_SESSIONS) { this.limit = limit; this.sessions = new Map(); }
  has(id) { return this.sessions.has(id); }
  get(id) { return this.sessions.get(id); }
  set(id, value) {
    this.sessions.set(id, value);
    if (this.sessions.size > this.limit) this.sessions.delete(this.sessions.keys().next().value);
  }
}

export const isSessionId = value => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

export function createSystemInterface() {
  const sessions = new SessionStore();
  return {
    setup(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || !isSessionId(body.session_id)) throw new TestInterfaceError(400, 'Request body must include a nonempty string "session_id".', 'system');
      if (body.setup !== undefined && (body.setup === null || typeof body.setup !== 'object' || Array.isArray(body.setup))) throw new TestInterfaceError(400, '"setup" must be an object when provided.', 'system');
      if (sessions.has(body.session_id)) throw new TestInterfaceError(409, `Session "${body.session_id}" already exists.`, 'system');
      sessions.set(body.session_id, {createdAt:new Date().toISOString()});
      return {status:201, body:{session_id:body.session_id}};
    },
    report(sessionId) {
      if (!isSessionId(sessionId)) throw new TestInterfaceError(400, 'Query parameter "session_id" is required.', 'system');
      if (!sessions.has(sessionId)) throw new TestInterfaceError(404, `Unknown session "${sessionId}".`, 'system');
      return {status:200, body:{session_id:sessionId, coverage:{code:{covered:null, total:null, basis:CODE_COVERAGE_BASIS}}}};
    },
  };
}
