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

Run the local server:

```sh
bundle exec jekyll serve --livereload
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

## Email-To-Draft Automation

The repo includes an optional automation for turning a forwarded race report email, Discord `/recap` command, or authenticated webhook into a draft PR.

Flow:

```text
forwarded email, Discord /recap, or webhook
→ Cloudflare Worker
→ temporary GitHub ingest branch
→ GitHub repository_dispatch with an ingest pointer
→ GitHub Actions
→ OpenAI draft generator
→ draft pull request
```

Files:

- `automation/cloudflare-race-report-worker.js`: Cloudflare Worker endpoint.
- `.github/workflows/race-report-digest.yml`: GitHub Action that generates and opens the PR.
- `.github/prompts/race-report-to-jekyll-update.md`: Editorial and content rules for the generator.
- `scripts/generate_race_report_update.py`: Script that writes `_posts/`, `_events/`, and tag pages.

Email image attachments:

- The Worker stages the full forwarded email payload on a temporary GitHub branch so attached photos do not have to fit inside the small `repository_dispatch` payload.
- The Action fetches that payload, extracts image attachments from the raw MIME email, and stages candidate assets under `assets/images/email/YYYY-MM-DD/`.
- The generator sees those candidate image paths and may reference them in generated front matter.
- Used attachments are renamed before the PR opens so final filenames are based on the generated post/event and original attachment filename when useful, not generated alt copy.
- Attached-image alt text is replaced with deterministic, conservative text before the PR opens rather than trusting generated alt copy.
- If attachments are provided but the generated draft forgets to use some or all of them, the generator adds the missing submitted images to the first relevant generated post/event instead of silently dropping them.
- Unused staged attachments are deleted before the PR is opened, so only images actually referenced by generated Markdown should appear in the PR.
- Supported image attachment types are JPEG, PNG, GIF, WebP, and AVIF.

Safety limits:

- The generator writes a manifest of intended PR files to `tmp/generated-files.txt`.
- The PR action is restricted to that manifest instead of committing every changed file in the runner.
- The workflow fails before opening a PR if the draft exceeds 25 files or 2,000 added text lines.

GitHub setup:

1. Add repository secret `OPENAI_API_KEY`.
2. Optionally add repository variable `OPENAI_MODEL`; default is `gpt-5-mini`.
3. Optionally add repository variable `RACE_REPORT_PR_ASSIGNEE`; default is `crowjonah`.
4. Optional direct email notifications: add repository secret `RESEND_API_KEY`, and variables `RACE_REPORT_NOTIFY_FROM` and `RACE_REPORT_NOTIFY_EMAIL`.
5. Make sure Actions can create pull requests under repository settings.
6. Use the shared review rules in [.github/prompts/race-report-to-jekyll-update.md](.github/prompts/race-report-to-jekyll-update.md) so links and image assets are preserved as structured data, not rewritten as throwaway prose.

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

### Discord `/recap` MVP

The Discord path uses the same Worker and the same draft PR workflow. By default, `/recap` uses submitted text verbatim. An optional `polish` input can opt into Copilot-assisted editorialization before opening a draft PR.

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
5. If you want a repeatable rollout, run [`scripts/deploy_discord_recap.sh`](scripts/deploy_discord_recap.sh) with `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID` set in the environment.

Create the `/recap` command:

```sh
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
  }'
```

Guild commands are usually available quickly while testing. A global command uses `/applications/$DISCORD_APPLICATION_ID/commands` instead, but it can take longer to appear.

Discord Worker behavior:

1. Verifies `x-signature-ed25519` and `x-signature-timestamp` using `DISCORD_PUBLIC_KEY`.
2. If `body` is omitted, opens a modal for recap text, links, and a polish toggle.
3. Defaults to `editorial_mode: "verbatim"`; if `polish` is set (inline or modal), uses `editorial_mode: "agentic"`.
4. Extracts URLs from recap text and optional `links` input so copied recap links survive Discord paste quirks.
5. Optionally accepts image attachments from `image1` through `image5` (JPEG, PNG, GIF, WebP, AVIF) in inline mode and stages them with the ingest payload.
6. For inline submissions with images, defers the Discord response immediately, processes image fetches in the background, and then posts an ephemeral follow-up with accepted/skipped image counts.
7. Stages a payload with `source: "discord"`, `submitted_by`, `editorial_mode`, `body`, and `links`.
8. Triggers the existing `race-report-email` `repository_dispatch`.
9. GitHub Actions creates a draft PR for review.

Discord safe-draft notes:

- Discord can reject a slash command before the Worker receives it, especially when several large attachments are uploaded. If that happens, the Worker cannot recover the typed text.
- Safest path for long recaps: run `/recap` with no inline body, paste the recap into the modal, and submit text/links first.
- Safest path for image-heavy recaps: submit the text first, then use the HTTP test endpoint with base64 image attachments, or send a smaller follow-up recap with 1-2 images.
- If Discord does deliver an inline command with images, the Worker now acknowledges it immediately and processes image downloads in the background to avoid interaction timeouts.
- Inline image attachments are limited to JPEG, PNG, GIF, WebP, or AVIF, up to 8 MB each. The Worker will now report how many images were accepted and which ones were skipped when Discord does deliver the command.
- When in doubt, keep a copy of the recap text before attaching multiple images in Discord's old slash-command UI.

## Discord Deployment Checklist

1. Install the Discord app into the Dirigo server using the OAuth URL.
2. Deploy the Worker from `dirigo-email-ingest/` with `npx wrangler deploy`.
3. Register the guild slash command with `scripts/deploy_discord_recap.sh` or the equivalent `curl` call.
4. Set `DISCORD_PUBLIC_KEY` on the Worker.
5. Re-open Discord and test `/recap` with text, then with one or more images.

Manual fallback:

Run the `Draft race report update` workflow from the GitHub Actions tab and paste the email body into `digest_text`.

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
