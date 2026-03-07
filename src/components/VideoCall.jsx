import { useRef, useState, useEffect } from 'react';
import { db } from '../../firebase.config.js';
import {
  collection, doc, setDoc, getDoc,
  onSnapshot, addDoc,
} from 'firebase/firestore';

const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

const isElectron = !!window.electron;

export default function VideoCall() {
  const localVideoRef   = useRef(null);
  const remoteVideoRef  = useRef(null);
  const localCanvasRef  = useRef(null);
  const remoteCanvasRef = useRef(null);
  const pcRef           = useRef(null);
  const dataChannelRef  = useRef(null);
  const lastSentRef     = useRef(0);

  const [callId,          setCallId]          = useState('');
  const [joinInput,       setJoinInput]       = useState('');
  const [status,          setStatus]          = useState('idle'); // idle|picking|sharing|calling|connected
  const [role,            setRole]            = useState('none'); // none|novice|expert
  const [log,             setLog]             = useState([]);
  const [sources,         setSources]         = useState([]);
  const [pendingPC,       setPendingPC]       = useState(null);
  const [selectedTitle,   setSelectedTitle]   = useState('');    // window title for OS tracking

  const addLog = (msg) => setLog((prev) => [...prev, msg]);

  // When novice call connects in Electron, pass the selected window title to main process
  useEffect(() => {
    if (status === 'connected' && role === 'novice' && isElectron) {
      window.electron.enterOverlayMode(selectedTitle);
    }
  }, [status, role]);

  // Draw ghost cursor on a canvas at pixel coords
  function drawCursor(canvas, x, y) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.beginPath();
    ctx.arc(x, y, 14, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Set up peer connection
  function initPC() {
    const pc = new RTCPeerConnection(servers);

    const dc = pc.createDataChannel('guidance');
    dc.onopen = () => addLog('Data channel open');
    dc.onmessage = (e) => handleIncomingMessage(e.data);
    dataChannelRef.current = dc;

    pc.ondatachannel = (e) => {
      const remote = e.channel;
      remote.onopen = () => addLog('Remote data channel open');
      remote.onmessage = (ev) => handleIncomingMessage(ev.data);
      dataChannelRef.current = remote;
    };

    pc.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
      addLog('Remote stream connected');
    };

    pcRef.current = pc;
    return pc;
  }

  // Novice: share screen
  async function shareScreen() {
    const pc = initPC();
    setRole('novice');

    if (isElectron) {
      const srcs = await window.electron.getSources();
      setSources(srcs);
      setStatus('picking');
      setPendingPC(pc);
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      setStatus('sharing');
      addLog('Screen shared. Click "Create Call" to continue.');
    }
  }

  async function selectSource(source) {
    // Store the window title so main process can track it via OS APIs
    setSelectedTitle(source.name);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
        },
      },
    });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((track) => pendingPC.addTrack(track, stream));
    setStatus('sharing');
    setSources([]);
    addLog(`Screen shared: ${source.name}`);
  }

  // Novice: create call
  async function createCall() {
    const pc = pcRef.current;
    const callDoc = doc(collection(db, 'calls'));
    const offerCandidates  = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    setCallId(callDoc.id);

    pc.onicecandidate = (e) => {
      if (e.candidate) addDoc(offerCandidates, e.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(callDoc, { offer: { type: offer.type, sdp: offer.sdp } });

    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        addLog('Expert connected!');
        setStatus('connected');
      }
    });

    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added')
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      });
    });

    setStatus('calling');
    addLog(`Call created. Share this ID with the expert: ${callDoc.id}`);
  }

  // Expert: join call
  async function joinCall() {
    const pc = initPC();
    setRole('expert');
    const callDoc = doc(db, 'calls', joinInput);
    const answerCandidates = collection(callDoc, 'answerCandidates');
    const offerCandidates  = collection(callDoc, 'offerCandidates');

    pc.onicecandidate = (e) => {
      if (e.candidate) addDoc(answerCandidates, e.candidate.toJSON());
    };

    const callSnap = await getDoc(callDoc);
    if (!callSnap.exists()) {
      addLog('Error: Call ID not found. Make sure the novice created the call first.');
      return;
    }

    const callData = callSnap.data();
    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await setDoc(callDoc, { answer: { type: answer.type, sdp: answer.sdp } }, { merge: true });

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added')
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      });
    });

    setStatus('connected');
    addLog('Joined call. Waiting for novice screen...');
  }

  // Expert: mouse over remote video — send normalised coords (0–1)
  function handleExpertMouseMove(e) {
    const now = Date.now();
    if (now - lastSentRef.current < 16) return;
    lastSentRef.current = now;

    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top)  / rect.height;
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;

    // Draw on expert's own canvas so they see their cursor
    drawCursor(canvas, normX * canvas.width, normY * canvas.height);

    // Send normalised coords to novice
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'cursor', x: normX, y: normY }));
    }
  }

  // Novice: receive cursor from expert
  function handleIncomingMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'cursor') {
      if (isElectron) {
        // In Electron: forward to overlay window via IPC
        window.electron.sendCursor({ x: msg.x, y: msg.y });
      } else {
        // In browser: draw on local canvas preview
        const c = localCanvasRef.current;
        if (c) drawCursor(c, msg.x * c.width, msg.y * c.height);
      }
    }
  }

  // End call
  function endCall() {
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localVideoRef.current?.srcObject) {
      localVideoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current?.srcObject) remoteVideoRef.current.srcObject = null;
    if (isElectron) window.electron.exitOverlayMode();
    setStatus('idle');
    setRole('none');
    setCallId('');
    setSelectedTitle('');
    addLog('Call ended.');
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h1>Marco Polo</h1>

      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        <div>
          <p style={{ margin: '0 0 6px' }}>Your Screen (Novice)</p>
          <div style={{ position: 'relative', width: 420, height: 300 }}>
            <video ref={localVideoRef} autoPlay muted playsInline
              style={{ width: 420, height: 300, background: '#111', display: 'block' }} />
            <canvas ref={localCanvasRef} width={420} height={300}
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
          </div>
        </div>
        <div>
          <p style={{ margin: '0 0 6px' }}>Novice Screen (Expert view)</p>
          <div style={{ position: 'relative', width: 420, height: 300 }}
            onMouseMove={role === 'expert' ? handleExpertMouseMove : undefined}>
            <video ref={remoteVideoRef} autoPlay playsInline
              style={{ width: 420, height: 300, background: '#111', display: 'block' }} />
            <canvas ref={remoteCanvasRef} width={420} height={300}
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
          </div>
        </div>
      </div>

      {sources.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 'bold' }}>Select a window to share:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {sources.map((source) => (
              <div key={source.id} onClick={() => selectSource(source)}
                style={{
                  cursor: 'pointer', padding: '8px 12px',
                  background: '#333', color: '#fff', borderRadius: 6, fontSize: 13,
                }}>
                {source.name}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={shareScreen} disabled={status !== 'idle'}>
          1. Share My Screen (Novice)
        </button>
        <button onClick={createCall} disabled={status !== 'sharing'}>
          2. Create Call (Novice)
        </button>
        <input placeholder="Enter Call ID" value={joinInput}
          onChange={(e) => setJoinInput(e.target.value)}
          style={{ padding: '6px 10px' }} />
        <button onClick={joinCall} disabled={!joinInput || status !== 'idle'}>
          3. Join Call (Expert)
        </button>
        <button onClick={endCall} disabled={status === 'idle'}
          style={{ background: '#c0392b', color: '#fff' }}>
          End Call
        </button>
      </div>

      {callId && (
        <div style={{ padding: 12, background: '#646cffaa', borderRadius: 6, marginBottom: 16 }}>
          <strong>Call ID (share with expert):</strong> {callId}
        </div>
      )}

      <div style={{
        background: '#1e1e1e', color: '#d4d4d4', padding: 12,
        borderRadius: 6, minHeight: 120, fontFamily: 'monospace', fontSize: 13,
      }}>
        {log.length === 0
          ? <span style={{ opacity: 0.4 }}>Logs will appear here...</span>
          : log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
