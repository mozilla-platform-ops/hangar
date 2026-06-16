/** Per-project (repo/branch) accent colors, shared by the Pools page and the
 *  Overview "Monitored Pools" cards so job-source legends read the same everywhere. */

export const PROJECT_COLORS: Record<string, string> = {
  try:               "bg-sky-500",
  autoland:          "bg-violet-500",
  "mozilla-central": "bg-emerald-500",
  "mozilla-beta":    "bg-amber-500",
  "mozilla-release": "bg-orange-500",
  github:            "bg-pink-500",
  other:             "bg-gray-500",
  unknown:           "bg-gray-700",
};

export const PROJECT_TEXT: Record<string, string> = {
  try:               "text-sky-400",
  autoland:          "text-violet-400",
  "mozilla-central": "text-emerald-400",
  "mozilla-beta":    "text-amber-400",
  "mozilla-release": "text-orange-400",
  github:            "text-pink-400",
  other:             "text-gray-400",
  unknown:           "text-gray-600",
};
