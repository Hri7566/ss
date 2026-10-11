type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type ServerMsg =
  | { type: "viewer-joined"; id: string }
  | { type: "viewer-left"; id: string }
  | { type: "signal"; from?: string; data: Signal }
  | { type: "waiting" }
  | { type: "host-left" }
  | { type: "error"; message: string };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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

function connect(room: string, role: "host" | "viewer"): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${location.host}/ws?room=${room}&role=${role}`);
}

// Handle messages strictly in order. With a plain async onmessage, an ICE
// candidate can be processed while setRemoteDescription is still pending,
// which throws and drops the candidate, so the peer may never connect.
function onMessages(ws: WebSocket, handle: (msg: ServerMsg) => Promise<void>) {
  let queue = Promise.resolve();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    queue = queue.then(() => handle(msg)).catch(err => console.error("signaling error:", err));
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
  const ws = connect(room, "host");
  const sendSignal = (to: string, data: Signal) =>
    ws.send(JSON.stringify({ type: "signal", to, data }));
  const updateCount = () =>
    (viewerCount.textContent = `${peers.size} viewer${peers.size === 1 ? "" : "s"}`);

  const closePeer = (id: string) => {
    peers.get(id)?.close();
    peers.delete(id);
    updateCount();
  };

  onMessages(ws, async msg => {
    switch (msg.type) {
      case "viewer-joined": {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        peers.set(msg.id, pc);
        updateCount();
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        pc.onicecandidate = e => e.candidate && sendSignal(msg.id, { candidate: e.candidate.toJSON() });
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") closePeer(msg.id);
        };
        await pc.setLocalDescription(await pc.createOffer());
        await Promise.all(pc.getSenders().map(tuneSender));
        sendSignal(msg.id, { sdp: pc.localDescription!.toJSON() });
        break;
      }
      case "viewer-left":
        closePeer(msg.id);
        break;
      case "signal": {
        const pc = msg.from && peers.get(msg.from);
        if (!pc) return;
        if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
        if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate);
        break;
      }
      case "error":
        setStatus(msg.message);
        break;
    }
  });

  const stop = () => {
    for (const t of stream.getTracks()) t.stop();
    for (const id of [...peers.keys()]) closePeer(id);
    ws.close();
    hostBar.hidden = true;
    video.srcObject = null;
    setStatus("Sharing stopped.");
  };

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

  const ws = connect(room, "viewer");
  let pc: RTCPeerConnection | undefined;
  const sendSignal = (data: Signal) => ws.send(JSON.stringify({ type: "signal", data }));

  onMessages(ws, async msg => {
    switch (msg.type) {
      case "waiting":
        setStatus("Waiting for the host to start sharing…");
        break;
      case "host-left":
        pc?.close();
        pc = undefined;
        video.srcObject = null;
        setStatus("The host stopped sharing.");
        break;
      case "signal": {
        if (msg.data.sdp?.type === "offer") {
          pc?.close();
          pc = new RTCPeerConnection(RTC_CONFIG);
          pc.onicecandidate = e => e.candidate && sendSignal({ candidate: e.candidate.toJSON() });
          pc.onconnectionstatechange = () => {
            if (pc?.connectionState === "failed") {
              setStatus("Couldn't connect to the host. A firewall or strict network may be blocking peer-to-peer video.");
            }
          };
          pc.ontrack = e => {
            video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
            setStatus("Live. Click the video to toggle sound.");
          };
          await pc.setRemoteDescription(msg.data.sdp);
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal({ sdp: pc.localDescription!.toJSON() });
        } else if (msg.data.candidate && pc) {
          await pc.addIceCandidate(msg.data.candidate);
        }
        break;
      }
    }
  });

  ws.onclose = () => {
    if (!video.srcObject) setStatus("Disconnected from server.");
  };
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
