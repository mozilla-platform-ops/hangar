/** Dynamic favicon: the Hangar dart, with a red count badge when alerts are active.
 *  Pinned tabs only show the favicon (not the title), so this is how a pinned
 *  Hangar tab signals trouble. */

let lastCount: number | null = null;

export function setFavicon(alertCount: number) {
  if (lastCount === alertCount) return;
  lastCount = alertCount;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // The dart from HangarLogo (viewBox 0 0 24 24), scaled to 64px.
  const s = 64 / 24;
  const grad = ctx.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#FF9400");
  grad.addColorStop(0.5, "#FF1AD9");
  grad.addColorStop(1, "#9059FF");
  ctx.beginPath();
  ctx.moveTo(22 * s, 2 * s); ctx.lineTo(15 * s, 22 * s); ctx.lineTo(11 * s, 13 * s); ctx.lineTo(2 * s, 9 * s);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(22 * s, 2 * s); ctx.lineTo(11 * s, 13 * s); ctx.lineTo(2 * s, 9 * s);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fill();

  if (alertCount > 0) {
    ctx.beginPath();
    ctx.arc(45, 19, 17, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 24px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(alertCount > 9 ? "9+" : String(alertCount), 45, 21);
  }

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}
