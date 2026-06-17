// Native browser notifications for try-push completion. The browser hands these
// off to the OS — on macOS they land in Notification Center, so the alert
// surfaces *outside* hangar even when it's a background tab. Opt-in, per-browser:
// we only fire when the user has flipped the toggle AND granted permission.

const NOTIFY_KEY = "hangar.tryNotify";

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyPermission(): NotifyPermission {
  if (!notifySupported()) return "unsupported";
  return Notification.permission as NotifyPermission;
}

// Enabled = the user opted in *and* the browser still grants permission. If they
// revoke permission in OS/browser settings, this flips back to false on its own.
export function notifyEnabled(): boolean {
  if (!notifySupported() || Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotifyOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(NOTIFY_KEY, "1");
    else localStorage.removeItem(NOTIFY_KEY);
  } catch {
    /* ignore */
  }
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission !== "default") {
    return Notification.permission as NotifyPermission;
  }
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return Notification.permission as NotifyPermission;
  }
}

export interface TryDoneNotice {
  title: string; // human headline (fuzzy query / commit message)
  state: "success" | "failed";
  short_revision: string;
  url: string; // Treeherder deep link
  failed: number;
  success: number;
}

// Dev-only: preview the completion notification (look + click-through) without
// waiting for a real push to finish. Bypasses the opt-in flag, but still needs
// browser permission — the caller should request it first.
export function fireTestNotification(): void {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification("Try push finished", {
      body: "Bug 2048072 - validate skip_if_no_window_manager\nAll green · 18 jobs · e32f53280584",
      tag: "try-test",
      icon: "/notification-icon.png",
    });
    n.onclick = () => {
      window.open("https://treeherder.mozilla.org/jobs?repo=try", "_blank", "noopener");
      n.close();
    };
  } catch {
    /* best-effort */
  }
}

export function fireTryDoneNotification(p: TryDoneNotice): void {
  if (!notifyEnabled()) return;
  const ok = p.state === "success";
  const body = ok
    ? `All green · ${p.success} job${p.success === 1 ? "" : "s"} · ${p.short_revision}`
    : `${p.failed} failure${p.failed === 1 ? "" : "s"} · ${p.short_revision}`;
  try {
    const n = new Notification("Try push finished", {
      body: `${p.title}\n${body}`,
      tag: `try-${p.short_revision}`, // collapse repeats for the same push
      icon: "/notification-icon.png",
    });
    n.onclick = () => {
      window.open(p.url, "_blank", "noopener");
      n.close();
    };
  } catch {
    /* notifications are best-effort */
  }
}
