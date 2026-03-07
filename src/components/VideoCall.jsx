import { useRef, useState } from 'react';
import { db } from '../../firebase.config.js';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  addDoc,
} from 'firebase/firestore';

// ICE servers — help peers find each other across different networks
const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

export default function VideoCall() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // pc and dataChannel live in refs so they persist across renders
  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);

  const [callId, setCallId] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sharing | calling | joined
  const [log, setLog] = useState([]);

  const addLog = (msg) => setLog((prev) => [...prev, msg]);

  // Initialise a fresh RTCPeerConnection
  function initPC() {
    const pc = new RTCPeerConnection(servers);

    // Data channel for cursor coords, notes, Marco-Polo triggers
    const dc = pc.createDataChannel('guidance');
    dc.onopen = () => addLog('Data channel open');
    dc.onmessage = (e) => addLog(`Received: ${e.data}`);
    dataChannelRef.current = dc;

    // Also handle the case where the remote peer creates the data channel
    pc.ondatachannel = (e) => {
      const remote = e.channel;
      remote.onopen = () => addLog('Remote data channel open');
      remote.onmessage = (ev) => addLog(`Expert received: ${ev.data}`);
      dataChannelRef.current = remote;
    };

    // When the remote stream arrives, show it
    pc.ontrack = (e) => {
      remoteVideoRef.current.srcObject = e.streams[0];
      addLog('Remote stream connected');
    };

    pcRef.current = pc;
    return pc;
  }

  // Novice shares Blender screen 
  async function shareScreen() {
    const pc = initPC();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    setStatus('sharing');
    addLog('Screen shared. Click "Create Call" to continue.');
  }

  // Novice creates the call and waits for expert to join using the call ID.
  async function createCall() {
    const pc = pcRef.current;
    const callDoc = doc(collection(db, 'calls'));
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    setCallId(callDoc.id);

    // Store ICE candidates as they're gathered
    pc.onicecandidate = (e) => {
      if (e.candidate) addDoc(offerCandidates, e.candidate.toJSON());
    };

    // Create and store the offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(callDoc, { offer: { type: offer.type, sdp: offer.sdp } });

    // Listen for the expert's answer
    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        addLog('Expert connected!');
      }
    });

    // Listen for the expert's ICE candidates
    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        }
      });
    });

    setStatus('calling');
    addLog(`Call created. Share this ID with the expert: ${callDoc.id}`);
  }

  // Expert joins the call using the call ID, and sets up their connection based on the novice's offer
  async function joinCall() {
    const pc = initPC();
    const callDoc = doc(db, 'calls', joinInput);
    const answerCandidates = collection(callDoc, 'answerCandidates');
    const offerCandidates = collection(callDoc, 'offerCandidates');

    // Store expert's ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) addDoc(answerCandidates, e.candidate.toJSON());
    };

    // Get the novice's offer and answer it
    const callData = (await getDoc(callDoc)).data();
    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await setDoc(callDoc, { answer: { type: answer.type, sdp: answer.sdp } }, { merge: true });

    // Listen for novice's ICE candidates
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        }
      });
    });

    setStatus('joined');
    addLog('Joined call. Waiting for novice screen...');
  }

  // This is just used to test the data channel, will be deleted in future phases lol
  function sendTestMessage() {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      const msg = JSON.stringify({ type: 'cursor', x: 320, y: 240 });
      dc.send(msg);
      addLog(`Sent: ${msg}`);
    } else {
      addLog('Data channel not open yet');
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h1>Marco Polo</h1>

      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        <div>
          <p style={{ margin: '0 0 6px' }}>Your Screen (Novice)</p>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{ width: 420, height: 300, background: '#111', display: 'block' }}
          />
        </div>
        <div>
          <p style={{ margin: '0 0 6px' }}>Novice Screen (Expert view)</p>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: 420, height: 300, background: '#111', display: 'block' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={shareScreen} disabled={status !== 'idle'}>
          1. Share My Screen (Novice)
        </button>
        <button onClick={createCall} disabled={status !== 'sharing'}>
          2. Create Call (Novice)
        </button>
        <input
          placeholder="Enter Call ID"
          value={joinInput}
          onChange={(e) => setJoinInput(e.target.value)}
          style={{ padding: '6px 10px' }}
        />
        <button onClick={joinCall} disabled={!joinInput}>
          3. Join Call (Expert)
        </button>
        <button onClick={sendTestMessage}>
          Send Test Cursor Message
        </button>
      </div>

      {callId && (
        <div style={{ padding: 12, background: '#646cffaa', borderRadius: 6, marginBottom: 16 }}>
          <strong>Call ID (share with expert):</strong> {callId}
        </div>
      )}

      <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, minHeight: 120, fontFamily: 'monospace', fontSize: 13 }}>
        {log.length === 0 ? <span style={{ opacity: 0.4 }}>Logs will appear here...</span> : log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
