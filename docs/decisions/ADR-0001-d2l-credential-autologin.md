# ADR-0001: D2L credential storage for auto-relogin — KMS per-user binding; filler isolation deferred

> **Status:** accepted — Option B shipped & verified in prod 2026-10-24 (task def rev 147); Option C (filler isolation) deferred to DEBT-015
> **Date:** 2026-10-24
> **Author(s):** agent (investigation requested by owner; Ali's daily-reconnect pain)

---

## Context

D2L sessions expire roughly daily; Duo's "remember this device" cookie lasts ~25 days
(`STORAGE_STATE_MAX_AGE_DAYS`). Reconnecting is a manual VNC login. To reduce that chore,
the backend can store a user's WatIAM username/password and run a **headless** Playwright
login (`sessionRefresher.ts:attemptCredentialLogin`, `auth.ts:attemptSilentReloginOnce`) that
reuses the stored S3 Duo cookie and **bails to `duo_required` the moment Duo appears** (it never
pushes Duo in headless mode). This engine already exists and is Duo-safe.

Credential capture also already exists: `POST /api/d2l/save-credentials` (and `/d2l/connect`),
called from the onboarding page. Important properties of the current path:
- It is a **REST route, not an MCP tool** — the password reaches the Node backend but **never the
  LLM/model/MCP layer**.
- The password is **KMS-encrypted at rest** (`enc:kms:v1:…`), the event is audit-logged
  (`credential_access_log`), only `userId` is logged, HTTPS throughout, and there is **no Playwright
  tracing / HAR / screenshot capture** anywhere in `src/` (verified) — so the common trace/screenshot
  leak path is absent.

Residual gaps (the reason for this ADR):
1. KMS `Encrypt`/`Decrypt` used **no EncryptionContext**, so a ciphertext was not cryptographically
   bound to its owning user, and KMS calls weren't tagged for CloudTrail anomaly detection.
2. The backend that serves the LLM/MCP tools **also holds `kms:Decrypt`** and sees the plaintext at
   fill-time. A vault/KMS protects a database leak but **not** a live compromise of that host — an
   attacker with code-exec there can call the same decrypt path (owner's explicit concern).
3. UX: saving a login was only offered in first-time onboarding, not on the daily dashboard reconnect
   Ali actually uses.

Industry framing (Meta Muse, 1Password Agentic Autofill, browser-use `sensitive_data`): the strong
move is to **isolate the credential filler from the agent process** and/or **not store the password at
all** (reuse human-established session cookies). Duo (push-based) has no safely-storable TOTP seed, so
**human-in-the-loop remains the right answer for MFA** — which the VNC flow already provides.

---

## Decision

Keep storing the D2L password (opt-in) to enable headless auto-relogin, but harden and smooth the
**existing** path rather than build a new one:

1. **Now (this ADR's branch, `feat/harden-save-credentials`):** bind every stored D2L password to its
   owner with a KMS **EncryptionContext** `{ userId, purpose: "d2l_password" }` (backward-compatible:
   legacy rows decrypt via an unbound fallback and re-encrypt-with-context on next save). Offer the
   save-login opt-in on the dashboard reconnect path too, with explicit consent copy stating the AI
   never sees the password. No deploy without owner approval (changes the prod crypto path).

2. **Next (deferred, see DEBT-015):** isolate the decrypt-and-fill step into a separate least-privilege
   worker/role so the LLM/MCP-serving process never holds `kms:Decrypt` or plaintext. Evaluate
   preferring session-cookie reuse over storing the password where the refresh path already suffices.

---

## Options Considered

### Option A: Status quo (store KMS-encrypted password, same process)
- **Pros:** already built; model never sees it; survives DB leak.
- **Cons:** no per-user binding; LLM-serving host can decrypt → live-compromise exposure.

### Option B: KMS per-user EncryptionContext + UX smoothing *(chosen for now)*
- **Pros:** cross-user ciphertext reuse rejected by KMS; CloudTrail-auditable context; backward-compatible;
  small, reversible; directly cuts Ali's daily manual reconnect.
- **Cons:** does **not** remove live server-compromise risk (same host still decrypts).

### Option C: Isolate the credential filler (separate worker/role, optionally Nitro Enclave) *(deferred)*
- **Pros:** the model/MCP process loses decrypt rights and never holds plaintext — the real structural win.
- **Cons:** larger; new deploy unit/IAM; needs design + owner approval.

### Option D: Don't store the password — rely on session-cookie reuse, prompt only on failure *(partial)*
- **Pros:** minimizes stored secret material.
- **Cons:** daily auto-reconnect still needs the password while the ~monthly Duo cookie is valid, so it
  doesn't fully remove the chore on its own.

---

## Rationale

Option B is the smallest change that measurably improves security (per-user AAD binding + audit) and
smoothness (daily-path opt-in) without destabilizing a working prod path, and it's backward-compatible.
It deliberately does **not** claim to solve live server compromise — that's Option C, which is a real
architecture change the owner should approve explicitly (DEBT-015). Duo stays human-in-the-loop.

---

## Consequences

- **Positive:** stolen D2L ciphertext can't be decrypted as another user; KMS calls are attributable;
  Ali can enable auto-reconnect from the page he already uses; clearer consent.
- **Negative / trade-offs:** server-compromise risk remains until Option C; legacy rows stay unbound
  until their next save; EncryptionContext is only applied to D2L (piazza/outline unchanged for now).
- **Debt introduced:** DEBT-015 (isolate the credential filler) and DEBT-016 (VNC reconnect auto-close
  loading race — partially mitigated on the dashboard path, onboarding path still lacks retry UI).

---

## References
- Related debt: `docs/debt.md` DEBT-007 (credential hygiene), DEBT-015, DEBT-016.
- Code: `src/utils/kms.ts` (`encryptPassword`/`decryptPassword`/`d2lPasswordContext`),
  `src/api/routes.ts` (`/d2l/save-credentials`, `/d2l/connect`), `src/auth.ts` (`getD2LCredentials`),
  `src/jobs/sessionRefresher.ts` (`attemptCredentialLogin`), `src/public/onboard.html`.
- External: Meta Muse security approach; 1Password + Browserbase Agentic Autofill; browser-use
  `sensitive_data`; AWS KMS EncryptionContext / threat model.
