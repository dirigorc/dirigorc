#!/bin/sh
set -eu

: "${DISCORD_APPLICATION_ID:?Set DISCORD_APPLICATION_ID to the Discord app client ID.}"
: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN to the Discord bot token.}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID to the Dirigo server ID.}"

WORKER_DIR="${DISCORD_WORKER_DIR:-dirigo-email-ingest}"
WORKER_NAME="${DISCORD_WORKER_NAME:-dirigo-email-ingest}"

cd "$(dirname "$0")/.."

cd "$WORKER_DIR"
npx wrangler deploy --name "$WORKER_NAME"

cd ..

curl -sS -X POST "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "recap",
    "description": "Draft a Dirigo website update from recap text.",
    "type": 1,
    "options": [
      {
        "name": "body",
        "description": "Race recap or result notes to turn into a draft PR.",
        "type": 3,
        "required": true
      },
      {
        "name": "agentic",
        "description": "Set true to let the editor AI rewrite and structure the recap.",
        "type": 5,
        "required": false
      },
      {
        "name": "image1",
        "description": "Optional race image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image2",
        "description": "Optional second race image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image3",
        "description": "Optional third race image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image4",
        "description": "Optional fourth race image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image5",
        "description": "Optional fifth race image attachment.",
        "type": 11,
        "required": false
      }
    ]
  }' | jq