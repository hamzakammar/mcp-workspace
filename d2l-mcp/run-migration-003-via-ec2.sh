#!/bin/bash
set -euo pipefail
# Run migration 003 on RDS via EC2 bastion

if [ -z "${BASTION_HOST:-}" ]; then
  echo "❌ BASTION_HOST is not set. Usage: BASTION_HOST=<bastion-hostname-or-ip> [BASTION_USER=ec2-user] $0" >&2
  exit 1
fi

echo "🚀 Running migration 003 via EC2 bastion..."
echo ""

# Get RDS password from user or command line argument
if [ -z "${1:-}" ]; then
  read -rsp "Enter your RDS password: " RDS_PASSWORD
  echo ""
else
  RDS_PASSWORD="$1"
  echo "Using password from command line argument"
fi
if [ -z "${RDS_PASSWORD:-}" ]; then
  echo "❌ RDS password is required." >&2
  exit 1
fi

RDS_ENDPOINT="study-mcp-db.cunwmoma690l.us-east-1.rds.amazonaws.com"
EC2_HOST="${BASTION_USER:-ec2-user}@${BASTION_HOST}"
# Use the bastion key (same as RUN_MIGRATION_FINAL.sh)
if [ -f "$HOME/Downloads/study-mcp-bastion-key.pem" ]; then
  KEY_PATH="$HOME/Downloads/study-mcp-bastion-key.pem"
elif [ -f "$HOME/.ssh/PokeIntegrations.pem" ]; then
  KEY_PATH="$HOME/.ssh/PokeIntegrations.pem"
elif [ -f "$HOME/.ssh/PokeIntegrations" ]; then
  KEY_PATH="$HOME/.ssh/PokeIntegrations"
else
  echo "❌ SSH key not found. Tried:"
  echo "   - ~/Downloads/study-mcp-bastion-key.pem"
  echo "   - ~/.ssh/PokeIntegrations.pem"
  echo "   - ~/.ssh/PokeIntegrations"
  exit 1
fi

echo "Using SSH key: $KEY_PATH"

# Copy migration SQL to EC2
echo "📤 Copying migration SQL to EC2..."
scp -i "$KEY_PATH" src/study/db/migrations/003_add_token_column.sql "$EC2_HOST":~/ 2>/dev/null || {
  echo "⚠️  Could not copy file, will use inline SQL"
}

# Run migration via SSH
echo "🔧 Running migration on RDS..."
ssh -i "$KEY_PATH" "$EC2_HOST" << EOF
export RDS_PASSWORD="${RDS_PASSWORD}"
export RDS_ENDPOINT="${RDS_ENDPOINT}"

echo "Running migration 003..."
psql "postgresql://postgres:\${RDS_PASSWORD}@\${RDS_ENDPOINT}:5432/postgres?sslmode=require" << SQL
-- Add token column to user_credentials table
alter table public.user_credentials 
add column if not exists token text;

-- Make password nullable since we can now use tokens instead
alter table public.user_credentials 
alter column password drop not null;
SQL

if [ \$? -eq 0 ]; then
  echo ""
  echo "✅ Migration completed successfully!"
  echo ""
  echo "Verifying token column..."
  psql "postgresql://postgres:\${RDS_PASSWORD}@\${RDS_ENDPOINT}:5432/postgres?sslmode=require" \
    -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'user_credentials' AND column_name = 'token';"
else
  echo ""
  echo "❌ Migration failed. Check the error above."
fi
EOF
