import { useRef, useState, useEffect } from 'react';
import { db } from '../../firebase.config.js';
import { collection, doc, setDoc, getDoc, onSnapshot, addDoc } from 'firebase/firestore';
import { useStuckDetector } from '../hooks/useStuckDetector.js';

const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };
const isElectron = !!window.electron;

export default function VideoCall() {
  const localVideoRef        = useRef(null);
  const remoteVideoRef       = useRef(null);
  const localCanvasRef       = useRef(null);
  const remoteCanvasRef      = useRef(null);  // expert cursor layer
  const expertNotesCanvasRef = useRef(null);  // expert note layer — never cleared by cursor drawing
  const pcRef                = useRef(null);
  const dataChannelRef       = useRef(null);
  const lastSentRef          = useRef(0);
  const pendingPCRef         = useRef(null);
  const expertNotesRef       = useRef([]);    // { normX, normY, text } — persists across redraws

  const [callId,         setCallId]         = useState('');
  const [joinInput,      setJoinInput]      = useState('');
  const [status,         setStatus]         = useState('idle');
  const [role,           setRole]           = useState('none');
  const [log,            setLog]            = useState([]);
  const [sources,        setSources]        = useState([]);
  const [selectedTitle,  setSelectedTitle]  = useState('');
  const [helpRequest,    setHelpRequest]    = useState('');
  const [cursorTag,      setCursorTag]      = useState('world_space');
  const [noteMode,       setNoteMode]       = useState(false);
  const [isPlayingBack,  setIsPlayingBack]  = useState(false);
  const [hasRecording,   setHasRecording]   = useState(false);
  const [stampResponse,  setStampResponse]  = useState(null);
  const [showStampPanel, setShowStampPanel] = useState(false);
  const [expertFullscreen, setExpertFullscreen] = useState(false);

  const cursorRecordingRef = useRef([]);
  const recordingStartRef  = useRef(null);
  const sessionRecorderRef = useRef(null);
  const sessionAudioRef    = useRef(null);

  const addLog = (msg) => setLog((prev) => [...prev, msg]);

  const { isStuck, camReady } = useStuckDetector(role === 'novice');

  const isExpertConnected = role === 'expert' && status === 'connected';

  // Expert view dimensions
  const expertW = expertFullscreen ? (window.innerWidth  - 40) : isExpertConnected ? 820 : 420;
  const expertH = expertFullscreen ? (window.innerHeight - 200) : isExpertConnected ? 560 : 300;

  // When novice connects in Electron, hand off to overlay
  useEffect(() => {
    if (status === 'connected' && role === 'novice' && isElectron)
      window.electron.enterOverlayMode(selectedTitle);
  }, [status, role]);

  // Record expert mic audio for session playback
  useEffect(() => {
    if (status === 'connected' && role === 'expert') {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          sessionAudioRef.current = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
          setHasRecording(true);
        };
        recorder.start(250);
        sessionRecorderRef.current = recorder;
      });
    }
  }, [status, role]);

  // Forward stuck state to overlay
  useEffect(() => {
    if (!isElectron) return;
    const t = setTimeout(() => {
      if (role === 'novice' && status === 'connected') window.electron.sendStuck(isStuck);
    }, 500);
    return () => clearTimeout(t);
  }, [isStuck, status, role]);

  // Receive help request from overlay → send to expert via data channel
  useEffect(() => {
    if (!isElectron) return;
    window.electron.onHelpRequest(async (text) => {
      if (text === 'Transcribing...' || text === 'Recording...') return;
      addLog(`Help request sent: "${text}"`);
      const dc = dataChannelRef.current;
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'help-request', text }));
      try {
        await addDoc(collection(db, 'helpRequests'), { text, callId, timestamp: new Date().toISOString(), status: 'pending' });
        addLog('Request saved to queue.');
      } catch (err) { addLog('Failed to save to queue: ' + err.message); }
    });
  }, []);

  // Arrival signal from overlay → show stamp panel
  useEffect(() => {
    if (!isElectron) return;
    window.electron.onArrival(() => {
      if (role === 'novice') setShowStampPanel(true);
    });
  }, [role]);

  // Voice transcription via MediaRecorder + Whisper (Web Speech API fails silently in Electron)
  useEffect(() => {
    if (!isElectron) return;
    let mediaRecorder = null;
    let audioChunks = [];

    window.electron.onStartRecording(async () => {
      if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          addLog(`Audio captured: ${blob.size} bytes`);
          if (blob.size < 100) {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'No audio captured — try again' }));
            mediaRecorder = null; audioChunks = []; return;
          }
          const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
          if (!apiKey) {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'no-api-key' })); return;
          }
          window.electron.sendTranscript(JSON.stringify({ type: 'interim', text: 'Transcribing...' }));
          try {
            const formData = new FormData();
            formData.append('file', blob, 'audio.webm');
            formData.append('model', 'whisper-1');
            const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: formData,
            });
            if (!res.ok) {
              const errJson = await res.json().catch(() => ({}));
              const userMsg = res.status === 429 ? 'API rate limit hit — type instead'
                : res.status === 401 ? 'Invalid API key — check .env'
                : `API error ${res.status}`;
              window.electron.sendTranscript(JSON.stringify({ type: 'error', text: userMsg })); return;
            }
            const { text } = await res.json();
            window.electron.sendTranscript(JSON.stringify({ type: 'final', text: text?.trim() || '' }));
          } catch (err) {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'transcription-failed — type instead' }));
          }
          mediaRecorder = null; audioChunks = [];
        };
        mediaRecorder.start(250);
        window.electron.sendTranscript(JSON.stringify({ type: 'interim', text: 'Recording...' }));
      } catch (err) {
        window.electron.sendTranscript(JSON.stringify({ type: 'error', text: err.message }));
      }
    });
  }, []);

  // ── Canvas helpers ──────────────────────────────────────────────────────────

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current) { lines.push(current); current = word; }
      else { current = test; }
    }
    if (current) lines.push(current);
    return lines;
  }

  // Draw cursor crosshair — clears canvas first, so note canvas is separate
  function drawCursor(canvas, x, y) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
    ctx.stroke();
  }

  // Draw all stored notes onto the dedicated notes canvas
  // Called once after a note is placed; the canvas is never cleared by cursor drawing
  function redrawExpertNotes() {
    const canvas = expertNotesCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const note of expertNotesRef.current) {
      const px      = note.normX * canvas.width;
      const py      = note.normY * canvas.height;
      const padding = 8;
      const maxW    = 180;
      ctx.font = '12px sans-serif';
      const lines = wrapText(ctx, note.text, maxW);
      const boxH  = lines.length * 16 + padding * 2;

      // Pin dot
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, 2 * Math.PI);
      ctx.fillStyle = '#e67e22';
      ctx.fill();

      // Note box
      ctx.fillStyle = 'rgba(255, 235, 150, 0.95)';
      ctx.beginPath();
      ctx.roundRect(px + 10, py - 10, maxW + padding * 2, boxH, 6);
      ctx.fill();

      ctx.fillStyle = '#333';
      lines.forEach((line, i) => ctx.fillText(line, px + 10 + padding, py - 10 + padding + 14 + i * 16));
    }
  }

  // ── WebRTC ──────────────────────────────────────────────────────────────────

  function initPC() {
    const pc = new RTCPeerConnection(servers);
    const dc = pc.createDataChannel('guidance');
    dc.onopen    = () => addLog('Data channel open');
    dc.onmessage = (e) => handleIncomingMessage(e.data);
    dataChannelRef.current = dc;
    pc.ondatachannel = (e) => {
      e.channel.onopen    = () => addLog('Remote data channel open');
      e.channel.onmessage = (ev) => handleIncomingMessage(ev.data);
      dataChannelRef.current = e.channel;
    };
    pc.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
      addLog('Remote stream connected');
    };
    pcRef.current = pc;
    return pc;
  }

  async function shareScreen() {
    const pc = initPC();
    setRole('novice');
    if (isElectron) {
      setSources(await window.electron.getSources());
      setStatus('picking');
      pendingPCRef.current = pc;
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      setStatus('sharing');
      addLog('Screen shared. Click "Create Call" to continue.');
    }
  }

  async function selectSource(source) {
    setSelectedTitle(source.name);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
    });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((t) => pendingPCRef.current.addTrack(t, stream));
    setStatus('sharing');
    setSources([]);
    addLog(`Screen shared: ${source.name}`);
  }

  async function createCall() {
    const pc          = pcRef.current;
    const callDoc     = doc(collection(db, 'calls'));
    const offerCands  = collection(callDoc, 'offerCandidates');
    const answerCands = collection(callDoc, 'answerCandidates');
    setCallId(callDoc.id);
    pc.onicecandidate = (e) => { if (e.candidate) addDoc(offerCands, e.candidate.toJSON()); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(callDoc, { offer: { type: offer.type, sdp: offer.sdp } });
    onSnapshot(callDoc, (snap) => {
      const data = snap.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        addLog('Expert connected!'); setStatus('connected');
      }
    });
    onSnapshot(answerCands, (snap) => {
      snap.docChanges().forEach((c) => { if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())); });
    });
    setStatus('calling');
    addLog(`Call created. Share this ID with the expert: ${callDoc.id}`);
  }

  async function joinCall() {
    const pc          = initPC();
    setRole('expert');
    const callDoc     = doc(db, 'calls', joinInput);
    const answerCands = collection(callDoc, 'answerCandidates');
    const offerCands  = collection(callDoc, 'offerCandidates');
    pc.onicecandidate = (e) => { if (e.candidate) addDoc(answerCands, e.candidate.toJSON()); };
    const callSnap = await getDoc(callDoc);
    if (!callSnap.exists()) { addLog('Error: Call ID not found.'); return; }
    const callData = callSnap.data();
    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await setDoc(callDoc, { answer: { type: answer.type, sdp: answer.sdp } }, { merge: true });
    onSnapshot(offerCands, (snap) => {
      snap.docChanges().forEach((c) => { if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())); });
    });
    setStatus('connected');
    addLog('Joined call. Waiting for novice screen...');
  }

  async function startPlayback() {
    const events = cursorRecordingRef.current;
    if (!events.length) return;
    setIsPlayingBack(true);
    let audio = null;
    if (sessionAudioRef.current) { audio = new Audio(sessionAudioRef.current); audio.play(); }
    const startTime = Date.now();
    for (const event of events) {
      const delay = event.timestamp - (Date.now() - startTime);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      const canvas = remoteCanvasRef.current;
      if (canvas) drawCursor(canvas, event.x * canvas.width, event.y * canvas.height);
    }
    audio?.pause();
    setIsPlayingBack(false);
  }

  async function sendStamp(verdict) {
    setStampResponse(verdict);
    setShowStampPanel(false);
    const dc = dataChannelRef.current;
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'novice-stamp', verdict }));
    if (callId) {
      try { await addDoc(collection(db, 'stamps'), { callId, verdict, timestamp: new Date().toISOString() }); }
      catch (err) { addLog('Failed to save stamp: ' + err.message); }
    }
  }

  // Expert mouse move — draw cursor and send to novice
  function handleExpertMouseMove(e) {
    const now = Date.now();
    if (now - lastSentRef.current < 16) return;
    lastSentRef.current = now;
    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const rect  = canvas.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top)  / rect.height;
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;

    drawCursor(canvas, normX * canvas.width, normY * canvas.height);

    const dc = dataChannelRef.current;
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'cursor', x: normX, y: normY, tag: cursorTag }));

    if (recordingStartRef.current === null) recordingStartRef.current = Date.now();
    cursorRecordingRef.current.push({ x: normX, y: normY, tag: cursorTag, timestamp: Date.now() - recordingStartRef.current });
  }

  // Expert drops a sticky note — draw on expert's notes canvas AND send to novice
  function handleDropNote(e) {
    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const rect  = canvas.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top)  / rect.height;

    const text = prompt('Note text:');
    if (!text?.trim()) return;

    // Store and draw on expert's notes canvas immediately
    expertNotesRef.current.push({ normX, normY, text: text.trim() });
    // Wait one tick for React to ensure expertNotesCanvasRef is current size
    setTimeout(redrawExpertNotes, 0);

    // Send to novice — triggers Marco Polo on their side
    const dc = dataChannelRef.current;
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'sticky-note', x: normX, y: normY, text: text.trim(), tag: cursorTag }));
    setNoteMode(false);
  }

  function handleIncomingMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'cursor') {
      // Ghost cursor deliberately removed from novice's screen — noop
      if (!isElectron) {
        const c = localCanvasRef.current;
        if (c) drawCursor(c, msg.x * c.width, msg.y * c.height);
      }
    } else if (msg.type === 'help-request') {
      addLog(`Novice needs help: "${msg.text}"`);
      setHelpRequest(msg.text);
    } else if (msg.type === 'sticky-note') {
      // Forward to overlay — this triggers Marco Polo on novice side
      if (isElectron) window.electron.sendCursor({ type: 'sticky-note', x: msg.x, y: msg.y, text: msg.text });
    } else if (msg.type === 'novice-stamp') {
      addLog(`Novice stamped session: "${msg.verdict}"`);
      setHelpRequest('');
    }
  }

  function endCall() {
    pcRef.current?.close(); pcRef.current = null;
    localVideoRef.current?.srcObject?.getTracks().forEach((t) => t.stop());
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (isElectron) window.electron.exitOverlayMode();
    if (sessionRecorderRef.current?.state === 'recording') sessionRecorderRef.current.stop();
    expertNotesRef.current = [];
    const nc = expertNotesCanvasRef.current;
    if (nc) nc.getContext('2d').clearRect(0, 0, nc.width, nc.height);
    setStatus('idle'); setRole('none'); setCallId(''); setSelectedTitle('');
    setExpertFullscreen(false);
    addLog('Call ended.');
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const canvasStyle    = { position: 'absolute', top: 0, left: 0, pointerEvents: 'none' };
  const videoBox       = { position: 'relative', width: 420, height: 300 };
  const videoStyle     = { width: 420, height: 300, background: '#111', display: 'block' };
  const expertBox      = { position: 'relative', width: expertW, height: expertH };
  const expertVidStyle = { width: expertW, height: expertH, background: '#111', display: 'block' };

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: expertFullscreen ? 'none' : 1100, margin: '0 auto', padding: 20 }}>
      <h1>Marco Polo</h1>

      <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap' }}>

        {/* Novice's own screen — hidden for expert once connected (they see it via WebRTC) */}
        {!isExpertConnected && (
          <div>
            <p style={{ margin: '0 0 6px' }}>Your Screen (Novice)</p>
            <div style={videoBox}>
              <video ref={localVideoRef} autoPlay muted playsInline style={videoStyle} />
              <canvas ref={localCanvasRef} width={420} height={300} style={canvasStyle} />
            </div>
          </div>
        )}

        {/* Remote view — always shown; expands when expert is connected */}
        <div style={{ flex: isExpertConnected ? 1 : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ margin: 0 }}>
              {isExpertConnected ? 'Novice Screen' : 'Novice Screen (Expert view)'}
            </p>
            {isExpertConnected && (
              <button
                onClick={() => setExpertFullscreen(f => !f)}
                style={{ background: '#444', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer' }}>
                {expertFullscreen ? '⊡ Exit Fullscreen' : '⛶ Fullscreen'}
              </button>
            )}
          </div>

          {/* Expert cursor-mode + note-drop controls */}
          {role === 'expert' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <strong style={{ marginRight: 4 }}>Cursor mode:</strong>
              <button
                disabled={status !== 'connected'}
                onClick={() => setCursorTag(t => t === 'world_space' ? 'ui_element' : 'world_space')}
                style={{ background: cursorTag === 'ui_element' ? '#646cff' : '#555', color: '#fff', padding: '4px 12px', border: 'none', borderRadius: 6, opacity: status !== 'connected' ? 0.4 : 1 }}>
                {cursorTag === 'world_space' ? '🌐 World Space' : '🖥 UI Element'}
              </button>
              <button
                disabled={status !== 'connected'}
                onClick={() => setNoteMode(n => !n)}
                style={{ background: noteMode ? '#e67e22' : '#555', color: '#fff', padding: '4px 12px', border: 'none', borderRadius: 6, opacity: status !== 'connected' ? 0.4 : 1 }}>
                {noteMode ? '📌 Click to place' : '📌 Drop Note'}
              </button>
            </div>
          )}

          <div
            style={{ ...(isExpertConnected ? expertBox : videoBox), cursor: noteMode ? 'crosshair' : 'default' }}
            onMouseMove={role === 'expert' ? handleExpertMouseMove : undefined}
            onClick={role === 'expert' && noteMode ? handleDropNote : undefined}>
            <video ref={remoteVideoRef} autoPlay playsInline style={isExpertConnected ? expertVidStyle : videoStyle} />
            {/* Cursor canvas — cleared on every mouse move */}
            <canvas
              ref={remoteCanvasRef}
              width={isExpertConnected ? expertW : 420}
              height={isExpertConnected ? expertH : 300}
              style={canvasStyle} />
            {/* Notes canvas — separate layer, never cleared by cursor drawing */}
            <canvas
              ref={expertNotesCanvasRef}
              width={isExpertConnected ? expertW : 420}
              height={isExpertConnected ? expertH : 300}
              style={{ ...canvasStyle, zIndex: 1 }} />
            {noteMode && (
              <div style={{ position: 'absolute', inset: 0, border: '2px dashed #e67e22', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ background: 'rgba(230,126,34,0.85)', color: '#fff', padding: '4px 10px', borderRadius: 6, fontSize: 13 }}>
                  📌 Click anywhere to place note
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Window picker (novice Electron) */}
      {sources.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 'bold' }}>Select a window to share:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {sources.map((s) => (
              <div key={s.id} onClick={() => selectSource(s)}
                style={{ cursor: 'pointer', padding: '8px 12px', background: '#333', color: '#fff', borderRadius: 6, fontSize: 13 }}>
                {s.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stuck detector indicator */}
      {camReady && role === 'novice' && (
        <div style={{ fontSize: 12, color: isStuck ? '#e74c3c' : '#2ecc71', marginBottom: 8 }}>
          Stuck detector: {isStuck ? 'STUCK' : 'working'} | Cam ready
        </div>
      )}

      {/* Stamp panel — shows after novice arrives at target */}
      {showStampPanel && role === 'novice' && (
        <div style={{ padding: 16, background: '#1e2a3a', borderRadius: 10, marginBottom: 16, borderLeft: '4px solid #646cff', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong style={{ color: '#fff' }}>Did that help?</strong>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => sendStamp('worked')}
              style={{ background: '#27ae60', color: '#fff', padding: '8px 18px', border: 'none', borderRadius: 8, fontSize: 15 }}>
              ✅ Worked
            </button>
            <button onClick={() => sendStamp('confused')}
              style={{ background: '#e74c3c', color: '#fff', padding: '8px 18px', border: 'none', borderRadius: 8, fontSize: 15 }}>
              😕 Still confused
            </button>
            <button onClick={() => { setShowStampPanel(false); if (isElectron) window.electron.sendStuck(true); }}
              style={{ background: '#555', color: '#fff', padding: '8px 18px', border: 'none', borderRadius: 8, fontSize: 15 }}>
              🎤 Re-record
            </button>
          </div>
        </div>
      )}

      {/* Control buttons */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={shareScreen} disabled={status !== 'idle'}>1. Share My Screen (Novice)</button>
        <button onClick={createCall}  disabled={status !== 'sharing'}>2. Create Call (Novice)</button>
        <input placeholder="Enter Call ID" value={joinInput} onChange={(e) => setJoinInput(e.target.value)} style={{ padding: '6px 10px' }} />
        <button onClick={joinCall} disabled={!joinInput || status !== 'idle'}>3. Join Call (Expert)</button>
        <button onClick={endCall} disabled={status === 'idle'} style={{ background: '#c0392b', color: '#fff' }}>End Call</button>
        {hasRecording && role === 'expert' && (
          <button onClick={startPlayback} disabled={isPlayingBack}
            style={{ background: '#27ae60', color: '#fff', padding: '6px 14px', border: 'none', borderRadius: 6 }}>
            {isPlayingBack ? '▶ Playing...' : '▶ Replay Session'}
          </button>
        )}
      </div>

      {callId && (
        <div style={{ padding: 12, background: '#646cffaa', borderRadius: 6, marginBottom: 16 }}>
          <strong>Call ID (share with expert):</strong> {callId}
        </div>
      )}

      {helpRequest && role === 'expert' && (
        <div style={{ padding: 14, background: '#2c3e50', borderRadius: 8, marginBottom: 16, borderLeft: '4px solid #646cff' }}>
          <strong style={{ color: '#646cff' }}>Novice needs help:</strong>
          <p style={{ color: '#fff', margin: '6px 0 10px' }}>"{helpRequest}"</p>
          <button onClick={() => setHelpRequest('')} style={{ fontSize: 12, padding: '4px 10px' }}>Dismiss</button>
        </div>
      )}

      <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, minHeight: 120, fontFamily: 'monospace', fontSize: 13 }}>
        {log.length === 0
          ? <span style={{ opacity: 0.4 }}>Logs will appear here...</span>
          : log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}