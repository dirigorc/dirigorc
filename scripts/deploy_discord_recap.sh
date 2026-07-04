#!/bin/sh
set -eu

: "${DISCORD_APPLICATION_ID:?Set DISCORD_APPLICATION_ID to the Discord app client ID.}"
: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN to the Discord bot token.}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID to the Dirigo server ID.}"

WORKER_DIR="${DISCORD_WORKER_DIR:-dirigo-email-ingest}"
WORKER_NAME="${DISCORD_WORKER_NAME:-dirigo-email-ingest}"
COMMAND_SCOPE="${DISCORD_COMMAND_SCOPE:-guild}"
LAST_COMMAND_ERROR_CODE=0

cd "$(dirname "$0")/.."

cd "$WORKER_DIR"
npx wrangler deploy --name "$WORKER_NAME"

cd ..

create_command() {
  endpoint="$1"
  response_file="$(mktemp)"
  http_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "https://discord.com/api/v10${endpoint}" \
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
  }')"

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    cat "$response_file" | jq
    rm -f "$response_file"
    LAST_COMMAND_ERROR_CODE=0
    return 0
  fi

  if jq -e '.code == 50001' "$response_file" >/dev/null 2>&1; then
    LAST_COMMAND_ERROR_CODE=50001
    rm -f "$response_file"
    return 1
  fi

  cat "$response_file" | jq
  rm -f "$response_file"
  LAST_COMMAND_ERROR_CODE="$http_code"
  return 1
}

if [ "$COMMAND_SCOPE" = "global" ]; then
  create_command "/applications/${DISCORD_APPLICATION_ID}/commands"
else
  if create_command "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"; then
    exit 0
  fi

  if [ "$LAST_COMMAND_ERROR_CODE" -eq 50001 ]; then
    echo "Guild registration returned Discord Missing Access (50001). Falling back to a global command registration." >&2
    if create_command "/applications/${DISCORD_APPLICATION_ID}/commands"; then
      exit 0
    fi
    exit 1
  fi

  exit 1
fi