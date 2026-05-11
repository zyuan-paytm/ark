# PLAN: unit test for `parse_datetime` raising `HTTPException(400)` on bad ISO 8601

## 1. Summary

The task asks for one unit test against
`app/control_plane/routers/request_audit/deps.py:42-52`, function `parse_datetime`,
verifying it raises `HTTPException(400)` for malformed ISO 8601 input.
**That file does not exist in this repository.** This repo is the Ark
Bun + TypeScript monorepo (`packages/{cli,core,arkd,...}`); it contains zero
Python files, no `app/` directory, no FastAPI usage, and no `parse_datetime`
or `request_audit` symbols. The task appears to have been routed to the wrong
repo or branch. Implementation is **blocked** until either (a) the missing
Python source is provided, or (b) the task is re-scoped to an equivalent
TypeScript symbol in this repo.

## 2. Files to modify/create

Nothing actionable in this repo today. If the missing source becomes available,
the conventional layout would be:

- `app/control_plane/routers/request_audit/deps.py` -- **must already exist
  before any test is written**; the test targets lines 42-52 of this file.
- `tests/control_plane/routers/request_audit/test_deps.py` -- new file, one
  pytest function (`test_parse_datetime_bad_iso_raises_400`). Mirror whatever
  directory convention the surrounding tests use (`tests/` vs `app/tests/` vs
  per-module `_tests_` -- decide by reading the source repo, not guessing).
- `PLAN.md` -- this planning artifact (committed on this branch).

No production code change. No schema, no migrations, no fixtures expected.

## 3. Implementation steps

The steps below are **conditional on the source file existing**. Until it does,
stop after step 0.

0. **Verify the target exists.** Run from repo root:
   ```bash
   test -f app/control_plane/routers/request_audit/deps.py \
     && sed -n '42,52p' app/control_plane/routers/request_audit/deps.py
   ```
   If the file is absent (current state in this worktree), abort and surface
   the mismatch -- do not invent a `parse_datetime` to test.

1. **Read `parse_datetime` (lines 42-52)** to confirm:
   - It takes a single string argument (probable signature
     `parse_datetime(value: str) -> datetime`).
   - The 400 branch is raised on `ValueError` / `fromisoformat` failure (this
     is the standard FastAPI dep-injection pattern -- the function is meant to
     be used as `Depends(parse_datetime)` and translates bad query/path input
     into a clean 400).
   - The exception carries a `detail` string so the test can assert on it.

2. **Identify the test framework.** Look for `pytest.ini`, `pyproject.toml`
   `[tool.pytest.ini_options]`, or `setup.cfg`. Match the repo's existing
   import style (`from app.control_plane.routers.request_audit.deps import
   parse_datetime` vs. a shorter alias from `conftest.py`).

3. **Write one test** (single function, no class wrapper unless surrounding
   tests use classes). Skeleton:
   ```python
   import pytest
   from fastapi import HTTPException

   from app.control_plane.routers.request_audit.deps import parse_datetime


   def test_parse_datetime_raises_400_on_bad_iso8601():
       with pytest.raises(HTTPException) as exc:
           parse_datetime("not-a-real-datetime")
       assert exc.value.status_code == 400
   ```
   Use a clearly-malformed string (`"not-a-real-datetime"` or
   `"2024-13-45T99:99:99Z"`) so the failure mode is unambiguous and not a
   timezone edge case. Do **not** parametrize over many inputs -- the task
   says "one unit test".

4. **Run the test** (`pytest path/to/test_deps.py -q`) and confirm green.

5. **Commit** with the project's convention (likely
   `test: add parse_datetime 400 on bad ISO 8601`). Do **not** bundle unrelated
   files into this commit -- the diff should be one new test file.

## 4. Testing strategy

- **Positive coverage:** the single failing-input case described above.
- **Assertion granularity:**
  - Required: `exc.value.status_code == 400`.
  - Optional, only if `deps.py` sets a stable `detail` literal: assert
    `"datetime" in exc.value.detail.lower()` (or whatever literal the code
    uses). Skip this if the message is templated / variable -- brittle
    assertions on free-form error text are worse than no assertion.
- **What we explicitly are NOT testing in this task:**
  - The happy path (valid ISO 8601 -> returns `datetime`). Out of scope; add
    in a follow-up if missing.
  - Timezone-aware vs naive handling. Out of scope.
  - Behavior under FastAPI's `Depends()` (integration territory).
- **Verification:** `pytest -q` plus `pytest --collect-only` to confirm the
  new test is picked up by the existing test discovery config.

## 5. Risk assessment

- **Primary risk: the file does not exist in this repo.** This is not a small
  ambiguity -- it is a hard blocker. The Ark repo is TypeScript; planning a
  Python test here will produce code that cannot be committed or run.
  Implementer must NOT fabricate a `parse_datetime` in this repo to satisfy
  the task. If routed to the right repo, the risk drops to near zero.
- **Edge cases for the test itself (once the file exists):**
  - `parse_datetime` might return `None` instead of raising for empty string
    -- pick an input that is guaranteed to hit the `ValueError` branch on
    `datetime.fromisoformat`, e.g. `"not-a-real-datetime"`.
  - `HTTPException` could be re-exported via a project wrapper. Import from
    the same module the production code uses, not from `fastapi` directly, if
    that's the local convention.
- **Breaking changes / migrations:** none. Pure test addition.

## 6. Open questions

1. **Which repo is the real target?** This worktree is Ark
   (`/Users/zineng/.ark/worktrees/s-xrqnks8z5k`, branch `ark-s-xrqnks8z5k`),
   which has no Python code. Likely candidates for the actual target:
   - A separate FastAPI control-plane repo (the path
     `app/control_plane/routers/...` matches a typical FastAPI service
     layout).
   - A sibling project under `~/.ark/` or a different worktree.
   The user must confirm the repo before implementation can proceed.
2. **What does `parse_datetime` actually do on bad input today?** Without the
   source file we are guessing it `raise HTTPException(status_code=400, ...)`.
   If it instead returns `None`, or raises `ValueError` and relies on FastAPI
   to translate, the test shape changes. Confirm by reading lines 42-52 first.
3. **Test directory convention.** `tests/` mirroring the package vs. inline
   `_tests_` next to source -- inspect the real repo before placing the file.
4. **Should we also cover the happy path?** Task says "one unit test", so
   strictly no -- but it's worth flagging as a follow-up since a single
   failure-path test gives weaker regression protection than a pair.
