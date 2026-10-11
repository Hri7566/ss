// `fresh` marks an offer from a brand-new peer connection (vs. an ICE restart
// on the existing one); `bye` means the other side is leaving on purpose.
type Signal = {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  fresh?: boolean;
  bye?: boolean;
};
type ServerMsg =
  | { type: "viewer-joined"; id: string }
  | { type: "viewer-left"; id: string }
  | { type: "signal"; from?: string; data: Signal }
  | { type: "waiting" }
  | { type: "host-left" }
  | { type: "error"; message: string };

// STUN plus any TURN relays configured on the server (see README).
const RTC_CONFIG: RTCConfiguration = await fetch("/api/ice")
  .then(r => r.json() as Promise<RTCIceServer[]>)
  .then(iceServers => ({ iceServers }))
  .catch(() => ({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const startSection = $<HTMLElement>("start");
const roomSection = $<HTMLElement>("room");
const shareBtn = $<HTMLButtonElement>("share-btn");
const shareNoAudioBtn = $<HTMLButtonElement>("share-no-audio-btn");
const startError = $<HTMLParagraphElement>("start-error");
const hostBar = $<HTMLDivElement>("host-bar");
const linkInput = $<HTMLInputElement>("link");
const copyBtn = $<HTMLButtonElement>("copy-btn");
const stopBtn = $<HTMLButtonElement>("stop-btn");
const viewerCount = $<HTMLSpanElement>("viewer-count");
const statusEl = $<HTMLParagraphElement>("status");
const video = $<HTMLVideoElement>("video");

function setStatus(text: string) {
  statusEl.textContent = text;
}

type Signaling = { send(msg: object): void; close(): void };

// A signaling socket that reconnects on its own. The id is kept across
// reconnects so the server and the other side see the same peer come back.
// Video flows peer-to-peer, so it keeps playing while this is down.
function signaling(
  room: string,
  role: "host" | "viewer",
  handle: (msg: ServerMsg) => Promise<void>,
  onState: (connected: boolean) => void = () => {},
): Signaling {
  const id = crypto.randomUUID();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket;
  let closed = false;
  let delay = 1000;
  // Handle messages strictly in order. With a plain async onmessage, an ICE
  // candidate can be processed while setRemoteDescription is still pending,
  // which throws and drops the candidate, so the peer may never connect.
  let queue = Promise.resolve();

  const open = () => {
    ws = new WebSocket(`${proto}//${location.host}/ws?room=${room}&role=${role}&id=${id}`);
    ws.onopen = () => {
      delay = 1000;
      onState(true);
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      queue = queue.then(() => handle(msg)).catch(err => console.error("signaling error:", err));
    };
    ws.onclose = () => {
      if (closed) return;
      onState(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();

  return {
    send: msg => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => {
      closed = true;
      ws.close();
    },
  };
}

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => (b % 36).toString(36)).join("");
}

// ---------- Host ----------

function showStartError(err: unknown) {
  startError.textContent = `Couldn't start sharing: ${(err as Error).message}`;
  shareNoAudioBtn.hidden = false;
}

// Only a frame-rate hint; the browser's own picker decides what's shared.
const VIDEO: MediaTrackConstraints = { frameRate: { ideal: 60 } };

async function captureScreen(withAudio: boolean): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: VIDEO, audio: withAudio });
  } catch (err) {
    const name = (err as DOMException).name;
    // A denied permission or dismissed picker can't be told apart from a denied
    // audio grant, so don't re-prompt on our own; let the user pick video-only.
    if (!withAudio || name === "NotAllowedError" || name === "AbortError") {
      showStartError(err);
      return null;
    }
  }
  // Audio was unsupported or unavailable: fall back to video only.
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: VIDEO, audio: false });
  } catch (err) {
    showStartError(err);
    return null;
  }
}

// Screen shares default to keeping text sharp at the cost of frame rate, with a
// low bitrate cap. Favor smoothness and allow much more bandwidth instead.
async function tuneSender(sender: RTCRtpSender) {
  if (sender.track?.kind !== "video") return;
  const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
  for (const enc of params.encodings) {
    enc.maxBitrate = 8_000_000;
    enc.maxFramerate = 60;
  }
  params.degradationPreference = "maintain-framerate";
  await sender.setParameters(params).catch(err => console.warn("couldn't tune sender:", err));
}

async function startHost(withAudio: boolean) {
  startError.textContent = "";
  const stream = await captureScreen(withAudio);
  if (!stream) return;
  for (const track of stream.getVideoTracks()) track.contentHint = "motion";

  const room = newRoomId();
  history.pushState(null, "", `/s/${room}`);
  linkInput.value = location.href;

  startSection.hidden = true;
  roomSection.hidden = false;
  hostBar.hidden = false;
  video.srcObject = stream;
  setStatus("You're sharing. Send the link above to anyone who should watch.");

  const peers = new Map<string, RTCPeerConnection>();
  // Viewers whose signaling socket is currently connected.
  const present = new Set<string>();

  const sendSignal = (to: string, data: Signal) => sig.send({ type: "signal", to, data });
  const updateCount = () =>
    (viewerCount.textContent = `${peers.size} viewer${peers.size === 1 ? "" : "s"}`);

  const closePeer = (id: string) => {
    peers.get(id)?.close();
    peers.delete(id);
    updateCount();
  };

  // Try to repair a broken connection in place, e.g. after a viewer's network
  // changes. Needs the viewer's signaling socket to be up.
  const restartIce = async (id: string, pc: RTCPeerConnection) => {
    if (!present.has(id)) return;
    // An earlier offer may have been lost while signaling was down; start over.
    if (pc.signalingState !== "stable") return createPeer(id);
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    sendSignal(id, { sdp: pc.localDescription!.toJSON() });
  };

  const createPeer = async (id: string) => {
    closePeer(id);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers.set(id, pc);
    updateCount();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = e => e.candidate && sendSignal(id, { candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (peers.get(id) !== pc) return;
      switch (pc.connectionState) {
        case "failed":
          if (present.has(id)) restartIce(id, pc).catch(console.error);
          else closePeer(id);
          break;
        case "disconnected":
          // Often recovers on its own; restart if it hasn't after a few seconds.
          setTimeout(() => {
            if (pc.connectionState === "disconnected") restartIce(id, pc).catch(console.error);
          }, 5000);
          break;
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.all(pc.getSenders().map(tuneSender));
    sendSignal(id, { sdp: pc.localDescription!.toJSON(), fresh: true });
  };

  const sig = signaling(room, "host", async msg => {
    switch (msg.type) {
      case "viewer-joined": {
        // Also sent for every viewer when the host's own socket reconnects.
        present.add(msg.id);
        const pc = peers.get(msg.id);
        const state = pc?.connectionState;
        if (state === "connected") break;
        if (pc && (state === "disconnected" || state === "failed")) await restartIce(msg.id, pc);
        else await createPeer(msg.id);
        break;
      }
      case "viewer-left": {
        // A dropped socket doesn't mean the video is gone; only drop the peer
        // if it isn't connected. Otherwise wait for the viewer to come back.
        present.delete(msg.id);
        if (peers.get(msg.id)?.connectionState !== "connected") closePeer(msg.id);
        break;
      }
      case "signal": {
        const pc = msg.from && peers.get(msg.from);
        if (!pc || !msg.from) return;
        if (msg.data.bye) {
          present.delete(msg.from);
          closePeer(msg.from);
          return;
        }
        if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
        if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate);
        break;
      }
      case "error":
        setStatus(msg.message);
        break;
    }
  });

  const sayBye = () => {
    for (const id of peers.keys()) sendSignal(id, { bye: true });
  };

  const stop = () => {
    sayBye();
    for (const t of stream.getTracks()) t.stop();
    for (const id of [...peers.keys()]) closePeer(id);
    sig.close();
    hostBar.hidden = true;
    video.srcObject = null;
    setStatus("Sharing stopped.");
  };

  addEventListener("pagehide", sayBye);
  stopBtn.onclick = stop;
  // Fires when the user hits the browser's own "Stop sharing" button.
  stream.getVideoTracks()[0]?.addEventListener("ended", stop);
}

// ---------- Viewer ----------

function startViewer(room: string) {
  startSection.hidden = true;
  roomSection.hidden = false;
  // Viewers get the share link too, just not the host-only controls.
  linkInput.value = location.href;
  hostBar.hidden = false;
  viewerCount.hidden = true;
  stopBtn.hidden = true;
  // No player controls; clicking the video toggles sound instead.
  video.onclick = () => (video.muted = !video.muted);
  setStatus("Connecting…");

  let pc: RTCPeerConnection | undefined;
  let stopped = false;
  const live = () => pc?.connectionState === "connected";
  const sendSignal = (data: Signal) => sig.send({ type: "signal", data });

  const createPeer = () => {
    pc?.close();
    const peer = new RTCPeerConnection(RTC_CONFIG);
    pc = peer;
    peer.onicecandidate = e => e.candidate && sendSignal({ candidate: e.candidate.toJSON() });
    peer.ontrack = e => (video.srcObject = e.streams[0] ?? new MediaStream([e.track]));
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      switch (peer.connectionState) {
        case "connected":
          setStatus("Live. Click the video to toggle sound.");
          break;
        case "disconnected":
          setStatus("Connection interrupted, reconnecting…");
          break;
        case "failed":
          setStatus(
            "Lost the connection to the host, trying again… If this keeps happening, your network may be blocking peer-to-peer video.",
          );
          break;
      }
    };
    return peer;
  };

  const sig = signaling(
    room,
    "viewer",
    async msg => {
      switch (msg.type) {
        case "waiting":
          if (!live()) setStatus("Waiting for the host to start sharing…");
          break;
        case "host-left":
          // The host's socket may just be reconnecting; the video can carry on.
          if (!live() && !stopped) setStatus("Waiting for the host to reconnect…");
          break;
        case "signal": {
          const { data } = msg;
          if (data.bye) {
            stopped = true;
            pc?.close();
            pc = undefined;
            video.srcObject = null;
            setStatus("The host stopped sharing.");
          } else if (data.sdp?.type === "offer") {
            stopped = false;
            // A fresh offer needs a new connection; an ICE restart reuses ours.
            const peer = data.fresh || !pc || pc.signalingState === "closed" ? createPeer() : pc;
            await peer.setRemoteDescription(data.sdp);
            await peer.setLocalDescription(await peer.createAnswer());
            sendSignal({ sdp: peer.localDescription!.toJSON() });
          } else if (data.candidate && pc) {
            await pc.addIceCandidate(data.candidate);
          }
          break;
        }
      }
    },
    connected => {
      if (!connected && !live() && !stopped) setStatus("Reconnecting to server…");
    },
  );

  addEventListener("pagehide", () => sendSignal({ bye: true }));
}

// ---------- Routing ----------

copyBtn.onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
};

const match = location.pathname.match(/^\/s\/([a-z0-9]+)$/);
if (match?.[1]) {
  startViewer(match[1]);
} else {
  startSection.hidden = false;
  shareBtn.onclick = () => startHost(true);
  shareNoAudioBtn.onclick = () => startHost(false);
}
