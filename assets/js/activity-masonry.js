(() => {
  const gallerySelector = "[data-masonry-gallery]";
  const columnClass = "activity-masonry-column";
  const readyClass = "is-masonry-ready";
  const heroThreeClass = "is-hero-three";
  const minSavingsRatio = 0.12;

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
    gallery.classList.remove(heroThreeClass);
    gallery.style.removeProperty("--masonry-columns");
    gallery.style.removeProperty("--masonry-template");
    gallery.style.removeProperty("--hero-three-template");
    gallery.replaceChildren(...images);
    return images;
  };

  const baseColumnCount = (imageCount) => {
    if (imageCount === 3) {
      return 3;
    }

    return Math.min(2, imageCount);
  };

  const masonryColumnCount = (gallery, imageCount) => {
    if (imageCount <= 1) {
      return 1;
    }

    if (window.matchMedia("(max-width: 680px)").matches) {
      return imageCount === 2 ? 2 : 1;
    }

    if (imageCount === 3) {
      return 2;
    }

    return 2;
  };

  const imageRatio = (image) => {
    if (!image.naturalWidth || !image.naturalHeight) {
      return 1;
    }
    return image.naturalHeight / image.naturalWidth;
  };

  const isLandscape = (image) => image.naturalWidth > image.naturalHeight;

  const heroThreeTemplate = (leftImage, rightImage) => {
    const leftRatio = imageRatio(leftImage);
    const rightRatio = imageRatio(rightImage);
    if (!leftRatio || !rightRatio) {
      return null;
    }

    // For closer rendered heights, give each column width inverse to its aspect ratio.
    const leftWeight = rightRatio;
    const rightWeight = leftRatio;
    const total = leftWeight + rightWeight;
    if (!total) {
      return null;
    }

    const leftFr = (leftWeight / total) * 2;
    const rightFr = (rightWeight / total) * 2;
    return `minmax(0, ${leftFr.toFixed(2)}fr) minmax(0, ${rightFr.toFixed(2)}fr)`;
  };

  const rowHeight = (ratios, columns) => {
    let height = 0;
    for (let index = 0; index < ratios.length; index += columns) {
      height += Math.max(...ratios.slice(index, index + columns));
    }
    return height;
  };

  const masonryHeights = (ratios, columns) => {
    const heights = Array(columns).fill(0);
    ratios.forEach((ratio) => {
      const targetIndex = heights.indexOf(Math.min(...heights));
      heights[targetIndex] += ratio;
    });
    return heights;
  };

  const balancedTriptych = () => null;

  const shouldUseMasonry = (ratios, baseColumns, masonryColumns) => {
    if (ratios.length === 3) {
      return false;
    }

    if (masonryColumns <= 1) {
      return false;
    }

    const baseHeight = rowHeight(ratios, baseColumns);
    const masonryHeight = Math.max(...masonryHeights(ratios, masonryColumns));
    if (masonryColumns < baseColumns) {
      return masonryHeight < baseHeight * (1 - minSavingsRatio);
    }

    if (masonryColumns === baseColumns && ratios.length > baseColumns) {
      return masonryHeight < baseHeight * (1 - minSavingsRatio);
    }

    return false;
  };

  const layoutGallery = async (gallery) => {
    const images = resetGallery(gallery);
    if (images.length <= 1) {
      return;
    }

    await waitForImages(images);

    if (images.length === 3 && isLandscape(images[0])) {
      gallery.classList.add(heroThreeClass);
      const template = heroThreeTemplate(images[1], images[2]);
      if (template) {
        gallery.style.setProperty("--hero-three-template", template);
      }
    }

    const ratios = images.map(imageRatio);
    const baseColumns = baseColumnCount(images.length);
    const count = masonryColumnCount(gallery, images.length);
    const triptych = balancedTriptych(ratios);

    if (triptych) {
      const featureColumn = document.createElement("div");
      featureColumn.className = columnClass;
      const sideColumn = document.createElement("div");
      sideColumn.className = columnClass;

      featureColumn.appendChild(images[triptych.featureIndex]);
      triptych.sideIndexes.forEach((index) => sideColumn.appendChild(images[index]));

      if (triptych.featureIndex === 0) {
        gallery.style.setProperty("--masonry-template", `${triptych.featureWidth.toFixed(2)}fr 1fr`);
        gallery.replaceChildren(featureColumn, sideColumn);
      } else {
        gallery.style.setProperty("--masonry-template", `1fr ${triptych.featureWidth.toFixed(2)}fr`);
        gallery.replaceChildren(sideColumn, featureColumn);
      }
      gallery.classList.add(readyClass);
      return;
    }

    if (!shouldUseMasonry(ratios, baseColumns, count)) {
      return;
    }

    const columns = Array.from({ length: count }, () => {
      const column = document.createElement("div");
      column.className = columnClass;
      return column;
    });
    const heights = Array(count).fill(0);

    images.forEach((image) => {
      const targetIndex = heights.indexOf(Math.min(...heights));
      columns[targetIndex].appendChild(image);
      heights[targetIndex] += imageRatio(image);
    });

    gallery.style.setProperty("--masonry-columns", String(count));
    gallery.style.removeProperty("--masonry-template");
    gallery.replaceChildren(...columns);
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
