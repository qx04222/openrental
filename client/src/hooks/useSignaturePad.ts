import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

interface Options {
  strokeStyle?: string;
  lineWidth?: number;
}

/**
 * Touch/mouse signature pad for a fixed-height canvas.
 *
 * Sizes the canvas's internal pixel buffer to match its CSS dimensions
 * times devicePixelRatio so strokes render sharply on retina screens AND
 * touch coordinates align with the canvas without per-event scaling.
 * A ResizeObserver re-syncs on layout changes (orientation, dialog open).
 *
 * Consumer pattern: spread `handlers` onto the <canvas>, do NOT set
 * width/height attrs on the element — the hook owns those.
 */
export function useSignaturePad({ strokeStyle = "#0f172a", lineWidth = 2 }: Options = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const [signature, setSignature] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }
      // Resizing the canvas wipes its content; a stale dataURL would point
      // at a now-empty buffer, so reset.
      setSignature("");
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [strokeStyle, lineWidth]);

  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    isDrawing.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, []);

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;
    ctx.lineTo(x, y);
    ctx.stroke();
  }, []);

  const endDraw = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    const canvas = canvasRef.current;
    if (canvas) setSignature(canvas.toDataURL());
  }, []);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // clearRect operates in transformed coords by default; reset matrix so
    // we wipe the full buffer regardless of the DPR scale we applied.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setSignature("");
  }, []);

  const handlers = {
    onMouseDown: startDraw,
    onMouseMove: draw,
    onMouseUp: endDraw,
    onMouseLeave: endDraw,
    onTouchStart: startDraw,
    onTouchMove: draw,
    onTouchEnd: endDraw,
  };

  return { canvasRef, signature, setSignature, handlers, clear };
}
