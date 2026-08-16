# Dirigo RC Website

Static website for Dirigo RC, served with GitHub Pages and lightly powered by Jekyll.

Most pages are plain HTML/CSS. Jekyll is currently used for the updates feed and calendar:

- Homepage shows the newest update posts from `_posts/`.
- `/updates/` shows the paginated update archive using `jekyll-paginate`.
- `/updates/tags/.../` pages show updates for a single tag.
- `/calendar/` shows upcoming races, series, and club-relevant dates from `_events/`.
- `_includes/update-item.html` controls how each update card renders.

## Run Locally

GitHub Pages runs Jekyll automatically when the site is deployed. To preview the same kind of build locally, use Ruby `3.1.6`, which is pinned in `.ruby-version`.

Avoid Apple's system Ruby and avoid Homebrew's newest Ruby 4 for this project. GitHub Pages currently pins an older Jekyll/Liquid stack, and Ruby 4 removes APIs that stack still calls.

Install Ruby with `rbenv`:

```sh
brew install rbenv ruby-build
rbenv install 3.1.6
rbenv local 3.1.6
ruby -v
```

Then install Bundler and the project gems:

```sh
gem install bundler -v 2.6.9
bundle install
```

If Bundler complains about `bundler (= 4.0.15)`, delete the stale Ruby-4-generated lockfile and reinstall under Ruby 3.1 with Bundler 2:

```sh
rm Gemfile.lock
ruby -v
gem install bundler -v 2.6.9
bundle _2.6.9_ install
```

The `Gemfile` uses the `github-pages` gem to mirror the GitHub Pages build environment.

Run the local server (this refreshes image dimensions before Jekyll starts):

```sh
make serve
```

Then open:

```text
http://127.0.0.1:4000/
```

## Add A Club Update

Create a new Markdown file in `_posts/` using this naming pattern:

```text
YYYY-MM-DD-short-title.md
```

Example:

```text
_posts/2026-07-03-beach-to-beacon-preview.md
```

Use front matter like this:

```yaml
---
title: Beach to Beacon crew gets ready.
date: 2026-07-03
category: Club Notes
layout_style: single
image:
  src: assets/images/example.jpg
  alt: Dirigo runners warming up before a road race.
summary: A short public-facing recap or preview goes here. Keep it punchy and factual.
tags:
  - Beach to Beacon
  - Dirigo
links:
  - label: Race details
    url: https://example.com/
---
```

The homepage automatically shows recent updates by post date. The full archive is paginated at `/updates/`.

When adding new tags, generate a matching page under `updates/tags/tag-slug/index.html` so inline tag links have somewhere to go.

Use `_events/` for future races, recurring series, and actionable calendar items. Updates should be the lasting record of results, recaps, club notes, and archives.

## Add A Calendar Event

Create a new Markdown file in `_events/` using this naming pattern:

```text
YYYY-MM-DD-short-title.md
```

Example:

```text
_events/2026-08-01-beach-to-beacon.md
```

Use front matter like this:

```yaml
---
title: TD Beach to Beacon 10K
date: 2026-08-01
time: 8:00 AM
type: Race
location: Cape Elizabeth, ME
summary: Maine's marquee summer 10K and a recurring Dirigo measuring stick.
team_note: One of the most visible annual chances to wear the blue in Maine road racing.
event_url: https://example.com/
registration_url: https://example.com/register
recurrence: Optional recurrence note, such as Wednesdays through August
tags:
  - Beach to Beacon
links:
  - label: Extra context
    url: https://example.com/
---
```

Use `end_date` for date ranges or recurring series:

```yaml
date: 2026-07-08
end_date: 2026-08-26
recurrence: Wednesdays through August 26
```

The calendar page automatically sorts events by `date`. Passed events move into the recent calendar history section.

Useful optional fields:

- `team_note`: Dirigo-specific context for why the event matters to the team.
- `event_url`, `registration_url`, `results_url`: Structured links that the calendar renders consistently.
- `image` and `image_credit`: Optional event image and public credit.

## Update Layout Options

Use `layout_style: single` for one large image:

```yaml
layout_style: single
image:
  src: assets/images/example.jpg
  alt: Short image description.
```

Use `layout_style: image-row` for two side-by-side images:

```yaml
layout_style: image-row
images:
  - src: assets/images/example-1.jpg
    alt: First image description.
  - src: assets/images/example-2.jpg
    alt: Second image description.
```

Use `layout_style: feature` for a smaller image beside result copy:

```yaml
layout_style: feature
stat: "17:11 | 1st overall"
image:
  src: assets/images/example.jpg
  alt: Short image description.
```

## Image Notes

Put update images in `assets/images/` or a subfolder inside it. Use descriptive file names when possible.

Always include image credit links when photos come from photographers, race organizers, Instagram galleries, or partner clubs.

The `make build` and `make serve` commands automatically refresh the intrinsic-dimension manifest. The deploy workflow also regenerates it before building the site. To refresh it directly without running Jekyll:

```sh
ruby scripts/generate_image_dimensions.rb
```

## Results Harvester MVP

The repo includes an early helper for turning a race results page into a reviewable Dirigo-specific digest before writing an update post.

Use this when you have:

- A public race results URL.
- An optional photo gallery URL.
- A privacy-safe member roll CSV with names and aliases only.

Do not commit the treasurer's member spreadsheet, dues status, emails, phone numbers, addresses, or payment notes. Export a separate matching file with this shape:

```csv
display_name,aliases,tags
Nick Denari,"Nicholas Denari;Denari","Nick Denari"
Robert Ashby,"Rob Ashby;Ashby","Robert Ashby"
```

If the source is a Google Sheet with column A as last name and column B as first name, export it as CSV and use it directly. Headers like `Last Name,First Name`, `Last,First`, or `Surname,Given Name` are accepted:

```csv
Last Name,First Name
Denari,Nick
Ashby,Robert
```

For better matching, add an optional `Aliases` column for nicknames, formal names, maiden names, or common result-list variants:

```csv
Last Name,First Name,Aliases
Denari,Nick,"Nicholas Denari;Denari"
Ashby,Robert,"Rob Ashby;Ashby"
```

In Google Sheets, use **File → Download → Comma Separated Values (.csv)**. Save the export somewhere outside the repo if it contains the real member roll, for example:

```text
~/Downloads/dirigo-member-roll.csv
```

Run the harvester:

```sh
python3 scripts/results_harvester/cli.py \
  --member-roll ~/Downloads/dirigo-member-roll.csv \
  --results-url "https://example.com/results" \
  --photo-url "https://example.com/photos" \
  --race "Race Name" \
  --date 2026-08-03 \
  --out tmp/results-harvest.json \
  --markdown-out tmp/results-harvest.md
```

The output separates confirmed matches from possible matches and lists candidate photos scored by name, bib, Dirigo/team hints, and race terms. Treat the Markdown output as review context for `/recap`, the GitHub workflow, or a hand-written update. Possible matches should be checked before publishing.

The parser is intentionally generic right now: it reads normal HTML tables, CSV result exports, and gallery pages without extra dependencies. If a timing site is JavaScript-rendered, such as some RTRT leaderboards, use a CSV/export option when available or save a copied results table as CSV and pass that file to `--results-url`.

Add site-specific adapters later for RunSignUp, Race Roster, All Sports Events, UltraSignup, MileSplit/Tyler Timing, Maine Running Photos, GeoSnapshot, RTRT, or other timing/photo sites when a generic scrape is not good enough.

## Email-To-Draft Automation

The repo includes optional automation for turning a forwarded race report email, Discord command, or authenticated webhook into a review-ready PR.

Flow:

```text
forwarded email, Discord /recap, Discord /event, or webhook
→ Cloudflare Worker
→ temporary GitHub ingest branch
→ GitHub repository_dispatch with an ingest pointer
→ GitHub Actions
→ OpenAI/Jekyll content generator
→ pull request ready for review
```

Files:

- `automation/cloudflare-race-report-worker.js`: Cloudflare Worker endpoint.
- `.github/workflows/race-report-digest.yml`: GitHub Action that generates and opens the PR.
- `.github/workflows/calendar-event-digest.yml`: GitHub Action that generates and opens calendar-event PRs.
- `.github/prompts/race-report-to-jekyll-update.md`: Editorial and content rules for the generator.
- `.github/prompts/calendar-event-to-jekyll.md`: Calendar-event rules for `_events/` files.
- `scripts/generate_race_report_update.py`: Script that writes `_posts/`, `_events/`, and tag pages.

Email image attachments:

- The Worker stages the full forwarded email payload on a temporary GitHub branch so attached photos do not have to fit inside the small `repository_dispatch` payload.
- The Action fetches that payload, extracts image attachments from the raw MIME email, and stages candidate assets under `assets/images/email/YYYY-MM-DD/`.
- The generator sees those candidate image paths and may reference them in generated front matter.
- Used attachments are renamed before the PR opens so final filenames are based on the generated post/event and original attachment filename when useful, not generated alt copy.
- Attached-image alt text is replaced with deterministic, conservative text before the PR opens rather than trusting generated alt copy.
- If attachments are provided but the generated update forgets to use some or all of them, the generator adds the missing submitted images to the first relevant generated post/event instead of silently dropping them.
- Unused staged attachments are deleted before the PR is opened, so only images actually referenced by generated Markdown should appear in the PR.
- Supported image attachment types are JPEG, PNG, GIF, WebP, and AVIF.

Safety limits:

- The generator writes a manifest of intended PR files to `tmp/generated-files.txt`.
- The PR action is restricted to that manifest instead of committing every changed file in the runner.
- The workflow fails before opening a PR if the generated update exceeds 25 files or 2,000 added text lines.

GitHub setup:

1. Add repository secret `OPENAI_API_KEY`.
2. Optionally add repository variable `OPENAI_MODEL`; default is `gpt-5-mini`.
3. Optionally add repository variable `RACE_REPORT_PR_ASSIGNEE`; default is `crowjonah`.
4. Optionally add repository variable `RACE_REPORT_PR_REVIEWERS`; default is `crowjonah`. Use comma-separated GitHub usernames for more than one reviewer.
5. Optionally add repository variable `CALENDAR_EVENT_PR_ASSIGNEE`; default is `crowjonah`.
6. Optionally add repository variable `CALENDAR_EVENT_PR_REVIEWERS`; default is `crowjonah`. Use comma-separated GitHub usernames for more than one reviewer.
7. Optional direct email notifications: add repository secret `RESEND_API_KEY`, and variables `RACE_REPORT_NOTIFY_FROM` and `RACE_REPORT_NOTIFY_EMAIL`.
8. Make sure Actions can create pull requests under repository settings.
9. Make sure the intended reviewers have GitHub email notifications enabled for review requests. The workflow can request review, but GitHub account notification settings control whether that becomes an email.
10. Use the shared review rules in [.github/prompts/race-report-to-jekyll-update.md](.github/prompts/race-report-to-jekyll-update.md) and [.github/prompts/calendar-event-to-jekyll.md](.github/prompts/calendar-event-to-jekyll.md) so links and image assets are preserved as structured data, not rewritten as throwaway prose.
11. Optional Diri direct messages: keep the existing repository secret `DISCORD_BOT_TOKEN` and add repository variable `DISCORD_PR_DM_USER_ID` with the numeric Discord user ID that should receive every newly created race-report or calendar-event PR. Notification failures do not block PR creation.

Cloudflare setup:

1. Create a Worker from `automation/cloudflare-race-report-worker.js`.
2. Add Worker secret `GITHUB_TOKEN`.
   Use a fine-grained GitHub token for `dirigorc/dirigorc` with Contents write access.
3. Add Worker variable `GITHUB_REPO=dirigorc/dirigorc`.
4. Add Worker secret `INGEST_TOKEN` for HTTP webhook authentication.
5. Optional: add Worker variable `ALLOWED_FROM` as a comma-separated sender allowlist.
6. Optional for Discord: add Worker secret `DISCORD_PUBLIC_KEY`.
7. Attach the Worker to a Cloudflare Email Routing address, configure it as a Discord interaction endpoint, or call it with an authenticated HTTP POST.

HTTP test:

```sh
curl -X POST "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "seth@example.com",
    "subject": "Race results",
    "text": "Paste the race report email body here.",
    "attachments": [
      {
        "filename": "team-photo.jpg",
        "content_type": "image/jpeg",
        "data": "BASE64_ENCODED_IMAGE_DATA"
      }
    ]
  }'
```

To target the calendar-event workflow instead of the race-report workflow, include `"command": "event"` in the JSON body or send `X-Dirigo-Command: event` with a plain-text request.

### Discord `/recap` and `/event`

The Discord path uses the same Worker and review-ready PR pattern for two commands:

- `/recap`: draft an Updates post from race results or club notes. By default it preserves the submitted copy verbatim in both the homepage/archive summary and post body while still using the editorial pipeline for the title, date, category, layout, links, attachments, canonical tags, and tag pages. An optional `polish` input also allows AI-assisted rewriting of the public copy.
- `/event`: draft or update a Calendar event from upcoming race, group run, meet, deadline, or team-date details. This always uses the calendar-event prompt and writes `_events/` files only.
- If the initial `/recap` or `/event` text is too thin, the Worker opens a clarification modal instead of creating a low-context PR.
- If the text appears to use shorthand or incomplete member names, such as `Dave O`, `Ashby`, or first-name-only mentions, the Worker asks for full names before creating a PR.
- Long recaps should use `/recap recap_file` with a `.txt` or `.md` attachment. Discord can reject long pasted slash-command text before the Worker receives it, and Discord modals are capped at 4,000 characters.

Create the Discord application:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application for Dirigo site updates.
3. On **General Information**, copy the application **Public Key**.
4. Set that value as the Cloudflare Worker secret `DISCORD_PUBLIC_KEY`.

Set the interaction endpoint:

1. Deploy the Cloudflare Worker.
2. Copy the Worker URL, for example `https://dirigo-race-report.YOUR-SUBDOMAIN.workers.dev`.
3. In the Discord application, set **Interactions Endpoint URL** to the Worker URL.
4. Save the application. Discord will send a signed `PING`; the Worker must verify it and respond before Discord accepts the URL.
5. If you want a repeatable rollout, run [`scripts/deploy_discord_recap.sh`](scripts/deploy_discord_recap.sh) with `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID` set in the environment. The script deploys the Worker and registers both `/recap` and `/event`.

Create the commands manually:

```sh
# /recap: draft an Updates post
curl -X POST "https://discord.com/api/v10/applications/$DISCORD_APPLICATION_ID/guilds/$DISCORD_GUILD_ID/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "recap",
    "description": "Draft a Dirigo website update from recap text.",
    "type": 1,
    "options": [
      {
        "name": "body",
        "description": "Optional short recap text. Use recap_file for long reports.",
        "type": 3,
        "required": false,
        "max_length": 3900
      },
      {
        "name": "recap_file",
        "description": "Optional .txt/.md recap file for long race reports.",
        "type": 11,
        "required": false
      },
      {
        "name": "polish",
        "description": "Polish body wording; metadata and tags are always normalized.",
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
  }'

# /event: draft a Calendar event
curl -X POST "https://discord.com/api/v10/applications/$DISCORD_APPLICATION_ID/guilds/$DISCORD_GUILD_ID/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "event",
    "description": "Draft a Dirigo calendar event from upcoming-event details.",
    "type": 1,
    "options": [
      {
        "name": "body",
        "description": "Optional event details (leave empty to use modal).",
        "type": 3,
        "required": false
      },
      {
        "name": "links",
        "description": "Optional event, registration, results, or photo URLs.",
        "type": 3,
        "required": false
      }
    ]
  }'
```

Guild commands are usually available quickly while testing. A global command uses `/applications/$DISCORD_APPLICATION_ID/commands` instead, but it can take longer to appear.

Discord Worker behavior:

1. Verifies `x-signature-ed25519` and `x-signature-timestamp` using `DISCORD_PUBLIC_KEY`.
2. For `/recap`, if `body` and `recap_file` are omitted, opens a modal for recap text, links, and a polish toggle.
3. For `/event`, if `body` is omitted, opens a modal for event details and source links.
4. If an inline `/recap` is very short and has no obvious result, race/date, or source link, opens the recap modal with the original text prefilled.
5. If an inline `/event` has no recognizable date, opens the event modal with the original text prefilled.
6. If the text uses likely shorthand for member names, asks for full names before continuing.
7. Defaults `/recap` to `editorial_mode: "verbatim"`, preserving the submitted copy in both the homepage/archive summary and post body while still normalizing metadata and tags; if `polish` is set (inline or modal), uses `editorial_mode: "agentic"` and may rewrite the public copy.
8. Forces `/event` to `editorial_mode: "agentic"` so the calendar prompt can map details into structured front matter.
9. Extracts URLs from submitted text and optional `links` input so copied links survive Discord paste quirks.
10. For `/recap`, optionally accepts a `recap_file` attachment (`.txt`, `.md`, `.markdown`, or `.eml`, up to 256 KB) and uses that file as the recap body.
11. Optionally accepts image attachments from `image1` through `image5` (JPEG, PNG, GIF, WebP, AVIF) in inline mode and stages them with the ingest payload. The generator deterministically adds every accepted image to the post even if the model omits it, then gives retained files content-specific names and safe alt text; this applies in both verbatim and polished modes.
12. For inline submissions with images or `recap_file`, defers the Discord response immediately, processes downloads in the background, and then posts an ephemeral follow-up with accepted/skipped image counts.
13. Stages a payload with `source: "discord"`, `command`, `submitted_by`, `editorial_mode`, `body`, and `links`.
14. Triggers `race-report-email` for `/recap` or `calendar-event-email` for `/event`.
15. GitHub Actions creates a PR ready for review and posts the PR link back to the original interaction as an ephemeral follow-up.

Discord safe-submission notes:

- Discord can reject a slash command before the Worker receives it, especially when several large attachments are uploaded. If that happens, the Worker cannot recover the typed text.
- Safest path for long recaps: save the recap as `race-report.txt` or `race-report.md`, then run `/recap recap_file: race-report.txt`. Use the inline `body` only for a short note or leave it blank.
- Safest path for calendar events: run `/event` with no inline body, paste the event name, date, time, location, and details into the modal, then add registration, race, or image-credit URLs in `links`.
- Safest path for image-heavy recaps: attach the recap as `recap_file`, add up to five images using `image1` through `image5`, and keep a local copy of the text until the bot confirms the PR.
- If Discord does deliver an inline command with images, the Worker now acknowledges it immediately and processes image downloads in the background to avoid interaction timeouts.
- Inline image attachments are limited to JPEG, PNG, GIF, WebP, or AVIF, up to 8 MB each. The Worker will now report how many images were accepted and which ones were skipped when Discord does deliver the command.
- When in doubt, keep a copy of the recap text before attaching multiple images in Discord's old slash-command UI.

## Discord Deployment Checklist

1. Install the Discord app into the Dirigo server using the OAuth URL.
2. Deploy the Worker from `dirigo-email-ingest/` with `npx wrangler deploy`.
3. Register the guild slash commands with `scripts/deploy_discord_recap.sh` or the equivalent `curl` calls.
4. Set `DISCORD_PUBLIC_KEY` on the Worker.
5. Re-open Discord and test `/recap` with text, then `/event` with an upcoming race or group run.

Manual fallback:

Run the `Race report update PR` workflow from the GitHub Actions tab and paste the email body into `digest_text`.
Run the `Calendar event PR` workflow for upcoming events that should land in `_events/`.

## Site Structure

```text
.
├── index.html
├── join.html
├── history.html
├── updates/
│   ├── index.html
│   └── tags/
├── calendar/
│   └── index.html
├── 404.html
├── styles.css
├── _config.yml
├── _includes/
│   └── update-item.html
├── _layouts/
│   ├── tag.html
│   └── updates-archive.html
├── _events/
│   └── YYYY-MM-DD-title.md
├── _posts/
│   └── YYYY-MM-DD-title.md
└── assets/
```

## Deploy

Push changes to GitHub. The repository-owned GitHub Actions workflow at
`.github/workflows/pages.yml` builds the Jekyll site and publishes it to GitHub Pages.

Do not add a `.nojekyll` file; that would disable Jekyll processing and the updates feed would not render.
