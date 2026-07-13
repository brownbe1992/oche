---
description: Full bug + security review of the codebase, output as append-only tracked findings
---

Perform a full, careful review of this codebase. I'm not a professional developer, so
explain each issue in plain language (what actually goes wrong, for whom, under what
conditions) before showing the fix — don't lead with jargon.

If the project isn't obviously internet-facing yet, review it as if it may become
internet-facing in the future (don't relax the security bar just because it's
currently LAN-only/local-only).

## What to look for

**Bugs & correctness**
- Logic errors (incorrect calculations, off-by-one errors, edge cases skipped)
- Race conditions or state that can get out of sync (especially anything
  multi-device/multi-user/concurrent)
- Unhandled errors or edge cases that could crash the app or corrupt stored data

**Security** (treat as if internet-facing)
- Input validation gaps — anywhere user input, API requests, uploaded files, or
  external data is accepted without checks
- Injection risks (SQL/NoSQL/command injection) anywhere a query or shell command is
  built from external input
- Authentication/authorization gaps — missing checks, or checks that exist but don't
  cover every path to the same effect
- Exposed secrets, API keys, or credentials in code or config
- Outdated or known-vulnerable dependencies
- XSS or CSRF, anywhere there's a web frontend or any HTML/JS rendering
- Insecure use of `eval`, `child_process`, dynamic code execution, or dynamic query
  building
- Missing rate limiting or brute-force protection on any endpoint that accepts a
  credential, PIN, or password
- CORS misconfiguration
- SSRF — anywhere the server makes an outbound request to a user- or
  admin-configurable destination
- Data exposure — endpoints or responses returning more than the caller needs

Read broadly before writing anything up — don't stop at the first few files. Verify
each finding actually reproduces in the code as written (don't report a theoretical
concern the code already guards against elsewhere) before including it.

## Where findings go — critical, read before writing output

**First, check whether this project already has audit-tracking docs** — look for
files like `docs/security-audit-roadmap.md`, `docs/bug-roadmap.md`,
`SECURITY.md`, `BUGS.md`, or anything a `CLAUDE.md`/`AGENTS.md`/README points at as
the place security/bug findings are tracked. Also check whether such a doc has an
established ID scheme (e.g. `SEC-1`, `SEC-2`... or `BUG-1`, `BUG-2`...) and a
per-finding format (e.g. "Where / Attack / Fix / Verify" sections, a status line, a
severity tag).

**If tracking docs already exist:**
- **Append, don't replace.** Add new findings as new entries in the existing docs.
- **Continue the existing ID sequence** — if the doc's highest existing finding is
  `SEC-17`, new findings start at `SEC-18`, not a new/reset/differently-formatted ID
  scheme (no `SEC-001`, no separate "fresh" table). Same for bugs.
  Never restart numbering or invent a parallel scheme "for this scan" — there is one
  running sequence per doc, forever.
- **Match the existing entry format exactly** — same section headers, same voice, same
  level of detail (repro/attack description, step-by-step fix, verification step) as
  the entries already in the doc. Read a couple of existing entries first and mirror
  their shape.
- Every new finding is marked as its own open/unfixed status (matching however the
  doc marks that — e.g. `**Status: Open.**`), since this is a scan, not a fix pass.
- Update the doc's own top-of-file status/summary line (the running "what pass found
  what" narrative most of these docs keep) to mention the new pass and the new ID
  range it added, in the same voice as the existing history there.
- If the codebase has a completion tracker doc (something like
  `docs/open-roadmap-items.md`) that only records *finished* work, leave it alone —
  open findings don't belong there until they're fixed, matching how earlier passes
  in these docs were handled.

**If no tracking docs exist yet:** produce two markdown tables, `Bug Roadmap` and
`Security Audit Roadmap`, sorted by severity (highest first), with a fresh ID
sequence per table (`BUG-1`, `SEC-1`, ...):
- Bug Roadmap columns: `ID | File/Location | Description | Severity (Low/Med/High) | Suggested Fix | Status (default: Open)`
- Security Audit Roadmap columns: `ID | File/Location | Vulnerability Type | Description | Severity (Low/Med/High) | Suggested Fix | Status (default: Open)`
- Don't mix bugs and security issues in the same table.
- Ask whether I'd like these saved as permanent tracking docs in the repo (e.g.
  `docs/bug-roadmap.md` / `docs/security-audit-roadmap.md`) — if I say yes, save
  them in that same append-friendly shape (stable per-finding IDs, a status line,
  a top-of-file running history) so every future run of this command appends to them
  instead of starting over, per the rule above.

Do not fix anything during this pass unless I explicitly ask — this is a scan, not a
fix pass. Report/append the findings and stop.
