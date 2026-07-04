(() => {
    const imageSelector = ".activity-image, .activity-image-row img, .activity-feature img";

    const createLightbox = () => {
        const root = document.createElement("div");
        root.className = "image-lightbox";
        root.setAttribute("aria-hidden", "true");

        const closeButton = document.createElement("button");
        closeButton.className = "image-lightbox-close";
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", "Close image");
        closeButton.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <path d="M6.7 5.3a1 1 0 0 1 1.4 0L12 9.2l3.9-3.9a1 1 0 1 1 1.4 1.4L13.4 10.6l3.9 3.9a1 1 0 0 1-1.4 1.4L12 12l-3.9 3.9a1 1 0 0 1-1.4-1.4l3.9-3.9-3.9-3.9a1 1 0 0 1 0-1.4Z" />
      </svg>
    `;

        const image = document.createElement("img");
        image.alt = "";

        const caption = document.createElement("p");

        root.appendChild(closeButton);
        root.appendChild(image);
        root.appendChild(caption);
        document.body.appendChild(root);

        return { root, closeButton, image, caption };
    };

    const init = () => {
        const images = document.querySelectorAll(imageSelector);
        if (!images.length) {
            return;
        }

        const lightbox = createLightbox();

        const open = (sourceImage) => {
            lightbox.image.src = sourceImage.currentSrc || sourceImage.src;
            lightbox.image.alt = sourceImage.alt || "Expanded image";
            lightbox.caption.textContent = sourceImage.alt || "";

            lightbox.root.classList.add("is-open");
            lightbox.root.setAttribute("aria-hidden", "false");
            document.body.classList.add("has-lightbox");
            lightbox.closeButton.focus();
        };

        const close = () => {
            lightbox.root.classList.remove("is-open");
            lightbox.root.setAttribute("aria-hidden", "true");
            lightbox.image.removeAttribute("src");
            lightbox.caption.textContent = "";
            document.body.classList.remove("has-lightbox");
        };

        images.forEach((imageEl) => {
            if (imageEl.closest("a")) {
                return;
            }

            imageEl.setAttribute("tabindex", "0");
            imageEl.setAttribute("role", "button");
            imageEl.setAttribute("aria-label", (imageEl.alt || "View image") + " (opens full size)");

            imageEl.addEventListener("click", () => open(imageEl));
            imageEl.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open(imageEl);
                }
            });
        });

        lightbox.closeButton.addEventListener("click", close);

        lightbox.root.addEventListener("click", (event) => {
            if (event.target === lightbox.root) {
                close();
            }
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && lightbox.root.classList.contains("is-open")) {
                close();
            }
        });
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
