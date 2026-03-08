import { useEffect, useRef, useState } from 'react';
import * as tmImage from '@teachablemachine/image';

const MODEL_URL        = 'https://teachablemachine.withgoogle.com/models/OV3S1uVht/';
const IDLE_THRESHOLD_MS = 5000;
const UNDO_THRESHOLD    = 10;
const UNDO_WINDOW_MS    = 10000;
const STUCK_CONFIDENCE  = 0.75;

export function useStuckDetector(enabled) {
  const [isStuck,  setIsStuck]  = useState(false);
  const [camReady, setCamReady] = useState(false);

  const modelRef     = useRef(null);
  const webcamRef    = useRef(null);
  const lastMoveRef  = useRef(Date.now());
  const undoTimesRef = useRef([]);
  const stuckSignals = useRef({ ml: false, idle: false, undo: false });
  const rafRef       = useRef(null);

  // ML loop + webcam
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    // rn only the face tracking works, but we can add idle and undo signals back in later (praying)
    function checkAllSignals() {
      const { ml } = stuckSignals.current;
      setIsStuck(ml);
      // Restore full check once testing is done:
      //const { ml, idle, undo } = stuckSignals.current;
      //setIsStuck(ml && idle && undo);
    }

    // loop lives inside the effect so only one instance ever runs
    async function loop() {
      if (cancelled || !webcamRef.current || !modelRef.current) return;
      webcamRef.current.update();
      const predictions = await modelRef.current.predict(webcamRef.current.canvas);
      const stuckClass  = predictions.find(p => p.className === 'stuck');
      console.log('stuck probability:', stuckClass?.probability.toFixed(2));
      stuckSignals.current.ml = (stuckClass?.probability ?? 0) >= STUCK_CONFIDENCE;
      checkAllSignals();
      rafRef.current = requestAnimationFrame(loop);
    }

    async function init() {
      const modelURL   = MODEL_URL + 'model.json';
      const metaURL    = MODEL_URL + 'metadata.json';
      modelRef.current = await tmImage.load(modelURL, metaURL);

      const webcam = new tmImage.Webcam(200, 200, true);
      await webcam.setup();
      await webcam.play();
      webcamRef.current = webcam;
      setCamReady(true);

      loop();
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      webcamRef.current?.stop();
      webcamRef.current = null;
      modelRef.current  = null;
      setCamReady(false);
      setIsStuck(false);
    };
  }, [enabled]);

  // Idle tracking
  useEffect(() => {
    if (!enabled || !window.electron) return;

    const IDLE_THRESHOLD_MS = 5000;

    window.electron.onMouseMoved(() => {
      stuckSignals.current.idle = false;
    });

    window.electron.onIdle((ms) => {
      stuckSignals.current.idle = ms > IDLE_THRESHOLD_MS;
    });
  }, [enabled]);

  // Undo tracking
  useEffect(() => {
    if (!enabled || !window.electron) return;

    const UNDO_THRESHOLD = 10;

    window.electron.onUndo((count) => {
      stuckSignals.current.undo = count >= UNDO_THRESHOLD;
    });
  }, [enabled]);

  return { isStuck, camReady };
}