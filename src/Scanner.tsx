import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, ScanLine, Keyboard, ArrowRight, ShieldCheck } from 'lucide-react';
import { Button, ErrorBanner } from './components';
import { errorMessage } from './api';

export function ParcelScanner({ onScan, busy, placeholder = 'Scan or enter CN / order number', title = 'Find the right order', compact = false }: { onScan: (code: string) => void | Promise<void>; busy?: boolean; placeholder?: string; title?: string; compact?: boolean }) {
  const [code, setCode] = useState(''); const [camera, setCamera] = useState(false); const [error, setError] = useState(''); const [starting, setStarting] = useState(false);
  const video = useRef<HTMLVideoElement>(null); const controls = useRef<{ stop: () => void } | null>(null); const mounted = useRef(true); const lock = useRef(false); const last = useRef({ code: '', at: 0 }); const callback = useRef(onScan); callback.current = onScan;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controls.current?.stop(); }; }, []);
  const stop = () => { controls.current?.stop(); controls.current = null; if (mounted.current) setCamera(false); };
  async function start() {
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError('Camera access needs HTTPS (or localhost). Use the manual field or a USB barcode scanner instead.'); return; }
    setStarting(true);
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      const { DecodeHintType, BarcodeFormat } = await import('@zxing/library');
      const hints = new Map(); hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.ITF, BarcodeFormat.UPC_A]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 250 });
      if (!mounted.current || !video.current) return;
      setCamera(true);
      const scannerControls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }, video.current, async result => {
        if (!result || lock.current || !mounted.current) return;
        const text = result.getText().trim(); const at = Date.now();
        if (text === last.current.code && at - last.current.at < 2500) return;
        last.current = { code: text, at }; lock.current = true; stop();
        try { await callback.current(text); } finally { lock.current = false; }
      });
      if (!mounted.current) { scannerControls.stop(); return; }
      controls.current = scannerControls;
    } catch (e) {
      stop(); const message = errorMessage(e);
      setError(/permission|notallowed|denied/i.test(message) ? 'Camera permission was denied. Allow camera access in your browser settings, or enter the code below.' : `Camera could not start. ${message} Manual entry still works.`);
    } finally { if (mounted.current) setStarting(false); }
  }
  return <div className={`scanner-card ${compact ? 'scanner-compact' : ''}`}>
    {!compact && <div className="scanner-heading"><span className="icon-tile sage"><ScanLine size={23} /></span><div><h2>{title}</h2><p>One scan. The complete packing checklist.</p></div></div>}
    <div className={`camera-view ${camera ? 'active' : ''}`} style={{ display: camera ? 'block' : 'none' }}><video ref={video} muted playsInline autoPlay /><div className="scan-target"><span /><span /><span /><span /><div className="scan-laser" /></div><button className="camera-stop" onClick={stop}><CameraOff size={16} />Stop camera</button></div>
    {!compact && !camera && <div className="scanner-illustration"><div className="barcode-lines" /><ScanLine size={42} strokeWidth={1.2} /><span>Position the parcel barcode inside the frame</span></div>}
    <ErrorBanner message={error} />
    <form className="scanner-form" onSubmit={e => { e.preventDefault(); if (code.trim() && !busy) { setError(''); void onScan(code.trim()); setCode(''); } }}>
      <div className="input-with-icon"><Keyboard size={18} /><input aria-label={placeholder} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} placeholder={placeholder} maxLength={120} /></div>
      <Button type="submit" loading={busy} disabled={!code.trim()} icon={ArrowRight}>Find order</Button>
    </form>
    <div className="scanner-footer"><span><ShieldCheck size={14} />Camera stays on your device</span><Button variant="ghost" icon={camera ? CameraOff : Camera} loading={starting} onClick={camera ? stop : start}>{camera ? 'Stop camera' : compact ? 'Camera scan' : 'Use phone camera'}</Button></div>
  </div>;
}
