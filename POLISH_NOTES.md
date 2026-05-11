# Horizon App — Polish Notes (App Store Readiness Pass)

**Date:** 2026-03-10  
**Purpose:** Pre-app-store polish pass to fix TypeScript issues, dead code, UX issues, and store metadata.

---

## Changes Made

### 1. `src/services/auth.ts` — Added missing methods
Added `confirmSignUp(email, code)` and `resendConfirmationCode(email)` to the `AuthService` class. These are referenced by `VerifyEmailScreen.tsx` and were causing TypeScript compilation errors. Uses `supabase.auth.verifyOtp` and `supabase.auth.resend` respectively.

### 2. Deleted dead/stub screens
- `src/screens/D2LLoginScreen.tsx` — empty stub, not in navigator
- `src/screens/PiazzaLoginScreen.tsx` — empty stub, not in navigator
- `src/screens/ProfileScreen.tsx` — empty stub, not in navigator
- `src/screens/NotesUploadScreen.tsx` — old upload screen superseded by `UploadScreen.tsx`

### 3. Deleted unused navigation files
Confirmed `App.tsx` only imports `AppNavigator`. Deleted:
- `src/navigation/MainTabs.tsx` — old 6-tab nav
- `src/navigation/HomeStack.tsx` — referenced CoursesScreen, unused
- `src/navigation/DashboardStack.tsx` — double-wraps navigator, unused
- `src/navigation/AuthStack.tsx` — superseded by AppNavigator

### 4. `src/navigation/AppNavigator.tsx` — Header & tab label fixes
- Changed Dashboard tab label from `"Dashboard"` to `"Home"` (mobile convention)
- Set `headerShown: false` for Dashboard, Notes, Search, Settings (all have their own SafeAreaView + custom headers)
- Kept `headerShown: true` for Integrations (no custom header)
- This fixes the double header issue on Dashboard/Notes/Search/Settings

### 5. `app.json` — App store metadata
- `name`: `"study-mcp-app"` → `"Horizon"`
- `slug`: `"study-mcp-app"` → `"horizon"`
- `scheme`: `"study-mcp"` → `"horizon"`
- `ios.bundleIdentifier`: `"com.studymcp.app"` → `"ca.hamzaammar.horizon"`
- `android.package`: `"com.studymcp.app"` → `"ca.hamzaammar.horizon"`
- Added `ios.infoPlist` with required iOS privacy descriptions:
  - `NSPhotoLibraryUsageDescription`
  - `NSCameraUsageDescription`
  - `NSMicrophoneUsageDescription`

### 6. `src/screens/Auth/LoginScreen.tsx` — Branding + Forgot Password
- Changed title color from `#1e293b` (dark) to `#6366f1` (indigo) for brand identity
- Removed unused `authService` import
- Added `import { supabase } from '../../lib/supabase'`
- Added `handleForgotPassword` function using `supabase.auth.resetPasswordForEmail`
- Added "Forgot Password?" touchable link below Sign In button

### 7. `src/screens/Auth/SignUpScreen.tsx` — Branding
- Changed title color from `#1e293b` to `#6366f1` (matches Login screen)
- Removed unused `authService` import

### 8. `src/screens/SettingsScreen.tsx` — Icon fix
- Fixed invalid AntDesign icon name `"file-text"` → `"filetext1"`

### 9. `src/screens/DashboardScreen.tsx` — Remove prominent Logout button
- Removed the Logout button from the dashboard header (it's already in Settings)
- Removed `logout` from the `useAuth()` destructuring (no longer needed in this screen)
- Removed unused `logoutButton` and `logoutText` style definitions

---

## Files Changed
- `src/services/auth.ts`
- `src/navigation/AppNavigator.tsx`
- `src/screens/Auth/LoginScreen.tsx`
- `src/screens/Auth/SignUpScreen.tsx`
- `src/screens/SettingsScreen.tsx`
- `src/screens/DashboardScreen.tsx`
- `app.json`

## Files Deleted
- `src/screens/D2LLoginScreen.tsx`
- `src/screens/PiazzaLoginScreen.tsx`
- `src/screens/ProfileScreen.tsx`
- `src/screens/NotesUploadScreen.tsx`
- `src/navigation/MainTabs.tsx`
- `src/navigation/HomeStack.tsx`
- `src/navigation/DashboardStack.tsx`
- `src/navigation/AuthStack.tsx`

---

## ECS Backend Migration — API Client (2026-03-11)

### What Changed

1. **`study-mcp-app/src/config/api.ts`** — Replaced Supabase Edge Functions client with a direct `fetch`-based client pointing at `https://api.hamzaammar.ca/api`. The interface is fully backward-compatible (`get`, `post`, `delete`, `invoke`).

2. **`d2l-mcp/src/api/auth.ts`** — Updated auth middleware to accept both Cognito JWTs (existing) AND Supabase HS256 JWTs (new). Verification order:
   - If `COGNITO_USER_POOL_ID` + `COGNITO_CLIENT_ID` are set → try Cognito first
   - If Cognito not configured or fails → try Supabase JWT using `SUPABASE_JWT_SECRET`
   - If neither → 401

3. **`study-mcp-app/src/services/d2l.ts`** — Removed stale `import { supabase } from './supabase'` (wrong relative path, unused).

4. **`study-mcp-app/src/screens/Auth/D2LWebViewScreen.tsx`** — Replaced `supabase.functions.invoke('study-logic/d2l/sync', ...)` with `apiClient.post('/d2l/sync', { action: 'sync_d2l', host, cookies })`.

5. **`study-mcp-app/src/navigation/AppNavigator.tsx`** — Added `CourseDetail` screen to the root stack navigator so it's navigable from `CoursesScreen`.

---

### ⚠️ Manual Steps Required (Owner Action)

The ECS backend now supports Supabase JWT verification, but needs `SUPABASE_JWT_SECRET` injected as an environment variable. Without this, Supabase-signed JWTs will be rejected with a 503.

#### Step 1: Get your Supabase JWT Secret

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Open your project → **Settings** → **API**
3. Scroll to **JWT Settings** → copy the **JWT Secret** (not the anon/service keys)

#### Step 2: Store it in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name "study-mcp/supabase-jwt-secret" \
  --secret-string "YOUR_SUPABASE_JWT_SECRET_HERE" \
  --region us-east-1
```

Note the ARN returned — it will look like:
`arn:aws:secretsmanager:us-east-1:051140201449:secret:study-mcp/supabase-jwt-secret-XXXXXX`

#### Step 3: Add to ECS Task Definition

In your task definition JSON (under `containerDefinitions[0].secrets`), add:

```json
{
  "name": "SUPABASE_JWT_SECRET",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:051140201449:secret:study-mcp/supabase-jwt-secret-XXXXXX"
}
```

Replace the ARN with the one from Step 2.

#### Step 4: Grant ECS Task Role access to the secret

Ensure the ECS task execution role has this IAM permission:

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:us-east-1:051140201449:secret:study-mcp/supabase-jwt-secret-*"
}
```

#### Step 5: Redeploy ECS service

```bash
# Register updated task definition
aws ecs register-task-definition --cli-input-json file://task-definition.json --region us-east-1

# Update service to use new task def
aws ecs update-service \
  --cluster study-mcp-cluster \
  --service study-mcp-service \
  --task-definition study-mcp-server \
  --force-new-deployment \
  --region us-east-1
```

#### Step 6: Verify

```bash
# Should return 401 (not 503) — confirming Supabase JWT auth is active
curl -H "Authorization: Bearer fake-token" https://api.hamzaammar.ca/api/notes
```

---

- `SearchScreen.tsx` is kept as a dedicated search tab — the tab order is Dashboard/Notes/Search/Sync/Settings
- The bundle identifiers (`ca.hamzaammar.horizon`) need to be registered in App Store Connect and Google Play Console before submission
- All asset paths in app.json are valid (icon.png, splash-icon.png, adaptive-icon.png, favicon.png all exist in `assets/`)
