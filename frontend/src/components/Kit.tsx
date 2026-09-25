import { KIT_POSES, type KitPose } from "../lib/kit";

/** Kit in a given pose. Keyed on the pose, so a change of mood plays the entrance
 *  again instead of swapping silently: the fleet's state is felt, not just read. */
export function Kit({ pose, size = 72, className = "" }: { pose: KitPose; size?: number; className?: string }) {
  return (
    <img
      key={pose}
      src={KIT_POSES[pose]}
      alt="Kit, the Firefox mascot"
      width={size}
      height={size}
      className={`kit-in object-contain object-bottom select-none ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
