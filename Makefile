.PHONY: build serve image-dimensions

build: image-dimensions
	bundle exec jekyll build

serve: image-dimensions
	bundle exec jekyll serve --livereload

image-dimensions:
	ruby scripts/generate_image_dimensions.rb
