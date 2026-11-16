#!/usr/bin/env ruby
# frozen_string_literal: true

# Renders _includes/canonical-url.html and checks that composed URLs stay on
# https://dirigorc.com, keep their separators, and percent-encode spaces.

require "jekyll"

root = File.expand_path("../..", __dir__)
config = Jekyll.configuration(
  "source" => root,
  "destination" => File.join(root, ".jekyll-cache", "canonical-url-test"),
  "quiet" => true,
  "url" => "https://dirigorc.github.io",
  "baseurl" => "/dirigorc",
  "canonical_host" => "https://dirigorc.com"
)
site = Jekyll::Site.new(config)
payload = site.site_payload
info = { :registers => { :site => site, :page => {} } }

def render_canonical(site, payload, info, path)
  template = site.liquid_renderer.file("canonical-url-test").parse(
    "{% include canonical-url.html path=canonical_test_path %}{{ canonical_url }}"
  )
  template.render!(payload.merge("canonical_test_path" => path), info).strip
end

checks = {
  "/assets/images/back cove 2026.jpg" =>
    "https://dirigorc.com/assets/images/back%20cove%202026.jpg",
  "/assets/images/back%20cove%202026.jpg" =>
    "https://dirigorc.com/assets/images/back%20cove%202026.jpg",
  "https://dirigorc.github.io/dirigorc/assets/images/back cove 2026.jpg" =>
    "https://dirigorc.com/assets/images/back%20cove%202026.jpg",
  "/results/2026/11/02/marah-borgman-nyc-marathon.html" =>
    "https://dirigorc.com/results/2026/11/02/marah-borgman-nyc-marathon.html",
  "https://example.com/keep this" => "https://example.com/keep this"
}

failures = []
checks.each do |path, expected|
  actual = render_canonical(site, payload, info, path)
  next if actual == expected

  failures << "#{path.inspect}\n  expected #{expected}\n  actual   #{actual}"
end

if failures.empty?
  puts "canonical URL checks passed (#{checks.length})"
else
  warn failures.join("\n")
  exit 1
end
