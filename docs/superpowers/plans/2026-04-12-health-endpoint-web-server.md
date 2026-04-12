# Health Endpoint for Web Server (packages/core/hosted) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /api/health` endpoint to `packages/core/hosted/web.ts` that returns server status without requiring authentication.

**Architecture:** Add a single route handler in the `Bun.serve` fetch function, positioned before auth checks so load balancers and k8s liveness probes can reach it without tokens. The response mirrors the conductor's existing `/health` pattern (see `packages/core/conductor/conductor.ts:232`) but extended with uptime and the web-server-specific context.

**Tech Stack:** Bun HTTP server (`Bun.serve`), TypeScript, `bun:test`

---

## File Map

| File | Change |
|------|--------|
| `packages/core/hosted/web.ts` | Add `GET /api/health` handler + track server start time |
| `packages/core/__tests__/web.test.ts` | Add two tests: unauthenticated access and response shape |

---

### Task 1: Add the health endpoint to the web server

**Files:**
- Modify: `packages/core/hosted/web.ts`

**Context:**
The fetch handler in `startWebServer` currently handles these routes in order:
1. CORS preflight (`OPTIONS`)
2. Token auth check
3. Multi-tenant auth check
4. SSE endpoint (`/api/events/stream`)
5. JSON-RPC endpoint (`/api/rpc`)
6. GitHub webhook
7. Static file serving

The health endpoint must go **before step 2** (the token auth check) so that unauthenticated probes from load balancers and k8s always succeed. The conductor uses `GET /health`; the web server uses `/api/` prefixes - follow that convention with `GET /api/health`.

Response shape (consistent with conductor's `{ status, sessions }`):
```json
{ "status": "ok", "uptime": 42.1, "sessions": 3 }
```
`uptime` is seconds since the server started. Capture `Date.now()` at the top of `startWebServer` and compute `(Date.now() - startedAt) / 1000`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__tests__/web.test.ts` inside the existing `describe("web server", ...)` block, using the next available port (18547):

```ts
it("GET /api/health returns ok without auth", async () => {
  server = startWebServer(getApp(), { port: 18547, token: "secret" });
  const resp = await fetch("http://localhost:18547/api/health");
  expect(resp.status).toBe(200);
  const data = await resp.json() as Record<string, unknown>;
  expect(data.status).toBe("ok");
  expect(typeof data.uptime).toBe("number");
  expect(typeof data.sessions).toBe("number");
});
```

Note: the server is started with `token: "secret"` to prove the health check bypasses token auth.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/paytmlabs/.ark/worktrees/s-2b8f29
make test-file F=packages/core/__tests__/web.test.ts
```

Expected output: FAIL - `GET /api/health returns ok without auth` fails with status 401 (blocked by token auth) or 404.

- [ ] **Step 3: Implement the health endpoint in web.ts**

In `packages/core/hosted/web.ts`, make two changes:

**3a.** Capture start time at the top of `startWebServer`, right after the opening brace:
```ts
export function startWebServer(app: AppContext, opts?: WebServerOptions): { stop: () => void; url: string } {
  const startedAt = Date.now();
  const port = opts?.port ?? 8420;
  // ... rest of existing code
```

**3b.** Add the health route inside `Bun.serve`'s `fetch` function, immediately after the CORS preflight block and **before** the token auth check. The existing structure at line 151 is:

```ts
// CORS preflight
if (req.method === "OPTIONS") {
  return new Response(null, { status: 204, headers: CORS });
}

// Token auth (legacy simple token) -- checked first for backward compat
if (token) {
```

Insert between these two blocks:

```ts
// Health check -- unauthenticated, accessible to load balancers and k8s probes
if (url.pathname === "/api/health" && req.method === "GET") {
  return jsonResponse({
    status: "ok",
    uptime: (Date.now() - startedAt) / 1000,
    sessions: app.sessions.list().length,
  });
}
```

The full resulting section should look like:

```ts
      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Health check -- unauthenticated, accessible to load balancers and k8s probes
      if (url.pathname === "/api/health" && req.method === "GET") {
        return jsonResponse({
          status: "ok",
          uptime: (Date.now() - startedAt) / 1000,
          sessions: app.sessions.list().length,
        });
      }

      // Token auth (legacy simple token) -- checked first for backward compat
      if (token) {
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd /Users/paytmlabs/.ark/worktrees/s-2b8f29
make test-file F=packages/core/__tests__/web.test.ts
```

Expected output: All tests pass including `GET /api/health returns ok without auth`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/hosted/web.ts packages/core/__tests__/web.test.ts
git commit -m "feat(web): add GET /api/health endpoint to web server"
```

---

## Testing Strategy

- One test confirms the endpoint is reachable without auth even when a token is configured (the key behavioral requirement).
- One test confirms the response shape (`status`, `uptime`, `sessions` fields with correct types).
- Both tests reuse the existing `withTestContext()` / `afterEach` cleanup pattern already in the file.
- No need to test readOnly mode separately - health is always readable by design.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Port 18547 already in use by another test | Low | Each test uses `afterEach` cleanup; tests run sequentially per CLAUDE.md |
| `app.sessions.list()` is slow under test | Very low | It's a simple SQL SELECT; acceptable in health path |
| Health endpoint accidentally blocked by future auth refactors | Low | Placement before auth block + test with `token:` set prevents regression |
| Uptime being 0 in fast tests | Possible | Test checks `typeof ... === "number"`, not exact value - no issue |

## Edge Cases Covered

- Token auth configured: health bypasses it (tested explicitly)
- Multi-tenant auth: health is inserted before both auth checks, so it bypasses both
- ReadOnly mode: health is a read-only operation, no guard needed
- Method guard: only `GET` matches; `POST /api/health` falls through to 404 naturally
