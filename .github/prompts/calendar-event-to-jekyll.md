# Calendar Event To Jekyll

Convert a Dirigo RC upcoming-event email, Discord `/event` submission, webhook payload, or pasted team note into maintainable Jekyll calendar event files.

The site uses:

- `_events/YYYY-MM-DD-slug.md` for future races, recurring series, public group runs, deadlines, meets, and public team dates.
- `_posts/YYYY-MM-DD-slug.md` for results and recap updates. Do not create update posts from this prompt unless explicitly asked.

## Core Rules

1. Avoid duplicates.
   - Compare against existing events provided in the prompt.
   - Update an existing event when the new details improve time, location, recurrence, URL, image, or team note.
   - Create a new event only for distinct public dates or series.

2. Keep calendar content actionable.
   - Include public races, recurring series, public group runs, public meets, team-visible deadlines, and board-approved public team dates.
   - Do not publish private-only logistics, private addresses, payment details, listserv distribution details, or speculative plans.
   - If a note mentions results and future dates, only create/update the future calendar items.

3. Write for the public site.
   - Preserve supplied dates, times, venues, race names, public links, and registration details.
   - Do not invent facts.
   - If uncertain, either omit the detail or include the uncertainty in the JSON `missing`/`assumptions`, not in public copy.
   - Remove filler such as "possibly", "expected", "use this as", "calendar target", "natural team target", and "confirm details" unless uncertainty is real and important.

4. Editorial voice.
   - Keep it concise, specific, and human.
   - `summary` should explain what the event is.
   - `team_note` should add Dirigo-specific context only when useful.
   - Prefer concrete wording like "Dirigo runners have been showing up most weeks" over abstract phrasing like "a steady weekly check-in for racing, fitness, and teammates."

5. Images and links.
   - Use only existing local image paths from the context unless the input explicitly provides usable assets.
   - Email or Discord image attachments are usable assets when listed under "Email Image Attachments".
   - Treat submitted images as intentional editorial input unless clearly unrelated, duplicate, private, broken, or unsafe.
   - Use plain placeholder alt text such as `Dirigo race photo.` for attachments; automation can replace attached-image alt text deterministically.
   - Preserve event, registration, result, Instagram, Facebook, race, gallery, and photo-credit links in structured fields.

## Event Front Matter

Use this schema and omit empty fields:

```yaml
---
title: Event Name
date: YYYY-MM-DD
end_date: YYYY-MM-DD
time: 6:00 PM
type: Race
location: City, ME
summary: One concise public sentence.
team_note: Human, specific Dirigo context when useful.
recurrence: Wednesdays through August 26
event_url: https://example.com/
registration_url: https://example.com/register
results_url: https://example.com/results
related_update: /updates/example/
tags:
  - Event Name
links:
  - label: Race website
    url: https://example.com/
image:
  src: assets/images/example.jpg
  alt: Dirigo race photo.
image_credit:
  label: Photo by Name
  url: https://example.com/
---
```

Do not include a `status` field.

## Output Contract

Return JSON only. No Markdown fences.

```json
{
  "files": [
    {
      "path": "_events/YYYY-MM-DD-slug.md",
      "content": "---\\ntitle: Example Event\\n---\\n"
    }
  ],
  "summary": "Short PR summary.",
  "assumptions": ["Any assumptions made."],
  "skipped_duplicates": ["Any duplicate events skipped or merged."],
  "missing": ["Missing links, images, or facts to confirm."]
}
```

Only write paths under `_events/` unless explicitly instructed otherwise.
