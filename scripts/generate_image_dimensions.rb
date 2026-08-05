#!/usr/bin/env ruby

require "json"
require "open3"
require "pathname"

root = Pathname.new(__dir__).join("..").realpath
images_root = root.join("assets/images")
output_path = root.join("_data/image_dimensions.yml")
extensions = %w[.avif .gif .jpeg .jpg .png .webp]

image_magick = %w[magick convert].find do |command|
  ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).any? do |directory|
    File.executable?(File.join(directory, command))
  end
end

unless image_magick
  warn "ImageMagick is required (expected `magick` or `convert` in PATH)."
  exit 1
end

image_paths = images_root.glob("**/*")
  .select(&:file?)
  .select { |path| extensions.include?(path.extname.downcase) }
  .sort_by { |path| path.relative_path_from(root).to_s.downcase }

entries = []
failures = []

image_paths.each do |path|
  stdout, stderr, result = Open3.capture3(
    image_magick,
    "#{path}[0]",
    "-auto-orient",
    "-format",
    "%w %h\n",
    "info:"
  )

  dimensions = stdout.lines.first&.strip&.split&.map(&:to_i)
  unless result.success? && dimensions&.length == 2 && dimensions.all?(&:positive?)
    failures << "#{path.relative_path_from(root)}: #{stderr.strip}"
    next
  end

  entries << [path.relative_path_from(root).to_s, dimensions[0], dimensions[1]]
end

unless failures.empty?
  warn "Could not read #{failures.length} image(s):"
  failures.each { |failure| warn "- #{failure}" }
  exit 1
end

output = +"# Generated from assets/images so templates can emit width/height attributes.\n"
entries.each do |relative_path, width, height|
  output << "- src: #{relative_path.to_json}\n"
  output << "  width: #{width}\n"
  output << "  height: #{height}\n"
end

if output_path.exist? && output_path.read == output
  puts "Image dimensions are already up to date (#{entries.length} images)."
else
  output_path.write(output)
  puts "Wrote #{entries.length} image dimensions to #{output_path.relative_path_from(root)}."
end
