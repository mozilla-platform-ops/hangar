import { useEffect, useRef, useState } from "react";
// @ts-expect-error — noVNC ships no TypeScript declarations
import RFB from "@novnc/novnc/lib/rfb.js";
import { X, Monitor } from "lucide-react";

interface Props {
  hostname: string;
  onClose: () => void;
}

type Phase = "form" | "connecting" | "connected" | "error";

export function VncModal({ hostname, onClose }: Props) {
  const shortName = hostname.split(".")[0];
  const [phase, setPhase] = useState<Phase>("form");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [scale, setScale] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<InstanceType<typeof RFB> | null>(null);

  useEffect(() => {
    return () => {
      rfbRef.current?.disconnect();
    };
  }, []);

  function connect(e: React.FormEvent) {
    e.preventDefault();
    setPhase("connecting");
    setErrorMsg("");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/workers/${hostname}/vnc`;

    if (!containerRef.current) return;

    try {
      const rfb = new RFB(containerRef.current, url, {
        credentials: password ? { password } : undefined,
      });

      rfb.scaleViewport = scale;
      rfb.resizeSession = false;

      rfb.addEventListener("connect", () => setPhase("connected"));

      rfb.addEventListener("disconnect", (e: CustomEvent) => {
        const detail = e.detail as { clean: boolean; reason?: string };
        if (phase !== "connected") {
          setPhase("error");
          setErrorMsg(detail.reason || "Connection closed before completing handshake");
        } else {
          setErrorMsg("Session ended");
        }
      });

      rfb.addEventListener("credentialsrequired", () => {
        // If we didn't supply a password, prompt and reconnect
        if (!password) {
          rfb.disconnect();
          setPhase("form");
          setErrorMsg("VNC password required");
        }
      });

      rfbRef.current = rfb;
    } catch (err: unknown) {
      setPhase("error");
      setErrorMsg(String(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col"
        style={{ width: "min(1200px, 96vw)", height: "min(820px, 92vh)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-mono text-gray-300">
            <Monitor size={14} className="text-brand-400" />
            {shortName}
          </div>
          <div className="flex items-center gap-3">
            {phase === "connected" && (
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scale}
                  onChange={e => {
                    setScale(e.target.checked);
                    if (rfbRef.current) rfbRef.current.scaleViewport = e.target.checked;
                  }}
                  className="accent-brand-500"
                />
                Scale to fit
              </label>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-white">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col relative">
          {phase === "form" && (
            <form onSubmit={connect} className="flex flex-col gap-4 p-8 max-w-sm mx-auto w-full mt-8">
              <div className="text-center">
                <div className="text-gray-400 text-sm mb-1">VNC into</div>
                <div className="font-mono text-white font-semibold">{shortName}</div>
                {errorMsg && <div className="text-red-400 text-xs mt-2">{errorMsg}</div>}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">VNC password</label>
                <input
                  type="password"
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="leave blank if no password"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="w-full bg-brand-600 hover:bg-brand-500 text-white rounded-lg py-2 text-sm font-medium transition-colors"
              >
                Connect
              </button>
            </form>
          )}

          {phase === "connecting" && (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
              Connecting to {shortName}…
            </div>
          )}

          {phase === "error" && (
            <div className="flex flex-col items-center justify-center gap-4 p-8 flex-1">
              <div className="text-red-400 text-sm text-center">{errorMsg}</div>
              <button
                className="text-xs text-gray-400 hover:text-white underline"
                onClick={() => { setPhase("form"); }}
              >
                Try again
              </button>
            </div>
          )}

          {/* noVNC renders its own canvas into this div */}
          <div
            ref={containerRef}
            className="flex-1"
            style={{ display: phase === "connected" ? "block" : "none" }}
          />
        </div>
      </div>
    </div>
  );
}
