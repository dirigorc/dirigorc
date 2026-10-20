#!/bin/sh
set -eu

: "${DISCORD_APPLICATION_ID:?Set DISCORD_APPLICATION_ID to the Discord app client ID.}"
: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN to the Discord bot token.}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID to the Dirigo server ID.}"

WORKER_DIR="${DISCORD_WORKER_DIR:-dirigo-email-ingest}"
WORKER_NAME="${DISCORD_WORKER_NAME:-dirigo-email-ingest}"
COMMAND_SCOPE="${DISCORD_COMMAND_SCOPE:-guild}"
CONTRACT_FILE="${DISCORD_CONTRACT_FILE:-dirigo-email-ingest/discord-contract.json}"
LAST_COMMAND_ERROR_CODE=0

# Touch this file to trigger Discord command deployment after workflow changes.

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
  list_file="$(mktemp)"
  api_get "$endpoint" > "$list_file"
  jq -r '.commands[].name' "$CONTRACT_FILE" | while IFS= read -r command_name; do
    [ -n "$command_name" ] || continue
    jq -r --arg name "$command_name" '.[] | select(.name == $name) | .id' "$list_file" | while IFS= read -r command_id; do
      [ -n "$command_id" ] || continue
      api_delete "${endpoint}/${command_id}"
    done
  done
  rm -f "$list_file"
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
  lines_file="$(mktemp)"
  jq -c '.commands[].registration' "$CONTRACT_FILE" > "$lines_file"
  status=0
  while IFS= read -r registration || [ -n "$registration" ]; do
    [ -n "$registration" ] || continue
    payload_file="$(mktemp)"
    printf '%s\n' "$registration" > "$payload_file"
    if ! create_command "$endpoint" "$payload_file"; then
      status=1
      rm -f "$payload_file"
      break
    fi
    rm -f "$payload_file"
  done < "$lines_file"
  rm -f "$lines_file"
  return "$status"
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
