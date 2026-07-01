export function nexusConfirm(message, { detail = "", okLabel = "Confirm" } = {}) {
  const dialog = ensureConfirmDialog();
  dialog.querySelector("[data-confirm-message]").textContent = message;
  dialog.querySelector("[data-confirm-detail]").textContent = detail;
  dialog.querySelector("[data-confirm-detail]").hidden = !detail;
  dialog.querySelector("[data-confirm-ok]").textContent = okLabel;

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once:true });
    if (dialog.showModal) dialog.showModal();
    else {
      dialog.setAttribute("open", "");
      dialog.classList.add("nexus-confirm-fallback-open");
    }
  });
}

function ensureConfirmDialog() {
  let dialog = document.querySelector("#nexus-confirm-dialog");
  if (dialog) return dialog;

  dialog = document.createElement("dialog");
  dialog.id = "nexus-confirm-dialog";
  dialog.className = "app-confirm-dialog nexus-confirm-dialog";
  dialog.setAttribute("aria-labelledby", "nexus-confirm-title");
  dialog.innerHTML = `
    <form method="dialog">
      <p id="nexus-confirm-title" class="eyebrow">SubLim3 Nexus says</p>
      <h2 data-confirm-message></h2>
      <p data-confirm-detail></p>
      <div class="app-confirm-actions">
        <button class="secondary-button" value="cancel" type="submit">Cancel</button>
        <button class="primary-button" value="confirm" type="submit" data-confirm-ok>Confirm</button>
      </div>
    </form>
  `;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("cancel");
  });
  dialog.addEventListener("close", () => {
    dialog.classList.remove("nexus-confirm-fallback-open");
    dialog.removeAttribute("open");
  });
  document.body.append(dialog);
  return dialog;
}
