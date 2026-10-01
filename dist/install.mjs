let prompt;
const button = document.getElementById("installApp");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  prompt = e;
});
window.addEventListener("appinstalled", () => {
  button.hidden = true;
  prompt = null;
});
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone)
  button.hidden = true;
button.onclick = async () => {
  if (prompt) {
    await prompt.prompt();
    prompt = null;
  } else document.getElementById("installHelp").showModal();
};
let updateGuard = async () => false;
export function setUpdateGuard(guard) {
  updateGuard = guard;
}
if ("serviceWorker" in navigator && isSecureContext) {
  let waiting,
    activating = false;
  const update = document.getElementById("updateApp");
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      const ready = () => {
        waiting = registration.waiting;
        if (waiting && navigator.serviceWorker.controller)
          update.hidden = false;
      };
      ready();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", ready);
      });
    })
    .catch(() => {});
  update.onclick = async () => {
    if (!waiting || activating || !(await updateGuard())) return;
    activating = true;
    update.disabled = true;
    waiting.postMessage({ type: "ACTIVATE_UPDATE" });
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (activating) location.reload();
  });
}
window.addEventListener(
  "online",
  () => (document.getElementById("offlineNote").hidden = true),
);
window.addEventListener(
  "offline",
  () => (document.getElementById("offlineNote").hidden = false),
);
document.getElementById("offlineNote").hidden = navigator.onLine;
