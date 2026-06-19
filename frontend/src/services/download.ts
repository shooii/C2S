const DOWNLOAD_FRAME_TTL_MS = 30 * 60_000;

export function startDownload(url: string): void {
  if (!url || typeof document === "undefined") {
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.title = "download";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.display = "none";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";

  document.body.appendChild(iframe);
  iframe.src = url;

  window.setTimeout(() => {
    iframe.remove();
  }, DOWNLOAD_FRAME_TTL_MS);
}
