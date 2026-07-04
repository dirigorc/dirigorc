# Race Report To Jekyll Update

Convert a forwarded Dirigo RC team update email into maintainable Jekyll files for the website.

The site uses:

- `_posts/YYYY-MM-DD-slug.md` for public updates, results, recaps, club notes, and recovered archive posts.
- `_events/YYYY-MM-DD-slug.md` for future races, recurring series, group runs, deadlines, and public calendar items.
- `updates/tags/tag-slug/index.html` for tag archive pages.

## Core Rules

1. Avoid duplicates.
   - Compare against existing posts and events provided in the prompt.
   - If a story is already represented, update the existing file only when the new details are meaningful.
   - Future/actionable items belong in `_events/`, not in an `Upcoming` post.

2. Write for the public site.
   - Keep it celebratory, concise, and factual.
   - Preserve supplied names, dates, races, places, times, and result links.
   - Remove private listserv chatter, apologies, payment details, addresses, and non-public logistics.
   - For youth/high-school athletes, keep copy respectful and result-focused.
   - Do not invent facts. If uncertain, omit the claim or include a concise assumption in the response notes.

3. Editorial voice.
   - Write like a teammate with good judgment, not a marketer.
   - Use plain verbs and concrete details.
   - Avoid polished-but-vague phrases like "calendar moving", "team-relevant events", "natural team target", or "steady weekly check-in for racing, fitness, and teammates".
   - Do not over-explain why normal club activity matters.

4. Balance coverage.
   - Avoid gender imbalance when the source includes women, men, youth, masters, roads, track, and trail.
   - Lead with the strongest news value, then make room for notable breadth.

5. Images and links.
   - Use only existing local image paths from the context unless the input explicitly provides usable assets.
   - Email image attachments are usable assets when the prompt lists them under "Email Image Attachments".
   - If an attached image clearly fits a generated update or event, reference its local path exactly in `image.src` or `images[].src`.
   - Do not use every attachment automatically. Use only images that support the generated public update.
   - Preserve source, result, photographer, Instagram, Facebook, race, and gallery links in front matter.
   - If an image is needed but unavailable, leave the generated update imageless and mention it in `missing`.

## Post Front Matter

Use existing site conventions:

```yaml
---
title: Short headline.
date: YYYY-MM-DD
category: Results
layout_style: single
image:
  src: assets/images/example.jpg
  alt: Short image description.
summary: One concise paragraph.
tags:
  - Race Name
  - Athlete Name
links:
  - label: Results
    url: https://example.com/
---
```

Allowed `category` values are usually `Results` and `Club Notes`. Avoid `Upcoming` when `_events/` exists.

Allowed `layout_style` values include `single`, `image-row`, and `feature`.

## Event Front Matter

Use `_events/` for future/actionable dates:

```yaml
---
title: Event Name
date: YYYY-MM-DD
end_date: YYYY-MM-DD
time: 6:00 PM
type: Race
location: City, ME
summary: One concise sentence about the event.
team_note: Human, specific Dirigo context when useful.
recurrence: Wednesdays through August 26
event_url: https://example.com/
registration_url: https://example.com/register
results_url: https://example.com/results
tags:
  - Event Name
---
```

Do not include a `status` field.

## Tag Pages

Every new post tag should have a tag page:

```yaml
---
title: "Tag Name Updates | Dirigo"
description: "Dirigo updates tagged Tag Name."
layout: tag
tag: "Tag Name"
---
```

Use lowercase hyphenated slugs for the folder name.

## Output Contract

Return JSON only. No Markdown fences.

```json
{
  "files": [
    {
      "path": "_posts/YYYY-MM-DD-slug.md",
      "content": "---\\ntitle: Example.\\n---\\n"
    }
  ],
  "summary": "Short PR summary.",
  "assumptions": ["Any assumptions made."],
  "skipped_duplicates": ["Any duplicate stories skipped or merged."],
  "missing": ["Missing images, links, or facts to confirm."]
}
```

Only write paths under `_posts/`, `_events/`, or `updates/tags/`.
