# Dirigo RC Website

Static website for Dirigo RC, served with GitHub Pages and lightly powered by Jekyll.

Most pages are plain HTML/CSS. Jekyll is currently used for the updates feed:

- Homepage shows the three newest files from `_updates/`.
- `updates.html` shows the full update archive.
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

Create a new Markdown file in `_updates/` using this naming pattern:

```text
YYYY-MM-DD-short-title.md
```

Example:

```text
_updates/2026-07-03-beach-to-beacon-preview.md
```

Use front matter like this:

```yaml
---
title: Beach to Beacon crew gets ready.
date: 2026-07-03
category: Upcoming
layout_style: single
image:
  src: assets/images/example.jpg
  alt: Dirigo runners warming up before a road race.
summary: A short public-facing recap or preview goes here. Keep it punchy and factual.
links:
  - label: Race details
    url: https://example.com/
---
```

The homepage automatically shows the three newest updates by `date`. Older updates remain visible on `updates.html`.

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

## Site Structure

```text
.
├── index.html
├── join.html
├── history.html
├── updates.html
├── 404.html
├── styles.css
├── _config.yml
├── _includes/
│   └── update-item.html
├── _updates/
│   └── YYYY-MM-DD-title.md
└── assets/
```

## Deploy

Push changes to GitHub. The repository-owned GitHub Actions workflow at
`.github/workflows/pages.yml` builds the Jekyll site and publishes it to GitHub Pages.

Do not add a `.nojekyll` file; that would disable Jekyll processing and the updates feed would not render.
