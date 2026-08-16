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


if __name__ == "__main__":
    unittest.main()
