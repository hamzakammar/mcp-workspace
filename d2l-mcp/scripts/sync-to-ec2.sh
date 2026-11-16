#!/bin/bash
# Sync all MCPs to EC2

set -e

if [ -z "${EC2_HOST:-}" ]; then
  echo "❌ EC2_HOST is not set. Usage: EC2_HOST=<ec2-hostname-or-ip> [EC2_USER=ec2-user] [SSH_KEY_PATH=~/.ssh/key] $0" >&2
  exit 1
fi
EC2_TARGET="${EC2_USER:-ec2-user}@${EC2_HOST}"
KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/PokeIntegrations}"

echo "🚀 Syncing MCP workspace to EC2..."

# Create workspace directory on EC2 if it doesn't exist
ssh -i "$KEY_PATH" "$EC2_TARGET" "mkdir -p ~/mcp-workspace"

# Sync entire workspace (excluding node_modules and sessions)
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.d2l-session' \
  --exclude '*.log' \
  --exclude '.git' \
  -e "ssh -i \"$KEY_PATH\"" \
  ../ "$EC2_TARGET":~/mcp-workspace/

echo ""
echo "✅ Workspace synced successfully!"
echo ""
echo "Next steps on EC2:"
echo "  ssh -i $KEY_PATH $EC2_TARGET"
echo "  cd ~/mcp-workspace"
echo "  npm run install-all"
echo "  npm run build-all"
echo "  npm run start-all"
