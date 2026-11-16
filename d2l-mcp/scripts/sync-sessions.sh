#!/bin/bash
# Sync browser sessions from local to EC2

set -e

if [ -z "${EC2_HOST:-}" ]; then
  echo "❌ EC2_HOST is not set. Usage: EC2_HOST=<ec2-hostname-or-ip> [EC2_USER=ec2-user] [SSH_KEY_PATH=~/.ssh/key] $0" >&2
  exit 1
fi
EC2_TARGET="${EC2_USER:-ec2-user}@${EC2_HOST}"
KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/PokeIntegrations}"

echo "🔐 Syncing browser sessions to EC2..."

# Sync D2L session if it exists
if [ -d ~/.d2l-session ]; then
  echo "📦 Packaging D2L session..."
  tar --exclude='.DS_Store' -czf /tmp/d2l-session.tar.gz -C ~ .d2l-session/
  
  echo "⬆️  Uploading to EC2..."
  rsync -avz -e "ssh -i \"$KEY_PATH\"" /tmp/d2l-session.tar.gz "$EC2_TARGET":~/
  
  echo "📂 Extracting on EC2..."
  ssh -i "$KEY_PATH" "$EC2_TARGET" "cd ~ && tar -xzf d2l-session.tar.gz && rm d2l-session.tar.gz"
  
  rm /tmp/d2l-session.tar.gz
  echo "✅ D2L session synced!"
else
  echo "⚠️  No D2L session found. Run: npm run build && npm run auth"
fi

# Add more session syncs here for other MCPs
# Example:
# if [ -d ~/.another-mcp-session ]; then
#   tar -czf /tmp/another-session.tar.gz -C ~ .another-mcp-session/
#   rsync -avz -e "ssh -i \"$KEY_PATH\"" /tmp/another-session.tar.gz "$EC2_TARGET":~/
#   ssh -i "$KEY_PATH" "$EC2_TARGET" "cd ~ && tar -xzf another-session.tar.gz"
#   rm /tmp/another-session.tar.gz
# fi

echo ""
echo "✅ All sessions synced!"
