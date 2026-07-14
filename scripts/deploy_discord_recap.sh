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

api_get() {
  endpoint="$1"
  curl -sS -X GET "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
}

api_delete() {
  endpoint="$1"
  curl -sS -X DELETE "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" >/dev/null
}

cleanup_dirigo_commands() {
  endpoint="$1"
  api_get "$endpoint" | jq -r '.[] | select(.name == "recap" or .name == "event") | .id' | while IFS= read -r command_id; do
    [ -n "$command_id" ] || continue
    api_delete "${endpoint}/${command_id}"
  done
}

create_command() {
  endpoint="$1"
  payload_file="$2"
  response_file="$(mktemp)"
  http_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}")"

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

create_commands() {
  endpoint="$1"
  recap_payload="$(mktemp)"
  event_payload="$(mktemp)"

  cat > "$recap_payload" <<'JSON'
{
    "name": "recap",
    "description": "Draft a Dirigo website update from recap text.",
    "type": 1,
    "options": [
      {
        "name": "body",
        "description": "Optional inline recap text (leave empty to use modal).",
        "type": 3,
        "required": false
      },
      {
        "name": "polish",
        "description": "Set true to have Copilot polish and structure your recap.",
        "type": 5,
        "required": false
      },
      {
        "name": "links",
        "description": "Optional source URLs separated by spaces or new lines.",
        "type": 3,
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
}
JSON

  cat > "$event_payload" <<'JSON'
{
    "name": "event",
    "description": "Draft a Dirigo calendar event from upcoming-event details.",
    "type": 1,
    "options": [
      {
        "name": "body",
        "description": "Upcoming race, group run, meet, deadline, or team date details.",
        "type": 3,
        "required": true
      },
      {
        "name": "links",
        "description": "Optional event, registration, results, or photo URLs.",
        "type": 3,
        "required": false
      },
      {
        "name": "image1",
        "description": "Optional event image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image2",
        "description": "Optional second event image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image3",
        "description": "Optional third event image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image4",
        "description": "Optional fourth event image attachment.",
        "type": 11,
        "required": false
      },
      {
        "name": "image5",
        "description": "Optional fifth event image attachment.",
        "type": 11,
        "required": false
      }
    ]
}
JSON

  if create_command "$endpoint" "$recap_payload" && create_command "$endpoint" "$event_payload"; then
    rm -f "$recap_payload" "$event_payload"
    return 0
  fi

  rm -f "$recap_payload" "$event_payload"
  return 1
}

if [ "$COMMAND_SCOPE" = "global" ]; then
  cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"
  cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/commands"
  create_commands "/applications/${DISCORD_APPLICATION_ID}/commands"
else
  cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/commands"
  cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"
  if create_commands "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"; then
    exit 0
  fi

  if [ "$LAST_COMMAND_ERROR_CODE" -eq 50001 ]; then
    echo "Guild registration returned Discord Missing Access (50001). Falling back to a global command registration." >&2
    if create_commands "/applications/${DISCORD_APPLICATION_ID}/commands"; then
      exit 0
    fi
    exit 1
  fi

  exit 1
fi
