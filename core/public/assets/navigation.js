function closeSidebar(sidebar, button) {
  sidebar.classList.remove("mobile-nav-open");
  button.setAttribute("aria-expanded", "false");
}

function openSidebar(sidebar, button) {
  sidebar.classList.add("mobile-nav-open");
  button.setAttribute("aria-expanded", "true");
}

function setupMobileNavigation() {
  document.querySelectorAll(".sidebar").forEach((sidebar, index) => {
    const nav = sidebar.querySelector("nav");
    const brand = sidebar.querySelector(".brand");
    if (!nav || !brand || sidebar.querySelector(".mobile-nav-toggle")) return;

    if (!nav.id) nav.id = `sidebar-navigation-${index + 1}`;

    const button = document.createElement("button");
    button.className = "mobile-nav-toggle";
    button.type = "button";
    button.setAttribute("aria-controls", nav.id);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Open navigation menu");
    button.innerHTML = "<span></span><span></span><span></span>";
    brand.after(button);

    button.addEventListener("click", () => {
      if (sidebar.classList.contains("mobile-nav-open")) {
        closeSidebar(sidebar, button);
      } else {
        openSidebar(sidebar, button);
      }
    });

    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeSidebar(sidebar, button);
    });

    document.addEventListener("click", (event) => {
      if (!sidebar.classList.contains("mobile-nav-open")) return;
      if (sidebar.contains(event.target)) return;
      closeSidebar(sidebar, button);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSidebar(sidebar, button);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupMobileNavigation);
} else {
  setupMobileNavigation();
}
