import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { X, Terminal as TerminalIcon } from "lucide-react";

interface Props {
  hostname: string;
  onClose: () => void;
}

type Phase = "form" | "connecting" | "connected" | "error";

export function ShellModal({ hostname, onClose }: Props) {
  const shortName = hostname.split(".")[0];
  const [phase, setPhase] = useState<Phase>("form");
  const [username, setUsername] = useState("cltbld");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const termDivRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, []);

  // Mount terminal once connected
  useEffect(() => {
    if (phase !== "connected" || !termDivRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termDivRef.current);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    // Keystrokes → WebSocket
    term.onData(data => wsRef.current?.send(data));

    // Resize → WebSocket resize event
    term.onResize(({ cols, rows }) => {
      wsRef.current?.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    // Auto-fit when container resizes
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(termDivRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [phase]);

  function connect(e: React.FormEvent) {
    e.preventDefault();
    setPhase("connecting");
    setErrorMsg("");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/workers/${hostname}/shell`);
    wsRef.current = ws;

    ws.onopen = () => {
      const { cols, rows } = getInitialSize();
      ws.send(JSON.stringify({ username, password, cols, rows }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Handshake response
        try {
          const msg = JSON.parse(event.data);
          if (msg.ok) {
            setPhase("connected");
          } else {
            setPhase("error");
            setErrorMsg(msg.error || "Connection failed");
            ws.close();
          }
        } catch {
          // After handshake, text shouldn't arrive here — ignore
        }
      } else {
        // Binary terminal output — write to xterm
        (event.data as Blob).arrayBuffer().then(buf => {
          termRef.current?.write(new Uint8Array(buf));
        });
      }
    };

    ws.onclose = (ev) => {
      if (phaseRef.current === "connecting") {
        setPhase("error");
        setErrorMsg(ev.reason || "WebSocket closed before connecting — is the backend reachable?");
      } else if (phaseRef.current === "connected") {
        termRef.current?.write(`\r\n\x1b[90m[Connection closed${ev.reason ? ": " + ev.reason : ""}]\x1b[0m\r\n`);
      }
    };

    ws.onerror = () => {
      if (phaseRef.current === "connecting") {
        setPhase("error");
        setErrorMsg("WebSocket error — is the backend reachable?");
      }
    };
  }

  function getInitialSize() {
    // Estimate based on modal size; fit() will correct it once mounted
    return { cols: 120, rows: 30 };
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col"
           style={{ width: "min(1000px, 95vw)", height: "min(680px, 90vh)" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-mono text-gray-300">
            <TerminalIcon size={14} className="text-brand-400" />
            {username}@{shortName}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {phase === "form" && (
            <form onSubmit={connect} className="flex flex-col gap-4 p-8 max-w-sm mx-auto w-full mt-8">
              <div className="text-center">
                <div className="text-gray-400 text-sm mb-1">SSH into</div>
                <div className="font-mono text-white font-semibold">{shortName}</div>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Username</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Password <span className="text-gray-600">(blank = use SSH key)</span>
                  </label>
                  <input
                    type="password"
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="usually not needed"
                  />
                </div>
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
                onClick={() => { setPhase("form"); setPassword(""); }}
              >
                Try again
              </button>
            </div>
          )}

          {/* Terminal — always rendered once connected so xterm can attach */}
          <div
            ref={termDivRef}
            className="flex-1 p-2"
            style={{ display: phase === "connected" ? "block" : "none" }}
          />
        </div>
      </div>
    </div>
  );
}
