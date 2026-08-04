(() => {
  const gallerySelector = "[data-masonry-gallery]";
  const rowClass = "activity-balanced-row";
  const readyClass = "is-balanced-rows";

  const debounce = (callback, delay = 160) => {
    let timeout;
    return () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(callback, delay);
    };
  };

  const waitForImages = async (images) => {
    await Promise.all(images.map(async (image) => {
      if (image.complete && image.naturalWidth) {
        return;
      }

      if (image.decode) {
        try {
          await image.decode();
          return;
        } catch (error) {
          // Fall back to load/error listeners below.
        }
      }

      await new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }));
  };

  const galleryImages = (gallery) => Array.from(gallery.querySelectorAll("img"))
    .sort((a, b) => Number(a.dataset.masonryOrder || 0) - Number(b.dataset.masonryOrder || 0));

  const resetGallery = (gallery) => {
    const images = galleryImages(gallery);
    images.forEach((image, index) => {
      if (!image.dataset.masonryOrder) {
        image.dataset.masonryOrder = String(index);
      }
    });

    gallery.classList.remove(readyClass);
    gallery.replaceChildren(...images);
    return images;
  };

  const imageRatio = (image) => {
    const width = image.naturalWidth || Number(image.getAttribute("width"));
    const height = image.naturalHeight || Number(image.getAttribute("height"));
    if (!width || !height) {
      return 1;
    }

    return width / height;
  };

  const hasImageDimensions = (image) => {
    if (image.naturalWidth && image.naturalHeight) {
      return true;
    }

    return Boolean(Number(image.getAttribute("width")) && Number(image.getAttribute("height")));
  };

  const isLandscape = (image) => imageRatio(image) > 1;

  const rowSize = (imageCount) => {
    if (window.matchMedia("(max-width: 680px)").matches) {
      return 1;
    }

    if (window.matchMedia("(max-width: 900px)").matches) {
      return 2;
    }

    return imageCount > 6 ? 3 : 2;
  };

  const shouldFeatureFirstImage = (gallery, images) => {
    if (gallery.classList.contains("is-feature-first")) {
      return true;
    }

    return images.length === 3 && isLandscape(images[0]);
  };

  const balancedTemplate = (images) => images
    .map((image) => `minmax(0, ${imageRatio(image).toFixed(4)}fr)`)
    .join(" ");

  const createRow = (images) => {
    const row = document.createElement("div");
    row.className = rowClass;
    row.style.setProperty("--balanced-row-template", balancedTemplate(images));
    row.append(...images);
    return row;
  };

  const layoutGallery = async (gallery) => {
    const images = resetGallery(gallery);
    if (!images.length) {
      return;
    }

    if (!images.every(hasImageDimensions)) {
      await waitForImages(images);
    }

    const rows = [];
    let nextImageIndex = 0;

    if (images.length > 1 && shouldFeatureFirstImage(gallery, images)) {
      rows.push(createRow([images[0]]));
      nextImageIndex = 1;
    }

    const imagesPerRow = rowSize(images.length - nextImageIndex);
    for (let index = nextImageIndex; index < images.length; index += imagesPerRow) {
      rows.push(createRow(images.slice(index, index + imagesPerRow)));
    }

    gallery.replaceChildren(...rows);
    gallery.classList.add(readyClass);
  };

  const layoutAll = () => {
    document.querySelectorAll(gallerySelector).forEach((gallery) => {
      layoutGallery(gallery);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", layoutAll);
  } else {
    layoutAll();
  }

  window.addEventListener("resize", debounce(layoutAll));
  document.addEventListener("dirigo:updates-rendered", layoutAll);
})();
