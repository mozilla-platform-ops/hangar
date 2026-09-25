import alert from "../assets/kit/alert.svg";
import checkmark from "../assets/kit/checkmark.svg";
import heart from "../assets/kit/heart.svg";
import inquisitive from "../assets/kit/inquisitive.svg";
import juggling from "../assets/kit/juggling.svg";
import lookingForward from "../assets/kit/looking-forward.svg";
import lookingUp from "../assets/kit/looking-up.svg";
import meditating from "../assets/kit/meditating.svg";
import painting from "../assets/kit/painting.svg";
import proud from "../assets/kit/proud.svg";
import sparkles from "../assets/kit/sparkles.svg";

// Kit, the Firefox mascot. Official artwork from mozilla-central (MPL-2.0; see the
// header in each SVG). To add a pose, drop its SVG in assets/kit and list it here.
export const KIT_POSES = {
  alert, checkmark, heart, inquisitive, juggling, lookingForward, lookingUp, meditating, painting, proud, sparkles,
} as const;
export type KitPose = keyof typeof KIT_POSES;

/** Poses that carry no signal, so Kit can change them freely on each visit. The others
 *  each mean something (a long queue, Macs down, release day) and only appear then. */
export const IDLE_POSES: KitPose[] = ["lookingUp", "lookingForward", "heart", "painting", "sparkles"];

const LAST_IDLE_KEY = "hangar.kit.lastIdle";

/** A different idle pose from last visit's, so every refresh visibly changes. */
export function pickIdlePose(): KitPose {
  let last: string | null = null;
  try { last = sessionStorage.getItem(LAST_IDLE_KEY); } catch { /* storage blocked */ }
  const choices = IDLE_POSES.filter(p => p !== last);
  const pose = choices[Math.floor(Math.random() * choices.length)];
  try { sessionStorage.setItem(LAST_IDLE_KEY, pose); } catch { /* storage blocked */ }
  return pose;
}

export interface KitMood {
  pose: KitPose;
  says: string;
}

export interface FleetReading {
  pending: number | null;
  running: number | null;
  /** The last 48h of fleet-wide samples, so "busy" means busy for this fleet. */
  history: { pending: number; running: number }[];
  /** macOS workers quarantined or missing from Taskcluster, and the macOS total. */
  macAttention: number;
  macTotal: number;
  /** Firefox version shipping today, if today is a release day. */
  shipsToday: string | null;
  /** Pose to use when nothing notable is happening (chosen once per visit). */
  idlePose: KitPose;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const n = (v: number) => Math.round(v).toLocaleString();
/** Percent difference between a and b, relative to `base` (defaults to b). */
const pct = (a: number, b: number, base = b) => Math.round(((a - b) / base) * 100);

/** How Kit reads the fleet right now. Fleet-wide pending is never small (a couple of
 *  pools are always backed up), so every judgement is against this fleet's own last
 *  48 hours rather than a fixed number. Checked in priority order: the first match wins.
 *  The Fleet Load card already shows the running/pending counts, so Kit never repeats
 *  them; it says how today compares instead. */
export function kitMood(r: FleetReading): KitMood {
  if (r.shipsToday) return { pose: "proud", says: `Firefox ${r.shipsToday} ships today.` };
  if (r.pending == null || r.running == null) return { pose: r.idlePose, says: "Checking on the fleet…" };

  const enoughHistory = r.history.length >= 12; // an hour of 5-minute samples
  const usualPending = median(r.history.map(h => h.pending));
  const usualRunning = median(r.history.map(h => h.running));

  if (enoughHistory && r.pending >= 500 && r.pending >= usualPending * 1.5) {
    return { pose: "alert", says: `The queue's ${(r.pending / usualPending).toFixed(1)}× its usual length.` };
  }
  if (r.macAttention >= 10 && r.macTotal > 0 && r.macAttention / r.macTotal >= 0.05) {
    return { pose: "inquisitive", says: `${n(r.macAttention)} Macs need a look.` };
  }
  if (enoughHistory && usualRunning > 0 && r.running >= usualRunning * 1.1) {
    return { pose: "juggling", says: `Busier than usual: ${pct(r.running, usualRunning)}% above the last two days.` };
  }
  if (enoughHistory && usualRunning > 0 && r.running <= usualRunning * 0.6) {
    return { pose: "meditating", says: `Quiet hours: ${pct(usualRunning, r.running, usualRunning)}% below the usual.` };
  }
  return { pose: r.idlePose, says: enoughHistory ? "All steady. Nothing unusual in the fleet." : "Keeping watch while the history fills in." };
}
