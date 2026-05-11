# AWS Deployment Checklist

## Step 1: Database Migration (Required First)

### Add `device_tokens` table to RDS

You're using **AWS RDS PostgreSQL** (`study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com`), so run the migration via your EC2 bastion:

#### Via EC2 Bastion (Your Setup)

Based on your existing migration scripts, use your EC2 bastion:

```bash
cd d2l-mcp

# Use your existing bastion setup (same as run-migration-003-via-ec2.sh)
# Your bastion: ec2-user@44.201.36.38
# Key: ~/Downloads/study-mcp-bastion-key.pem or ~/.ssh/PokeIntegrations.pem

# Option 1: Create a migration script (recommended)
cat > /tmp/add_device_tokens.sql << 'SQL'
-- =========================================================
-- 7) DEVICE TOKENS (Push Notifications)
-- =========================================================
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_token text not null,
  platform text not null, -- 'ios' | 'android'
  updated_at timestamptz not null default now(),
  
  constraint device_tokens_user_token_unique unique (user_id, device_token)
);

create index if not exists idx_device_tokens_user on public.device_tokens(user_id);
create index if not exists idx_device_tokens_platform on public.device_tokens(platform);

drop trigger if exists set_device_tokens_updated_at on public.device_tokens;
create trigger set_device_tokens_updated_at
before update on public.device_tokens
for each row execute function public.set_updated_at();

alter table public.device_tokens disable row level security;
SQL

# Copy to EC2 bastion
scp -i ~/.ssh/PokeIntegrations.pem /tmp/add_device_tokens.sql ec2-user@44.201.36.38:~/

# Run on RDS via bastion
read -sp "Enter your RDS password: " RDS_PASSWORD
echo ""

ssh -i ~/.ssh/PokeIntegrations.pem ec2-user@44.201.36.38 << EOF
export PGPASSWORD='${RDS_PASSWORD}'
psql -h study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com \
     -U postgres \
     -d postgres \
     -f ~/add_device_tokens.sql \
     --set=sslmode=require
EOF
```

**Or inline SQL (if you prefer):**

```bash
read -sp "Enter your RDS password: " RDS_PASSWORD
echo ""

ssh -i ~/.ssh/PokeIntegrations.pem ec2-user@44.201.36.38 << EOF
export PGPASSWORD='${RDS_PASSWORD}'
psql "postgresql://postgres:\${PGPASSWORD}@study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=require" << SQL
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_token text not null,
  platform text not null,
  updated_at timestamptz not null default now(),
  constraint device_tokens_user_token_unique unique (user_id, device_token)
);
create index if not exists idx_device_tokens_user on public.device_tokens(user_id);
create index if not exists idx_device_tokens_platform on public.device_tokens(platform);
drop trigger if exists set_device_tokens_updated_at on public.device_tokens;
create trigger set_device_tokens_updated_at
before update on public.device_tokens
for each row execute function public.set_updated_at();
alter table public.device_tokens disable row level security;
SQL
EOF
```

```sql
-- =========================================================
-- 7) DEVICE TOKENS (Push Notifications)
-- =========================================================
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_token text not null,
  platform text not null, -- 'ios' | 'android'
  updated_at timestamptz not null default now(),
  
  constraint device_tokens_user_token_unique unique (user_id, device_token)
);

create index if not exists idx_device_tokens_user on public.device_tokens(user_id);
create index if not exists idx_device_tokens_platform on public.device_tokens(platform);

drop trigger if exists set_device_tokens_updated_at on public.device_tokens;
create trigger set_device_tokens_updated_at
before update on public.device_tokens
for each row execute function public.set_updated_at();

alter table public.device_tokens disable row level security;
```

**Verify**: Check that the table was created successfully:

```bash
# Via EC2 bastion
ssh -i ~/.ssh/PokeIntegrations.pem ec2-user@44.201.36.38 << EOF
export PGPASSWORD='${RDS_PASSWORD}'
psql -h study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com \
     -U postgres \
     -d postgres \
     -c "\d device_tokens" \
     --set=sslmode=require
EOF
```

You should see the table structure with columns: `id`, `user_id`, `device_token`, `platform`, `updated_at`.

---

## Step 2: Deploy Backend to AWS ECS

### Deploy to ECS Fargate

```bash
cd d2l-mcp
./scripts/deploy-to-ecs.sh
```

**What this does:**
- Builds TypeScript
- Builds and pushes Docker image to ECR (`051140201449.dkr.ecr.us-east-1.amazonaws.com/study-mcp-backend`)
- Forces new ECS deployment in `study-mcp-cluster`

**Wait for deployment to complete** (check AWS ECS console or logs)

**Verify deployment:**
```bash
# Check service status
aws ecs describe-services \
  --cluster study-mcp-cluster \
  --services study-mcp-backend \
  --region us-east-1

# Check logs for errors
aws logs tail /ecs/study-mcp-backend --follow --region us-east-1

# Or check in AWS Console:
# ECS → Clusters → study-mcp-cluster → Services → study-mcp-backend
```

**Note**: Make sure your ECS task has the required environment variables:
- `DATABASE_URL` (RDS connection string from Secrets Manager) **OR**
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (if using Supabase instead)
- `AWS_REGION` (us-east-1)
- `S3_BUCKET` (your S3 bucket name)
- `OPENAI_API_KEY` (for embeddings)

---

## Step 3: Mobile App Setup

### Install Dependencies

```bash
cd study-mcp-app
npm install
```

This installs:
- `expo-notifications` - Push notifications
- `expo-device` - Device detection

### Rebuild the App (Required - Native Modules Added)

Since we added native modules (`expo-notifications`), you **must rebuild** the app:

**For iOS (Physical Device):**
```bash
cd study-mcp-app
npx expo run:ios --configuration Release --device "Your Device Name"
```

**For Android:**
```bash
cd study-mcp-app
npx expo run:android --configuration Release
```

**Note**: This will take 5-10 minutes. The app will be installed automatically on your device.

---

## Step 4: Push Notifications Setup (Optional but Recommended)

### For Development (Current Setup)
- Push notifications will work on physical devices
- Uses Expo's free push notification service
- No additional configuration needed

### For Production (Future)
If you want to use push notifications in production builds:

1. **Set up EAS (Expo Application Services)**:
   ```bash
   npm install -g eas-cli
   eas login
   eas build:configure
   ```

2. **Configure push notifications**:
   - iOS: Requires Apple Developer account and APNs certificates
   - Android: Uses FCM (Firebase Cloud Messaging)

3. **Build with EAS**:
   ```bash
   eas build --platform ios
   eas build --platform android
   ```

**For now, you can skip this** - push notifications will work in development builds on physical devices.

---

## Step 5: Test Everything

### Test Checklist

#### 1. Push Notifications
- [ ] Open the app on your device
- [ ] Check that notification permission is requested
- [ ] Verify device token is registered (check backend logs)
- [ ] Test by calling `/api/push/sync` endpoint manually (or wait for cron job)

#### 2. Grades View
- [ ] Navigate to a course
- [ ] Tap "Grades" tab
- [ ] Verify grades display correctly
- [ ] Check empty state if no grades

#### 3. Note Upload
- [ ] Go to Notes screen
- [ ] Tap "Upload"
- [ ] Select a PDF file
- [ ] Choose a course from dropdown
- [ ] Upload and verify processing completes
- [ ] Check that note appears in Notes list

#### 4. Note Search
- [ ] Go to Notes screen
- [ ] Type a search query
- [ ] Verify results appear
- [ ] Check that results show relevance scores

#### 5. Piazza Integration
- [ ] Go to Settings
- [ ] Verify Piazza connection status shows
- [ ] Check that "Sync Now" button works
- [ ] Verify classes count displays (if synced)

---

## Step 6: Set Up Push Notification Polling on AWS (Optional)

To automatically check for updates and send notifications, set up AWS EventBridge:

### Option A: AWS EventBridge + Lambda (Recommended)

1. **Create a Lambda function** that calls your API:
   ```python
   import requests
   import os
   
   def lambda_handler(event, context):
       api_url = os.environ['API_URL']  # https://api.hamzaammar.ca
       # Call /api/push/sync endpoint
       # Note: You'll need to handle auth (Cognito token or API key)
   ```

2. **Create EventBridge rule** to trigger every hour:
   ```bash
   aws events put-rule \
     --name study-mcp-push-sync \
     --schedule-expression "rate(1 hour)" \
     --region us-east-1
   
   aws events put-targets \
     --rule study-mcp-push-sync \
     --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:ACCOUNT:function:push-sync"
   ```

### Option B: ECS Scheduled Task

Create an ECS scheduled task that runs periodically:
- Use AWS EventBridge to trigger ECS task
- Task runs your backend code to check for updates

### Option C: Manual Testing
You can manually trigger push notification checks:

```bash
# Using curl (replace with your API URL and Cognito token)
curl -X POST https://api.hamzaammar.ca/api/push/sync \
  -H "Authorization: Bearer YOUR_COGNITO_TOKEN"
```

---

## Troubleshooting

### Push Notifications Not Working?
1. **Check device token registration**:
   - Look for `[PUSH] Device token registered successfully` in app logs
   - Check `device_tokens` table in Supabase (via Supabase dashboard)

2. **Verify permissions**:
   - iOS: Settings > Your App > Notifications (must be enabled)
   - Android: Should be automatic

3. **Check AWS ECS backend logs**:
   ```bash
   aws logs tail /ecs/study-mcp-backend --follow --region us-east-1
   ```
   
4. **Verify RDS connection**:
   - Check that `DATABASE_URL` is set in ECS task definition (or `SUPABASE_URL` if using Supabase)
   - Verify in AWS Secrets Manager that secrets exist
   - Check RDS security group allows connections from ECS task
   - Verify RDS endpoint: `study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com`

### Grades Not Showing?
- Verify D2L connection is active
- Check that course ID is correct
- Look for errors in backend logs

### Note Upload Failing?
- **Check S3 configuration** in ECS task:
  - `AWS_REGION` (e.g., `us-east-1`)
  - `S3_BUCKET` (your S3 bucket name)
- **Verify S3 bucket exists** and has correct permissions:
  ```bash
  aws s3 ls s3://your-bucket-name
  ```
- **Check IAM role** for ECS task has S3 read/write permissions
- Verify file is PDF format
- Check AWS ECS backend logs for processing errors:
  ```bash
  aws logs tail /ecs/study-mcp-backend --follow --region us-east-1
  ```

### Search Not Working?
- Ensure notes have been processed and embedded
- Check that `/api/notes/embed-missing` was called if needed
- Verify OpenAI API key is configured

---

## Summary

**Quick Start (AWS):**
1. ✅ Run database migration in Supabase SQL Editor (device_tokens table)
2. ✅ Deploy backend to ECS: `cd d2l-mcp && ./scripts/deploy-to-ecs.sh`
3. ✅ Wait for ECS deployment (check AWS Console)
4. ✅ Install mobile deps: `cd study-mcp-app && npm install`
5. ✅ Rebuild app: `npx expo run:ios --configuration Release --device "Your Device"`
6. ✅ Test all features

**AWS Resources Used:**
- **ECS Fargate**: `study-mcp-cluster` / `study-mcp-backend`
- **ECR**: `051140201449.dkr.ecr.us-east-1.amazonaws.com/study-mcp-backend`
- **RDS PostgreSQL**: `study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com` (with pgvector)
- **EC2 Bastion**: For secure RDS access (if RDS is private)
- **S3**: PDF storage
- **Cognito**: Authentication
- **Secrets Manager**: Environment variables (DATABASE_URL, etc.)

**Estimated Time:** 15-20 minutes (mostly waiting for ECS deployment and app rebuild)
