import { useRef, useState, useEffect, useCallback } from 'react';
import { db } from '../../firebase.config.js';
import { collection, doc, setDoc, getDoc, onSnapshot, addDoc } from 'firebase/firestore';
import { useStuckDetector } from '../hooks/useStuckDetector.js';

const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };
const isElectron = !!window.electron;

export default function VideoCall() {
  const localVideoRef        = useRef(null);
  const remoteVideoRef       = useRef(null);
  const localCanvasRef       = useRef(null);
  const remoteCanvasRef      = useRef(null);
  const expertNotesCanvasRef = useRef(null);
  const pcRef                = useRef(null);
  const dataChannelRef       = useRef(null);
  const lastSentRef          = useRef(0);
  const pendingPCRef         = useRef(null);
  const expertNotesRef       = useRef([]);
  const cursorRecordingRef   = useRef([]);
  const recordingStartRef    = useRef(null);
  const sessionRecorderRef   = useRef(null);
  const sessionAudioRef      = useRef(null);
  const marcoRecognitionRef  = useRef(null);

  const [callId,           setCallId]           = useState('');
  const [joinInput,        setJoinInput]        = useState('');
  const [status,           setStatus]           = useState('idle');
  const [role,             setRole]             = useState('none');
  const [log,              setLog]              = useState([]);
  const [sources,          setSources]          = useState([]);
  const [selectedTitle,    setSelectedTitle]    = useState('');
  const [helpRequest,      setHelpRequest]      = useState('');
  const [cursorTag,        setCursorTag]        = useState('world_space');
  const cursorTagRef = useRef('world_space');
  useEffect(() => { cursorTagRef.current = cursorTag; }, [cursorTag]);
  const [noteMode,         setNoteMode]         = useState(false);
  const [isPlayingBack,    setIsPlayingBack]    = useState(false);
  const [hasRecording,     setHasRecording]     = useState(false);
  const [expertFullscreen, setExpertFullscreen] = useState(false);
  const [dismissedNotes,   setDismissedNotes]   = useState([]);
  const [showNoteHistory,  setShowNoteHistory]  = useState(false);

  // Note composer state (expert side) -----------------------------------
  // Shown inline above the video when noteMode is active
  const [noteText,         setNoteText]         = useState('');
  const [noteRecording,    setNoteRecording]    = useState(false); // mic is active
  const [noteAudioBlob,    setNoteAudioBlob]    = useState(null);  // recorded blob
  const [pendingNotePos,   setPendingNotePos]   = useState(null);  // { normX, normY }
  const noteRecorderRef    = useRef(null);
  const noteChunksRef      = useRef([]);

  const addLog = (msg) => setLog((prev) => [...prev, msg]);

  const { isStuck, camReady } = useStuckDetector(role === 'novice');

  const isExpertConnected = role === 'expert' && status === 'connected';
  const expertW = expertFullscreen ? (window.innerWidth  - 40) : isExpertConnected ? 820 : 420;
  const expertH = expertFullscreen ? (window.innerHeight - 200) : isExpertConnected ? 560 : 300;

  // Novice: start overlay when connected 
  useEffect(() => {
    if (status === 'connected' && role === 'novice' && isElectron)
      window.electron.enterOverlayMode(selectedTitle);
  }, [status, role]);

  // Novice: Marco Polo — Whisper 2-second segment detection
  /* Flow:
      1. Open mic once; VAD (AnalyserNode RMS) guards every Whisper call.
      2. Every 2 s: stop recorder -> ondataavailable fires with the full segment
        -> if RMS > threshold, POST to Whisper -> check for "marco".
      3. Immediately restart recorder for the next window.
      4. 1.5 s cooldown after a hit to avoid duplicate triggers.
  **/
  useEffect(() => {
    if (role !== 'novice' || status !== 'connected' || !isElectron) return;

    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) { addLog('No OpenAI key — Marco voice detection off'); return; }

    let cancelled     = false;
    let marcoCooldown = false;
    let stream        = null;
    let recorder      = null;
    let audioCtx      = null;
    let analyser      = null;
    let segmentTimer  = null;

    async function start() {
      try {
        stream  = await navigator.mediaDevices.getUserMedia({ audio: true });

        // VAD: AnalyserNode RMS 
        audioCtx        = new AudioContext();
        const src       = audioCtx.createMediaStreamSource(stream);
        analyser        = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const freqData  = new Uint8Array(analyser.frequencyBinCount);

        function getRMS() {
          analyser.getByteFrequencyData(freqData);
          return Math.sqrt(freqData.reduce((s, v) => s + v * v, 0) / freqData.length);
        }

        // Segment recorder -----------------------------------------------
        // ondataavailable fires once when stop() is called, giving us a complete, self-contained blob with WebM headers intact.
        function startSegment() {
          if (cancelled) return;
          recorder = new MediaRecorder(stream);

          // Poll for voice throughout the 2-second window
          let hadVoice = false;
          const vadPoll = setInterval(() => {
            if (getRMS() > 12) hadVoice = true;
          }, 80);

          recorder.ondataavailable = async (e) => {
            clearInterval(vadPoll);
            if (cancelled || !e.data || e.data.size < 500) return;
            if (marcoCooldown || !hadVoice) return;

            try {
              const form = new FormData();
              form.append('file', e.data, 'marco.webm');
              form.append('model', 'whisper-1');
              form.append('prompt', 'Marco'); // nudge tokeniser toward the word
              const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
              });
              if (res.ok) {
                const { text } = await res.json();
                if (text?.toLowerCase().includes('marco') && !marcoCooldown) {
                  marcoCooldown = true;
                  setTimeout(() => { marcoCooldown = false; }, 1500);
                  addLog('Marco! 🎯');
                  window.electron.sendMarco();
                }
              }
            } catch (_) { /* network blip — skip segment, next one will retry */ }
          };

          recorder.onstop = () => {
            // Restart immediately for the next 2s window
            if (!cancelled) startSegment();
          };

          recorder.start();
          // Stop after 2s, triggers ondataavailable with the full segment
          segmentTimer = setTimeout(() => {
            if (recorder?.state === 'recording') recorder.stop();
          }, 2000);
        }

        addLog('🎤 Mic on — say "Marco" near a note');
        startSegment();

      } catch (e) {
        addLog('Marco mic error: ' + e.message);
      }
    }

    // Small delay so enterOverlayMode IPC has been processed before SR claims mic
    const t = setTimeout(start, 200);

    // Expose a stop handle for endCall()
    marcoRecognitionRef.current = {
      stop: () => {
        cancelled = true;
        clearTimeout(segmentTimer);
        if (recorder?.state === 'recording') try { recorder.stop(); } catch (_) {}
        stream?.getTracks().forEach(tr => tr.stop());
        audioCtx?.close();
      },
    };

    return () => {
      marcoRecognitionRef.current?.stop();
      marcoRecognitionRef.current = null;
      clearTimeout(t);
    };
  }, [role, status]);

  // Expert: record session audio for playback -----------------------------------
  useEffect(() => {
    if (status !== 'connected' || role !== 'expert') return;
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
    }).catch(err => addLog('Session mic error: ' + err.message));
  }, [status, role]);

  // Novice: forward stuck state -----------------------------------
  useEffect(() => {
    if (!isElectron) return;
    const t = setTimeout(() => {
      if (role === 'novice' && status === 'connected') window.electron.sendStuck(isStuck);
    }, 500);
    return () => clearTimeout(t);
  }, [isStuck, status, role]);

  // Novice: help request from overlay -> data channel -----------------------------------
  useEffect(() => {
    if (!isElectron) return;
    window.electron.onHelpRequest(async (text) => {
      if (!text || text === 'Transcribing...' || text === 'Recording...') return;
      addLog(`Help request sent: "${text}"`);
      const dc = dataChannelRef.current;
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'help-request', text }));
      try {
        await addDoc(collection(db, 'helpRequests'), { text, callId, timestamp: new Date().toISOString(), status: 'pending' });
      } catch (err) { addLog('Queue error: ' + err.message); }
    });
  }, []);

  // Novice: stamp from overlay -> data channel 
  useEffect(() => {
    if (!isElectron) return;
    window.electron.onStamp(async (verdict) => {
      addLog(`Stamp: ${verdict}`);
      const dc = dataChannelRef.current;
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'novice-stamp', verdict }));
      if (callId) {
        try { await addDoc(collection(db, 'stamps'), { callId, verdict, timestamp: new Date().toISOString() }); }
        catch (_) {}
      }
    });
  }, []);

  // Novice: dismissed note -> remove from expert canvas + log
  useEffect(() => {
    if (!isElectron) return;
    window.electron.onDismissNote((idx) => {
      const note = expertNotesRef.current[idx];
      if (!note) return;
      addLog(`Note dismissed by novice: "${note.text}"`);
      setDismissedNotes(prev => [...prev, { ...note, dismissedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
      // Send dismiss over data channel so a web-only expert also updates
      const dc = dataChannelRef.current;
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'dismiss-note', idx }));
      // Remove from expert canvas
      expertNotesRef.current.splice(idx, 1);
      setTimeout(redrawExpertNotes, 0);
    });
  }, []);

  // Voice transcription (Whisper)
  useEffect(() => {
    if (!isElectron) return;
    let mediaRecorder = null, audioChunks = [];
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
          if (blob.size < 100) {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'No audio captured — try again' }));
            mediaRecorder = null; audioChunks = []; return;
          }
          const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
          if (!apiKey) {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'No API key configured' })); return;
          }
          window.electron.sendTranscript(JSON.stringify({ type: 'interim', text: 'Transcribing...' }));
          try {
            const form = new FormData();
            form.append('file', blob, 'audio.webm');
            form.append('model', 'whisper-1');
            const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
            });
            if (!res.ok) {
              const msg = res.status === 429 ? 'Rate limit — type instead'
                : res.status === 401 ? 'Invalid API key' : `API error ${res.status}`;
              window.electron.sendTranscript(JSON.stringify({ type: 'error', text: msg })); return;
            }
            const { text } = await res.json();
            window.electron.sendTranscript(JSON.stringify({ type: 'final', text: text?.trim() || '' }));
          } catch {
            window.electron.sendTranscript(JSON.stringify({ type: 'error', text: 'Transcription failed — type instead' }));
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

  // Canvas helpers
  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' '), lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawCursor(canvas, x, y) {
    if (!canvas) return;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.strokeStyle = 'rgba(255,80,80,0.95)'; c.lineWidth = 2.5;
    c.beginPath(); c.arc(x, y, 14, 0, 2 * Math.PI); c.stroke();
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x - 9, y); c.lineTo(x + 9, y);
    c.moveTo(x, y - 9); c.lineTo(x, y + 9);
    c.stroke();
  }

  function redrawExpertNotes() {
    const canvas = expertNotesCanvasRef.current;
    if (!canvas) return;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    for (const note of expertNotesRef.current) {
      const px = note.normX * canvas.width;
      const py = note.normY * canvas.height;
      const padding = 8, maxW = 180;
      c.font = '12px sans-serif';
      const lines = wrapText(c, note.text, maxW);
      const boxH  = lines.length * 16 + padding * 2 + 20;
      c.beginPath(); c.arc(px, py, 6, 0, 2 * Math.PI);
      c.fillStyle = '#e67e22'; c.fill();
      c.fillStyle = 'rgba(255,235,150,0.97)';
      c.beginPath(); c.roundRect(px + 10, py - 10, maxW + padding * 2, boxH, 8); c.fill();
      c.fillStyle = '#333';
      lines.forEach((l, i) => c.fillText(l, px + 10 + padding, py - 10 + padding + 14 + i * 16));
      // Audio indicator
      if (note.hasAudio) {
        c.fillStyle = 'rgba(100,108,255,0.8)'; c.font = '10px sans-serif';
        c.fillText('🔊 + ▶ tap to play', px + 10 + padding, py - 10 + boxH - 6);
      } else {
        c.fillStyle = 'rgba(100,108,255,0.8)'; c.font = '10px sans-serif';
        c.fillText('▶ tap to play', px + 10 + padding, py - 10 + boxH - 6);
      }
    }
  }

  // WebRTC 
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
    const pc = initPC(); setRole('novice');
    if (isElectron) {
      setSources(await window.electron.getSources());
      setStatus('picking'); pendingPCRef.current = pc;
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      setStatus('sharing'); addLog('Screen shared. Click "Create Call" to continue.');
    }
  }

  async function selectSource(source) {
    setSelectedTitle(source.name);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
    });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach(t => pendingPCRef.current.addTrack(t, stream));
    setStatus('sharing'); setSources([]); addLog(`Screen shared: ${source.name}`);
  }

  async function createCall() {
    const pc = pcRef.current;
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
      snap.docChanges().forEach(c => { if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())); });
    });
    setStatus('calling'); addLog(`Call ID: ${callDoc.id}`);
  }

  async function joinCall() {
    const pc = initPC(); setRole('expert');
    const callDoc     = doc(db, 'calls', joinInput);
    const answerCands = collection(callDoc, 'answerCandidates');
    const offerCands  = collection(callDoc, 'offerCandidates');
    pc.onicecandidate = (e) => { if (e.candidate) addDoc(answerCands, e.candidate.toJSON()); };
    const snap = await getDoc(callDoc);
    if (!snap.exists()) { addLog('Call ID not found.'); return; }
    await pc.setRemoteDescription(new RTCSessionDescription(snap.data().offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await setDoc(callDoc, { answer: { type: answer.type, sdp: answer.sdp } }, { merge: true });
    onSnapshot(offerCands, (snap) => {
      snap.docChanges().forEach(c => { if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())); });
    });
    setStatus('connected'); addLog('Joined. Waiting for novice screen...');
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
    audio?.pause(); setIsPlayingBack(false);
  }

  // useCallback + cursorTagRef: this function is attached as a DOM event handler.
  // Without useCallback, every addLog() re-render recreates the function and React
  // re-attaches it mid-drag, causing the ghost cursor to stutter.
  const handleExpertMouseMove = useCallback((e) => {
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
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'cursor', x: normX, y: normY, tag: cursorTagRef.current }));
    if (recordingStartRef.current === null) recordingStartRef.current = Date.now();
    cursorRecordingRef.current.push({ x: normX, y: normY, tag: cursorTagRef.current, timestamp: Date.now() - recordingStartRef.current });
  }, []);

  // Click on video while in noteMode. store position, open composer
  const handleDropNote = useCallback((e) => {
    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const rect  = canvas.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top)  / rect.height;
    setPendingNotePos({ normX, normY });
    setNoteText(''); setNoteAudioBlob(null); setNoteRecording(false);
    // noteMode stays true. composer is shown in the UI panel below video
  }, []);

  // Start/stop note mic recording
  async function toggleNoteRecording() {
    if (noteRecording) {
      // Stop
      if (noteRecorderRef.current?.state === 'recording') noteRecorderRef.current.stop();
      setNoteRecording(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        noteChunksRef.current = [];
        const rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data.size > 0) noteChunksRef.current.push(e.data); };
        rec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(noteChunksRef.current, { type: 'audio/webm' });
          if (blob.size > 100) setNoteAudioBlob(blob);
        };
        rec.start(250);
        noteRecorderRef.current = rec;
        setNoteRecording(true);
      } catch (err) { addLog('Note mic error: ' + err.message); }
    }
  }

  // Confirm and send the note
  async function confirmNote() {
    if (!pendingNotePos) return;
    const { normX, normY } = pendingNotePos;
    const text = noteText.trim();
    if (!text && !noteAudioBlob) return;
    const displayText = text || '🔊 Audio note';

    // Convert audio blob to base64 if present
    let audioSrc = null;
    if (noteAudioBlob) {
      audioSrc = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result); // data URL
        reader.readAsDataURL(noteAudioBlob);
      });
    }

    // Draw on expert's canvas
    expertNotesRef.current.push({ normX, normY, text: displayText, hasAudio: !!audioSrc });
    setTimeout(redrawExpertNotes, 0);

    // Send to novice via data channel
    // Audio data URL can be large — chunk if needed; for typical short notes it's fine
    const dc = dataChannelRef.current;
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'sticky-note', x: normX, y: normY, text: displayText, audioSrc, tag: cursorTag }));
    }

    addLog(`Note placed: "${displayText}"${audioSrc ? ' (with audio)' : ''}`);
    setNoteMode(false); setPendingNotePos(null);
    setNoteText(''); setNoteAudioBlob(null); setNoteRecording(false);
  }

  function cancelNote() {
    if (noteRecording && noteRecorderRef.current?.state === 'recording') noteRecorderRef.current.stop();
    setNoteMode(false); setPendingNotePos(null);
    setNoteText(''); setNoteAudioBlob(null); setNoteRecording(false);
  }

  function handleIncomingMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'cursor') {
      if (!isElectron) {
        const c = localCanvasRef.current;
        if (c) drawCursor(c, msg.x * c.width, msg.y * c.height);
      }
    } else if (msg.type === 'help-request') {
      addLog(`Novice: "${msg.text}"`); setHelpRequest(msg.text);
    } else if (msg.type === 'sticky-note') {
      if (isElectron) window.electron.sendCursor({
        type: 'sticky-note', x: msg.x, y: msg.y, text: msg.text, audioSrc: msg.audioSrc || null,
      });
    } else if (msg.type === 'novice-stamp') {
      addLog(`Novice stamped: "${msg.verdict}"`); setHelpRequest('');
    } else if (msg.type === 'dismiss-note') {
      const note = expertNotesRef.current[msg.idx];
      if (note) {
        addLog(`Note dismissed: "${note.text}"`);
        setDismissedNotes(prev => [...prev, { ...note, dismissedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
        expertNotesRef.current.splice(msg.idx, 1);
        setTimeout(redrawExpertNotes, 0);
      }
    }
  }

  function endCall() {
    // Stop Marco detection (Whisper rolling-buffer)
    if (marcoRecognitionRef.current) {
      marcoRecognitionRef.current.stop();
      marcoRecognitionRef.current = null;
    }
    pcRef.current?.close(); pcRef.current = null;
    localVideoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (isElectron) window.electron.exitOverlayMode();
    if (sessionRecorderRef.current?.state === 'recording') sessionRecorderRef.current.stop();
    expertNotesRef.current = [];
    const nc = expertNotesCanvasRef.current;
    if (nc) nc.getContext('2d').clearRect(0, 0, nc.width, nc.height);
    setStatus('idle'); setRole('none'); setCallId(''); setSelectedTitle('');
    setExpertFullscreen(false); setNoteMode(false); setPendingNotePos(null);
    setDismissedNotes([]); setShowNoteHistory(false);
    addLog('Call ended.');
  }

  // Styles ----------------------------------------------
  const canvasStyle    = { position: 'absolute', top: 0, left: 0, pointerEvents: 'none' };
  const videoBox       = { position: 'relative', width: 420, height: 300 };
  const videoStyle     = { width: 420, height: 300, background: '#111', display: 'block' };
  const expertBox      = { position: 'relative', width: expertW, height: expertH };
  const expertVidStyle = { width: expertW, height: expertH, background: '#111', display: 'block' };

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: expertFullscreen ? 'none' : 1100, margin: '0 auto', padding: 20 }}>
      <h1>Marco Polo</h1>

      <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap' }}>

        {!isExpertConnected && (
          <div>
            <p style={{ margin: '0 0 6px' }}>Your Screen (Novice)</p>
            <div style={videoBox}>
              <video ref={localVideoRef} autoPlay muted playsInline style={videoStyle} />
              <canvas ref={localCanvasRef} width={420} height={300} style={canvasStyle} />
            </div>
          </div>
        )}

        <div style={{ flex: isExpertConnected ? 1 : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ margin: 0 }}>{isExpertConnected ? 'Novice Screen' : 'Novice Screen (Expert view)'}</p>
            {isExpertConnected && (
              <button onClick={() => setExpertFullscreen(f => !f)}
                style={{ background: '#444', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer' }}>
                {expertFullscreen ? '⊡ Exit Fullscreen' : '⛶ Fullscreen'}
              </button>
            )}
          </div>

          {/* Expert controls */}
          {role === 'expert' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <strong>Cursor mode:</strong>
              <button disabled={status !== 'connected'} onClick={() => setCursorTag(t => t === 'world_space' ? 'ui_element' : 'world_space')}
                style={{ background: cursorTag === 'ui_element' ? '#646cff' : '#555', color: '#fff', padding: '4px 12px', border: 'none', borderRadius: 6, opacity: status !== 'connected' ? 0.4 : 1 }}>
                {cursorTag === 'world_space' ? '🌐 World Space' : '🖥 UI Element'}
              </button>
              <button disabled={status !== 'connected'} onClick={() => { setNoteMode(n => !n); setPendingNotePos(null); }}
                style={{ background: noteMode ? '#e67e22' : '#555', color: '#fff', padding: '4px 12px', border: 'none', borderRadius: 6, opacity: status !== 'connected' ? 0.4 : 1 }}>
                {noteMode ? '📌 Click video to place' : '📌 Drop Note'}
              </button>
            </div>
          )}

          {/* Note composer — shown after clicking video in noteMode */}
          {noteMode && pendingNotePos && (
            <div style={{ background: '#1e2030', border: '1px solid #e67e22', borderRadius: 10, padding: 16, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ color: '#e67e22', fontWeight: 'bold', margin: 0 }}>📌 Note at ({(pendingNotePos.normX * 100).toFixed(0)}%, {(pendingNotePos.normY * 100).toFixed(0)}%)</p>
              <textarea
                placeholder="Type note text (optional if recording voice)..."
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.07)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: 10, fontSize: 13, minHeight: 60, resize: 'none', fontFamily: 'sans-serif' }}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={toggleNoteRecording}
                  style={{ background: noteRecording ? '#c0392b' : '#646cff', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 'bold' }}>
                  {noteRecording ? '⏹ Stop Recording' : '🎙 Record Voice Note'}
                </button>
                {noteAudioBlob && <span style={{ color: '#2ecc71', fontSize: 13 }}>✅ Audio recorded</span>}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={confirmNote} disabled={!noteText.trim() && !noteAudioBlob}
                  style={{ background: '#27ae60', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 'bold', opacity: (!noteText.trim() && !noteAudioBlob) ? 0.4 : 1 }}>
                  ✓ Place Note
                </button>
                <button onClick={cancelNote}
                  style={{ background: '#555', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div style={{ ...(isExpertConnected ? expertBox : videoBox), cursor: noteMode && !pendingNotePos ? 'crosshair' : 'default' }}
            onMouseMove={role === 'expert' ? handleExpertMouseMove : undefined}
            onClick={role === 'expert' && noteMode && !pendingNotePos ? handleDropNote : undefined}>
            <video ref={remoteVideoRef} autoPlay playsInline style={isExpertConnected ? expertVidStyle : videoStyle} />
            <canvas ref={remoteCanvasRef}
              width={isExpertConnected ? expertW : 420}
              height={isExpertConnected ? expertH : 300}
              style={canvasStyle} />
            <canvas ref={expertNotesCanvasRef}
              width={isExpertConnected ? expertW : 420}
              height={isExpertConnected ? expertH : 300}
              style={{ ...canvasStyle, zIndex: 1 }} />
            {noteMode && !pendingNotePos && (
              <div style={{ position: 'absolute', inset: 0, border: '2px dashed #e67e22', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ background: 'rgba(230,126,34,0.85)', color: '#fff', padding: '4px 10px', borderRadius: 6, fontSize: 13 }}>
                  📌 Click to mark note position
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Window picker */}
      {sources.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 'bold' }}>Select a window to share:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {sources.map(s => (
              <div key={s.id} onClick={() => selectSource(s)}
                style={{ cursor: 'pointer', padding: '8px 12px', background: '#333', color: '#fff', borderRadius: 6, fontSize: 13 }}>
                {s.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stuck detector */}
      {camReady && role === 'novice' && (
        <div style={{ fontSize: 12, color: isStuck ? '#e74c3c' : '#2ecc71', marginBottom: 8 }}>
          Stuck detector: {isStuck ? '🔴 STUCK' : '🟢 working'} | Cam ready
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={shareScreen} disabled={status !== 'idle'}>1. Share My Screen (Novice)</button>
        <button onClick={createCall}  disabled={status !== 'sharing'}>2. Create Call (Novice)</button>
        <input placeholder="Enter Call ID" value={joinInput} onChange={e => setJoinInput(e.target.value)} style={{ padding: '6px 10px' }} />
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
          <strong>Call ID:</strong> {callId}
        </div>
      )}

      {/* Expert: dismissed notes history */}
      {role === 'expert' && dismissedNotes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowNoteHistory(h => !h)}
            style={{ background: '#2c3e50', color: '#aaa', border: '1px solid #444', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', marginBottom: 8 }}>
            📋 Dismissed Notes ({dismissedNotes.length}) {showNoteHistory ? '▲' : '▼'}
          </button>
          {showNoteHistory && (
            <div style={{ background: '#1a1f2e', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...dismissedNotes].reverse().map((n, i) => (
                <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ color: '#ccc', fontSize: 12 }}>{n.text}</div>
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, marginTop: 3 }}>
                    Dismissed {n.dismissedAt}{n.hasAudio ? ' · 🔊 had audio' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
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