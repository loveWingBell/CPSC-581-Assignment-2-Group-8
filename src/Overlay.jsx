import { useEffect, useRef } from 'react';

export default function Overlay() {
  const canvasRef = useRef(null);

  useEffect(() => {
    // Listen for cursor coordinates sent from the main window via Electron IPC
    window.electron.onCursor(({ x, y }) => {
      drawGhostCursor(x, y);
    });
  }, []);

  function drawGhostCursor(x, y) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Circle
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Crosshair
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.9)';
    ctx.stroke();
  }

  return (
    <canvas
      ref={canvasRef}
      width={window.screen.width}
      height={window.screen.height}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        background: 'transparent',
      }}
    />
  );
}