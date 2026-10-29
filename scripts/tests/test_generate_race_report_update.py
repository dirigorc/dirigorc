import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "generate_race_report_update.py"
SPEC = importlib.util.spec_from_file_location("generate_race_report_update", MODULE_PATH)
assert SPEC and SPEC.loader
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class VerbatimRecapTests(unittest.TestCase):
    def test_verbatim_mode_preserves_summary_and_body_but_keeps_structured_front_matter(self):
        body = "Karley Piers won the Breakaway 5k in 17:29!"
        files = [
            {
                "path": "_posts/2026-08-15-karley-piers-breakaway-5k.md",
                "content": (
                    "---\n"
                    "title: Karley Piers wins the Breakaway 5K.\n"
                    "date: 2026-08-15\n"
                    "category: Results\n"
                    "layout_style: single\n"
                    "summary: Karley Piers won in Old Orchard Beach.\n"
                    "tags:\n"
                    "  - Karley Piers\n"
                    "  - Breakaway 5K\n"
                    "---\n\n"
                    "Smoothed replacement copy.\n"
                ),
            }
        ]

        GENERATOR.enforce_discord_verbatim_copy(
            files,
            {"source": "discord", "editorial_mode": "verbatim", "text": body},
        )

        self.assertTrue(files[0]["content"].endswith(f"---\n\n{body}\n"))
        self.assertIn(f"summary: {GENERATOR.yaml_double_quoted(body)}", files[0]["content"])
        self.assertNotIn("summary: Karley Piers won in Old Orchard Beach.", files[0]["content"])
        self.assertIn("tags:\n  - Karley Piers\n  - Breakaway 5K", files[0]["content"])

    def test_verbatim_mode_removes_malformed_summary_continuation_lines(self):
        body = (
            "The Weekly Back Cove Series ended on Wednesday.\n\n"
            "Nick Denari took the overall men's win.\n\n"
            "Enzo Giampaolo won the summer's final race."
        )
        files = [
            {
                "path": "_posts/2026-08-26-weekly-back-cove-season-finale.md",
                "content": (
                    "---\n"
                    'title: "Weekly Back Cove Series season finale"\n'
                    "date: 2026-08-26\n"
                    'summary: "The Weekly Back Cove Series ended on Wednesday.\\n\\nNick Denari took the overall men\'s win."\n'
                    "\n"
                    "Nick Denari took the overall men's win.\n"
                    "\n"
                    "Enzo Giampaolo won the summer's final race.\"\n"
                    "tags:\n"
                    '  - "Nick Denari"\n'
                    '  - "Enzo Giampaolo"\n'
                    "---\n\n"
                    "Smoothed replacement copy.\n"
                ),
            }
        ]

        GENERATOR.enforce_discord_verbatim_copy(
            files,
            {"source": "discord", "editorial_mode": "verbatim", "text": body},
        )

        content = files[0]["content"]
        self.assertIn(f"summary: {GENERATOR.yaml_double_quoted(body)}", content)
        self.assertIn('tags:\n  - "Nick Denari"\n  - "Enzo Giampaolo"', content)
        self.assertNotIn("\nNick Denari took the overall men's win.\n", content.split("---", 2)[1])
        self.assertTrue(content.endswith(f"---\n\n{body}\n"))

    def test_generated_posts_require_tags(self):
        files = [
            {
                "path": "_posts/2026-08-15-untagged.md",
                "content": "---\ntitle: Untagged.\n---\n",
            }
        ]

        with self.assertRaisesRegex(ValueError, "must include at least one tag"):
            GENERATOR.validate_post_tags(files)

    def test_tag_pages_are_added_for_new_post_tags(self):
        files = [
            {
                "path": "_posts/2026-08-15-example.md",
                "content": "---\ntags:\n  - New Regression Race\n---\n",
            }
        ]

        additions = GENERATOR.ensure_tag_pages(files)

        self.assertEqual(additions[0]["path"], "updates/tags/new-regression-race/index.html")
        self.assertIn('tag: "New Regression Race"', additions[0]["content"])

    def test_discord_attachment_is_kept_when_model_omits_it_in_verbatim_mode(self):
        body = "Karley Piers won the Breakaway 5k in 17:29!"
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        email = {
            "source": "discord",
            "editorial_mode": "verbatim",
            "text": body,
            "attachments": [
                {
                    "filename": "karley-finish.png",
                    "content_type": "image/png",
                    "data": base64.b64encode(tiny_png).decode("ascii"),
                }
            ],
        }
        files = [
            {
                "path": "_posts/2026-08-15-karley-piers-breakaway-5k.md",
                "content": (
                    "---\n"
                    "title: Karley Piers wins the Breakaway 5K.\n"
                    "date: 2026-08-15\n"
                    "category: Results\n"
                    "layout_style: single\n"
                    "summary: Karley Piers won in Old Orchard Beach.\n"
                    "tags:\n"
                    "  - Karley Piers\n"
                    "  - Breakaway 5K\n"
                    "---\n\n"
                    "Smoothed replacement copy.\n"
                ),
            }
        ]
        result = {"assumptions": []}

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            GENERATOR, "ROOT", Path(directory)
        ), mock.patch.object(
            GENERATOR,
            "GENERATED_FILES_PATH",
            Path(directory) / "tmp" / "generated-files.txt",
        ):
            staged = GENERATOR.stage_email_attachments(email, "2026-08-15")
            GENERATOR.enforce_discord_verbatim_copy(files, email)
            GENERATOR.ensure_attached_images_used(staged, files, result)
            kept = GENERATOR.prune_unused_attachments(staged, files)
            renamed = GENERATOR.rename_kept_attachments(staged, files, kept)

            self.assertEqual(len(renamed), 1)
            self.assertTrue((Path(directory) / renamed[0]).is_file())
            self.assertIn(renamed[0], files[0]["content"])
            self.assertIn("layout_style: single\nimage:", files[0]["content"])
            self.assertTrue(files[0]["content"].endswith(f"---\n\n{body}\n"))
            self.assertIn("Included submitted image attachments", result["assumptions"][0])

            GENERATOR.write_generated_files_manifest([files[0]["path"], *renamed])
            manifest = GENERATOR.GENERATED_FILES_PATH.read_text(encoding="utf-8")
            self.assertIn(renamed[0], manifest.splitlines())


class PrBodyPreviewTests(unittest.TestCase):
    def test_write_pr_body_renders_post_like_site_preview(self):
        post_path = "_posts/2026-10-13-bethanie-brown-alexis-wilbert-boston.md"
        image_path = "assets/images/email/2026-10-13/bethanie.png"
        content = (
            "---\n"
            'title: "Bethanie Brown 34:53; Alexis Wilbert 35:37 in Boston"\n'
            "date: 2026-10-13\n"
            'category: "Results"\n'
            'layout_style: "image-row"\n'
            "images:\n"
            f'  - src: "{image_path}"\n'
            '    alt: "Dirigo race photo."\n'
            'summary: "Dirigo Elite women raced in Boston."\n'
            "tags:\n"
            '  - "Boston"\n'
            "links:\n"
            '  - label: "Results"\n'
            '    url: "https://example.com/results"\n'
            "---\n\n"
            "Dirigo Elite women raced in Boston.\n"
        )

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            GENERATOR, "ROOT", Path(directory)
        ), mock.patch.object(
            GENERATOR,
            "PR_BODY_PATH",
            Path(directory) / "tmp" / "race-report-pr-body.md",
        ), mock.patch.dict(
            "os.environ",
            {
                "GITHUB_REPOSITORY": "crowjonah/dirigorc",
                "PR_BRANCH": "automation/race-report-123",
            },
            clear=False,
        ):
            target = Path(directory) / post_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

            GENERATOR.write_pr_body(
                {
                    "summary": "Generated a Boston results update.",
                    "assumptions": ["Used submitted Discord photos."],
                    "missing": [],
                    "skipped_duplicates": [],
                },
                [post_path, image_path],
                {
                    "source": "discord",
                    "command": "recap",
                    "submitted_by": "Jonah",
                    "editorial_mode": "verbatim",
                },
                [{"path": image_path}],
                [image_path],
                "race-report",
            )

            body = GENERATOR.PR_BODY_PATH.read_text(encoding="utf-8")

        self.assertIn("## Site preview", body)
        self.assertIn("_Results_", body)
        self.assertIn("# Bethanie Brown 34:53; Alexis Wilbert 35:37 in Boston", body)
        self.assertIn("Dirigo Elite women raced in Boston.", body)
        self.assertIn("Results · Oct 13, 2026", body)
        self.assertIn(
            f"![Dirigo race photo.](https://raw.githubusercontent.com/crowjonah/dirigorc/automation/race-report-123/{image_path})",
            body,
        )
        self.assertIn("[Results](https://example.com/results)", body)
        self.assertIn("<details>", body)
        self.assertIn("<summary>Automation notes</summary>", body)
        self.assertIn("Source: **Discord /recap** submitted by `Jonah` (verbatim mode)", body)
        self.assertIn(f"- `{post_path}`", body)
        self.assertIn("### Generator summary", body)
        self.assertIn("Generated a Boston results update.", body)
        # Identical body/summary should not be duplicated in the preview.
        self.assertEqual(body.count("Dirigo Elite women raced in Boston."), 1)

    def test_write_pr_body_renders_calendar_event_preview(self):
        event_path = "_events/2026-10-04-maine-marathon.md"
        content = (
            "---\n"
            "title: Maine Marathon, Half Marathon, and Relay\n"
            "date: 2026-10-04\n"
            "time: 7:45 AM\n"
            "type: Race\n"
            "location: Portland, ME\n"
            "summary: Maine Track Club's fall marathon weekend.\n"
            "team_note: Spot Dirigo blue over longer distances.\n"
            "event_url: https://mainemarathon.com/\n"
            "registration_url: https://runsignup.com/Race/ME/Portland/MaineMarathon\n"
            "---\n"
        )

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            GENERATOR, "ROOT", Path(directory)
        ), mock.patch.object(
            GENERATOR,
            "PR_BODY_PATH",
            Path(directory) / "tmp" / "race-report-pr-body.md",
        ):
            target = Path(directory) / event_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

            GENERATOR.write_pr_body(
                {"summary": "Added Maine Marathon to the calendar."},
                [event_path],
                {
                    "source": "discord",
                    "command": "event",
                    "submitted_by": "Jonah",
                    "editorial_mode": "agentic",
                    "subject": "Maine Marathon",
                    "from": "Jonah",
                },
                [],
                [],
                "calendar-event",
            )

            body = GENERATOR.PR_BODY_PATH.read_text(encoding="utf-8")

        self.assertIn("_Race_", body)
        self.assertIn("# Maine Marathon, Half Marathon, and Relay", body)
        self.assertIn("Maine Track Club's fall marathon weekend.", body)
        self.assertIn("- **Date:** Oct 4, 2026", body)
        self.assertIn("- **Time:** 7:45 AM", body)
        self.assertIn("- **Location:** Portland, ME", body)
        self.assertIn("> Spot Dirigo blue over longer distances.", body)
        self.assertIn("[Event details](https://mainemarathon.com/)", body)
        self.assertIn("[Register](https://runsignup.com/Race/ME/Portland/MaineMarathon)", body)


class CorrectionEditTests(unittest.TestCase):
    def test_edit_existing_refuses_a_changed_date_line(self):
        source = "---\ndate: 2026-01-02\n---\n\nHi\n"
        changed = "---\ndate: 2026-01-03\n---\n\nHi\n"
        with mock.patch.object(GENERATOR, "call_openai", return_value=self.model(changed)):
            with self.assertRaisesRegex(ValueError, "date:"):
                GENERATOR.edit_existing(self.wire(), {"_posts/2026-01-02-a.md": source})

    def test_edit_existing_refuses_a_broken_front_matter_fence(self):
        source = "---\ndate: 2026-01-02\n---\n\nHi\n"
        broken = "---\ndate: 2026-01-02\n---\n\n---\nHi\n"
        with mock.patch.object(GENERATOR, "call_openai", return_value=self.model(broken)):
            with self.assertRaisesRegex(ValueError, "front-matter"):
                GENERATOR.edit_existing(self.wire(), {"_posts/2026-01-02-a.md": source})

    def test_edit_existing_refuses_a_new_file(self):
        source = "---\ndate: 2026-01-02\n---\n\nHi\n"
        with mock.patch.object(GENERATOR, "call_openai", return_value={
            "files": [{"path": "_posts/2026-01-02-new.md", "content": source}],
            "summary": "",
            "assumptions": [],
            "skipped_duplicates": [],
            "missing": [],
        }):
            with self.assertRaisesRegex(ValueError, "not an existing file"):
                GENERATOR.edit_existing(self.wire(), {"_posts/2026-01-02-a.md": source})

    def test_edit_existing_returns_the_existing_file(self):
        source = "---\ndate: 2026-01-02\n---\n\nHi\n"
        updated = "---\ndate: 2026-01-02\n---\n\nHello\n"
        with mock.patch.object(GENERATOR, "call_openai", return_value=self.model(updated)) as call:
            files = GENERATOR.edit_existing(self.wire(), {"_posts/2026-01-02-a.md": source})
        self.assertEqual(files, [{"path": "_posts/2026-01-02-a.md", "content": updated}])
        self.assertNotIn("skip_dates", call.call_args.args[0])

    def test_calendar_correction_keeps_one_date_off_the_series_location(self):
        source = "---\ndate: 2026-07-18\n---\n\nHi\n"
        updated = "---\ndate: 2026-07-18\n---\n\nHello\n"
        path = "_events/2026-07-18-payson-park-long-run.md"
        wire = self.wire()
        wire["mode"] = "calendar-event"
        wire["path"] = path
        with mock.patch.object(GENERATOR, "call_openai", return_value={
            "files": [{"path": path, "content": updated}],
            "summary": "",
            "assumptions": [],
            "skipped_duplicates": [],
            "missing": [],
        }) as call:
            files = GENERATOR.edit_existing(wire, {path: source})
        self.assertEqual(files, [{"path": path, "content": updated}])
        self.assertIn("skip_dates", call.call_args.args[0])

    def test_edit_existing_quotes_a_note_that_contains_a_colon(self):
        source = "---\ndate: 2026-07-18\nteam_note: Meet at Payson.\n---\n"
        note = (
            "Dave Ouellette leads the weekly run. Note: On 2026-10-31 we will be running in Freeport "
            "— meet at Leon Gorman Park at 8:00 AM."
        )
        updated = f"---\ndate: 2026-07-18\nteam_note: {note}\n---\n"
        path = "_events/2026-07-18-payson-park-long-run.md"
        with mock.patch.object(GENERATOR, "call_openai", return_value={
            "files": [{"path": path, "content": updated}],
            "summary": "",
            "assumptions": [],
            "skipped_duplicates": [],
            "missing": [],
        }):
            files = GENERATOR.edit_existing(self.wire(), {path: source})
        content = files[0]["content"]
        self.assertIn(f"team_note: {GENERATOR.yaml_double_quoted(note)}", content)
        self.assertIn("date: 2026-07-18", content)

    def test_write_pr_body_appends_the_correction_marker(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            GENERATOR, "PR_BODY_PATH", Path(directory) / "body.md"
        ):
            GENERATOR.write_pr_body(
                {"summary": "Corrected the time."},
                [],
                {"source": "discord", "command": "recap", "from": "Jonah", "subject": "Correction"},
                [],
                [],
                "race-report",
                marker="<!-- dirigo-correction: _posts/2026-01-02-a.md abc -->",
            )
            body = GENERATOR.PR_BODY_PATH.read_text(encoding="utf-8")
        self.assertTrue(body.rstrip().endswith("<!-- dirigo-correction: _posts/2026-01-02-a.md abc -->"))

    def wire(self):
        return {
            "instruction": "Say hello.",
            "path": "_posts/2026-01-02-a.md",
            "readFrom": "main",
            "mode": "race-report",
        }

    def model(self, content):
        return {
            "files": [{"path": "_posts/2026-01-02-a.md", "content": content}],
            "summary": "",
            "assumptions": [],
            "skipped_duplicates": [],
            "missing": [],
        }


class SelfReportTests(unittest.TestCase):
    def test_normalize_keeps_self_report_inference(self):
        email = GENERATOR.normalize_email_payload({
            "email": {
                "source": "discord",
                "command": "recap",
                "editorial_mode": "self-report",
                "from": "Seth (1)",
                "subject": "Discord /recap",
                "text": "18:42 at Back Cove",
                "trigger": "reaction",
                "authored_by": "Seth (1)",
                "inference": {
                    "self_report": True,
                    "runner": "Seth Crockett",
                    "notes": ["Seth Crockett is the runner because the note does not name someone else."],
                },
            }
        })
        self.assertEqual(email["editorial_mode"], "self-report")
        self.assertEqual(email["inference"]["runner"], "Seth Crockett")
        self.assertEqual(email["trigger"], "reaction")

        unknown = GENERATOR.normalize_email_payload({
            "email": {
                "source": "discord",
                "editorial_mode": "mystery",
                "from": "Seth",
                "subject": "Discord /recap",
                "text": "A long enough recap with a result in 18:42 and a date on Saturday at Back Cove.",
            }
        })
        self.assertEqual(unknown["editorial_mode"], "verbatim")

    def test_prompt_context_names_the_inferred_runner_and_assumptions_keep_the_note(self):
        email = {
            "inference": {
                "self_report": True,
                "runner": "Seth Crockett",
                "reported_on": "2026-10-26",
                "notes": ["Seth Crockett is the runner because the note does not name someone else."],
            },
            "authored_by": "Seth (1)",
        }
        context = GENERATOR.self_report_context(email)
        self.assertIn("Runner: Seth Crockett", context)
        self.assertIn("Inferred date: 2026-10-26", context)
        self.assertIn("Seth (1)", GENERATOR.message_author_context(email))

        result = {"assumptions": ["Model note."]}
        GENERATOR.merge_inference_assumptions(result, email)
        self.assertEqual(
            result["assumptions"],
            ["Seth Crockett is the runner because the note does not name someone else.", "Model note."],
        )

    def test_reaction_source_line_names_the_author(self):
        line = GENERATOR.source_line(
            {
                "source": "discord",
                "trigger": "reaction",
                "submitted_by": "Crow (2)",
                "authored_by": "Seth (1)",
                "editorial_mode": "self-report",
                "from": "Crow (2)",
                "subject": "Discord /recap",
            },
            "race-report",
        )
        self.assertIn("Discord reaction", line)
        self.assertIn("Crow (2)", line)
        self.assertIn("Seth (1)", line)


class ScreenshotReadingTests(unittest.TestCase):
    def test_results_screenshot_is_transcribed_and_removed_while_the_race_photo_stays(self):
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        email = {
            "attachments": [
                {
                    "filename": "rich-finish.png",
                    "content_type": "image/png",
                    "data": base64.b64encode(tiny_png).decode("ascii"),
                },
                {
                    "filename": "results-card.png",
                    "content_type": "image/png",
                    "data": base64.b64encode(tiny_png).decode("ascii"),
                },
            ]
        }
        transcription = "Richard Alff\nNet Time 1:21:15.0\n11th Overall\n1st M50-54"

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(GENERATOR, "ROOT", Path(directory)):
            staged = GENERATOR.stage_email_attachments(email, "2026-10-18")
            photo = next(item for item in staged if "rich-finish" in item["filename"])
            card = next(item for item in staged if "results-card" in item["filename"])
            photos, notes = GENERATOR.apply_image_readings(
                staged,
                [
                    {"path": photo["path"], "kind": "race-photo", "text": ""},
                    {"path": card["path"], "kind": "stats-screenshot", "text": transcription},
                ],
            )

            self.assertEqual([item["path"] for item in photos], [photo["path"]])
            self.assertTrue((Path(directory) / photo["path"]).is_file())
            self.assertFalse((Path(directory) / card["path"]).exists())
            self.assertIn("1:21:15.0", GENERATOR.stats_screenshot_context(notes))
            self.assertIn("not post photos", GENERATOR.stats_screenshot_context(notes))

            files = [{"path": "_posts/2026-10-18-rich-alff.md", "content": "---\ntitle: Rich Alff\n---\n\nBody.\n"}]
            result = {"assumptions": []}
            GENERATOR.ensure_attached_images_used(photos, files, result)
            self.assertIn(photo["path"], files[0]["content"])
            self.assertNotIn(card["path"], files[0]["content"])
            GENERATOR.merge_screenshot_assumptions(result, notes)
            self.assertIn("1:21:15.0", result["assumptions"][0])
            self.assertIn("left that image out", result["assumptions"][0])

    def test_blank_screenshot_reading_keeps_the_image(self):
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        email = {
            "attachments": [
                {
                    "filename": "results-card.png",
                    "content_type": "image/png",
                    "data": base64.b64encode(tiny_png).decode("ascii"),
                }
            ]
        }
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(GENERATOR, "ROOT", Path(directory)):
            staged = GENERATOR.stage_email_attachments(email, "2026-10-18")
            photos, notes = GENERATOR.apply_image_readings(
                staged,
                [{"path": staged[0]["path"], "kind": "stats-screenshot", "text": "   "}],
            )
            self.assertEqual(photos, staged)
            self.assertEqual(notes, [])
            self.assertTrue((Path(directory) / staged[0]["path"]).is_file())

    def test_reading_request_sends_each_image_and_keeps_a_bib_photo(self):
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        email = {
            "attachments": [
                {
                    "filename": "rich-finish.png",
                    "content_type": "image/png",
                    "data": base64.b64encode(tiny_png).decode("ascii"),
                }
            ]
        }
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(GENERATOR, "ROOT", Path(directory)):
            staged = GENERATOR.stage_email_attachments(email, "2026-10-18")
            body = GENERATOR.attachment_reading_body(staged, "gpt-5-mini")

        content = body["input"][0]["content"]
        self.assertIn("bib number", content[0]["text"])
        self.assertEqual(content[1]["text"], f"Image path: {staged[0]['path']}")
        self.assertEqual(content[2]["type"], "input_image")
        self.assertTrue(content[2]["image_url"].startswith("data:image/png;base64,"))
        self.assertEqual(body["text"]["format"]["schema"]["properties"]["images"]["items"]["properties"]["kind"]["enum"], ["race-photo", "stats-screenshot"])

    def test_failed_screenshot_reading_keeps_every_image(self):
        staged = [{"path": "assets/images/email/2026-10-18/rich-finish.png"}]
        with mock.patch.object(GENERATOR, "read_attachment_images", side_effect=RuntimeError("vision failed")):
            photos, notes = GENERATOR.separate_results_screenshots(staged, "gpt-5-mini")
        self.assertEqual(photos, staged)
        self.assertEqual(notes, [])


class AttachmentAltTests(unittest.TestCase):
    def test_id_like_filename_stays_a_plain_alt(self):
        alt = GENERATOR.deterministic_attachment_alt({
            "filename": "mainetrack-xc-1792879719-4015288571166528503-1445532972.jpg",
        })
        self.assertEqual(alt, "Dirigo race photo.")

    def test_camera_filename_stays_a_plain_alt(self):
        self.assertEqual(GENERATOR.deterministic_attachment_alt({"filename": "IMG_1234.jpg"}), "Dirigo race photo.")

    def test_word_filename_is_used_in_the_alt(self):
        alt = GENERATOR.deterministic_attachment_alt({"filename": "beach-to-beacon-finish.jpg"})
        self.assertEqual(alt, "Dirigo race photo from beach to beacon finish.")


if __name__ == "__main__":
    unittest.main()
