# Race Report To Jekyll Update

Convert a forwarded Dirigo RC team update email, Discord `/recap` submission, or pasted team note into maintainable Jekyll files for the website.

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
   - Treat Discord `/recap` submissions as shorthand source material, not already polished public copy.
   - Remove private listserv chatter, apologies, payment details, addresses, and non-public logistics.
   - For youth/high-school athletes, keep copy respectful and result-focused.
   - Do not invent facts. If uncertain, omit the claim or include a concise assumption in the response notes.

3. Editorial voice.
   - Write like a teammate with good judgment, not a marketer.
   - Use plain verbs and concrete details.
   - Prefer content-specific headlines and concise page titles over generic titles like "Race report update".
  - For polished (`editorial_mode: agentic`) recaps, avoid dumping full result sheets. Lead with highlights and include representative top performances instead of every finisher line.
  - If many results are provided, summarize by race with concise bullets or short paragraphs and preserve links in front matter so readers can view full results.
   - Avoid polished-but-vague phrases like "calendar moving", "team-relevant events", "natural team target", or "steady weekly check-in for racing, fitness, and teammates".
   - Do not over-explain why normal club activity matters.
  - Never include internal development or changelog wording in public copy (for example: "rename agentic option", "backward compatibility", implementation notes, or tooling references).

4. Balance coverage.
   - Avoid gender imbalance when the source includes women, men, youth, masters, roads, track, and trail.
   - Lead with the strongest news value, then make room for notable breadth.

5. Images and links.
   - Use only existing local image paths from the context unless the input explicitly provides usable assets.
   - Email image attachments are usable assets when the prompt lists them under "Email Image Attachments".
   - Strongly prefer using email/Discord image attachments when they are provided. Treat attached images as intentional editorial input from the submitter unless they are clearly unrelated, duplicate, broken, private, or unsafe.
   - If submitted attachments are included, err toward using them. Do not drop usable submitted images just because one photo would be enough.
   - If an attached image fits a generated update or event, reference its local path exactly in `image.src` or `images[].src`.
   - Attachment paths shown in the prompt are temporary staging names. The automation will rename used attachments to content-specific filenames before opening the PR.
   - Do not invent detailed alt text for email/Discord attachments. Use a plain placeholder such as `Dirigo race photo.`; the automation will replace attached-image alt text deterministically.
   - Use multiple attachments when they support the same generated public update; prefer `layout_style: image-row` with `images:` for 2-4 relevant photos, or more when the sender clearly intended a gallery-style update.
   - Preserve source, result, photographer, Instagram, Facebook, race, and gallery links in front matter.
   - When a usable link exists, prefer a `links:` front matter entry or a direct image/gallery reference rather than a sentence that merely says the link was shared or posted elsewhere.
   - Do not end a post with a sentence like "Full results were shared with the team via ..." if a real result or gallery link is available. Put the link in front matter and keep the body focused on the facts.
   - If URLs are missing, record that in `missing` notes only. Do not add caveat sentences in the public-facing post body about missing links.
  - Do not end public post body text with calls like "if you have links/photos, share them and we can update this post". Put requests for missing info only in `missing` notes.
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
