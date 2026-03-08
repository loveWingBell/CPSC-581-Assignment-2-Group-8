import { useEffect, useRef, useState } from 'react';
import * as tmImage from '@teachablemachine/image';

const MODEL_URL       = 'https://teachablemachine.withgoogle.com/models/OV3S1uVht/';
const STUCK_CONFIDENCE = 0.75;

export function useStuckDetector(enabled) {
  const [isStuck,  setIsStuck]  = useState(false);
  const [camReady, setCamReady] = useState(false);

  const modelRef  = useRef(null);
  const webcamRef = useRef(null);
  const rafRef    = useRef(null);

  // ML loop + webcam
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // rn only the face tracking works, but we can add idle and undo signals back in later (praying)
    async function loop() {
      if (cancelled || !webcamRef.current || !modelRef.current) return;
      webcamRef.current.update();
      const predictions = await modelRef.current.predict(webcamRef.current.canvas);
      const stuckClass  = predictions.find(p => p.className === 'stuck');
      setIsStuck((stuckClass?.probability ?? 0) >= STUCK_CONFIDENCE);
      rafRef.current = requestAnimationFrame(loop);
    }

    async function init() {
      modelRef.current = await tmImage.load(MODEL_URL + 'model.json', MODEL_URL + 'metadata.json');
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

  return { isStuck, camReady };
}