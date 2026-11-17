import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  RefreshCw,
  Maximize2,
  Minimize2,
  CornerDownLeft,
  Keyboard,
  Power,
  ShieldCheck,
  MousePointer,
  Send,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface VmDisplayViewerProps {
  vmId?: string;
  vmName?: string;
  osId?: string;
  status?: string;
}

type ClickMode = 'left' | 'right' | 'double';

const DOM_KEY_TO_QCODE: Record<string, string> = {
  Enter: 'ret',
  NumpadEnter: 'kp_enter',
  Escape: 'esc',
  Backspace: 'backspace',
  Tab: 'tab',
  ' ': 'spc',
  Space: 'spc',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  CapsLock: 'caps_lock',
  Meta: 'meta_l',
  OS: 'meta_l',
  F1: 'f1',
  F2: 'f2',
  F3: 'f3',
  F4: 'f4',
  F5: 'f5',
  F6: 'f6',
  F7: 'f7',
  F8: 'f8',
  F9: 'f9',
  F10: 'f10',
  F11: 'f11',
  F12: 'f12',
  '-': 'minus',
  '_': 'minus',
  '=': 'equal',
  '+': 'equal',
  '[': 'bracket_left',
  '{': 'bracket_left',
  ']': 'bracket_right',
  '}': 'bracket_right',
  '\\': 'backslash',
  '|': 'backslash',
  ';': 'semicolon',
  ':': 'semicolon',
  "'": 'apostrophe',
  '"': 'apostrophe',
  '`': 'grave_accent',
  '~': 'grave_accent',
  ',': 'comma',
  '<': 'comma',
  '.': 'dot',
  '>': 'dot',
  '/': 'slash',
  '?': 'slash',
};

const SHIFTED_SYMBOL_QCODE: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  '_': 'minus',
  '+': 'equal',
  '{': 'bracket_left',
  '}': 'bracket_right',
  '|': 'backslash',
  ':': 'semicolon',
  '"': 'apostrophe',
  '~': 'grave_accent',
  '<': 'comma',
  '>': 'dot',
  '?': 'slash',
};

function mapKeyboardEventToQcodes(e: React.KeyboardEvent): { keys: string[]; label: string } | null {
  if (['Shift', 'Control', 'Alt'].includes(e.key)) {
    return null;
  }

  let baseQcode: string | null = null;
  let forceShift = false;

  if (/^[a-zA-Z]$/.test(e.key)) {
    baseQcode = e.key.toLowerCase();
    if (e.key >= 'A' && e.key <= 'Z') forceShift = true;
  } else if (/^[0-9]$/.test(e.key)) {
    baseQcode = e.key;
  } else if (SHIFTED_SYMBOL_QCODE[e.key]) {
    baseQcode = SHIFTED_SYMBOL_QCODE[e.key];
    forceShift = true;
  } else if (DOM_KEY_TO_QCODE[e.key]) {
    baseQcode = DOM_KEY_TO_QCODE[e.key];
  } else if (DOM_KEY_TO_QCODE[e.code]) {
    baseQcode = DOM_KEY_TO_QCODE[e.code];
  }

  if (!baseQcode) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey || forceShift) mods.push('shift');
  if (e.metaKey && baseQcode !== 'meta_l') mods.push('meta_l');

  const keys = [...mods, baseQcode];
  const label = [...mods.map((m) => m.toUpperCase()), e.key === ' ' ? 'Space' : e.key].join('+');
  return { keys, label };
}

export function VmDisplayViewer({ vmId, vmName, osId, status }: VmDisplayViewerProps) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(600);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Interactive Pointer & Keyboard State
  const [clickMode, setClickMode] = useState<ClickMode>('left');
  const [mouseFollow, setMouseFollow] = useState<boolean>(true);
  const [captureKeyboard, setCaptureKeyboard] = useState<boolean>(true);
  const [isScreenFocused, setIsScreenFocused] = useState<boolean>(false);
  const [cursorCoords, setCursorCoords] = useState<{ x: number; y: number } | null>(null);
  const [clickMarker, setClickMarker] = useState<{ pctX: number; pctY: number; button: string } | null>(null);
  const [textInput, setTextInput] = useState<string>('');
  const [sendingText, setSendingText] = useState<boolean>(false);
  const [showFnKeys, setShowFnKeys] = useState<boolean>(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const inFlightShotRef = useRef<boolean>(false);
  const lastMoveSentRef = useRef<number>(0);
  const isDraggingRef = useRef<boolean>(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasQemuDisplay = osId !== 'debian-12' && status !== 'Failed' && status !== 'Stopped';

  const showToast = useCallback((msg: string) => {
    setFeedbackMsg(msg);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedbackMsg(null), 1400);
  }, []);

  const refreshScreenshot = useCallback(async (manual = false) => {
    if (!vmId || !hasQemuDisplay || inFlightShotRef.current) return;
    inFlightShotRef.current = true;
    if (manual) setLoading(true);
    try {
      const res = await fetch(`/api/v1/vms/${vmId}/screenshot?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const w = Number(res.headers.get('X-Framebuffer-Width') || '0');
        const h = Number(res.headers.get('X-Framebuffer-Height') || '0');
        if (w > 0 && h > 0) {
          setResolution({ w, h });
        }
        const blob = await res.blob();
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = nextUrl;
        setScreenshotUrl(nextUrl);
        setLastRefreshed(new Date().toLocaleTimeString('vi-VN'));
      }
    } catch {
      // ignore transient errors
    } finally {
      inFlightShotRef.current = false;
      if (manual) setLoading(false);
    }
  }, [vmId, hasQemuDisplay]);

  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setScreenshotUrl(null);
    setResolution(null);
    if (hasQemuDisplay) {
      refreshScreenshot(true);
    }
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [vmId, osId, status, hasQemuDisplay, refreshScreenshot]);

  useEffect(() => {
    if (refreshIntervalMs <= 0 || !vmId || !hasQemuDisplay) return;
    const interval = setInterval(() => {
      refreshScreenshot(false);
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs, vmId, hasQemuDisplay, refreshScreenshot]);

  const postInput = useCallback(async (payload: Record<string, unknown>, refreshDelay = 120) => {
    if (!vmId || !hasQemuDisplay) return false;
    try {
      const res = await fetch(`/api/v1/vms/${vmId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({ success: false }));
      if (json.success && refreshDelay >= 0) {
        setTimeout(() => {
          refreshScreenshot(false);
        }, refreshDelay);
      }
      return Boolean(json.success);
    } catch {
      return false;
    }
  }, [vmId, hasQemuDisplay, refreshScreenshot]);

  const sendKeyCombo = async (keys: string[], label: string) => {
    const ok = await postInput({ type: 'key_combo', keys }, 180);
    if (ok) showToast(`Phím: ${label}`);
  };

  const getNormalizedCoords = (clientX: number, clientY: number) => {
    const el = imgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const px = Math.round(normX * (resolution?.w || Math.round(rect.width)));
    const py = Math.round(normY * (resolution?.h || Math.round(rect.height)));
    return { normX, normY, px, py };
  };

  const triggerClickIndicator = (normX: number, normY: number, buttonLabel: string) => {
    setClickMarker({ pctX: normX * 100, pctY: normY * 100, button: buttonLabel });
    setTimeout(() => setClickMarker(null), 350);
  };

  const handleImageMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;
    setCursorCoords({ x: coords.px, y: coords.py });

    if (!mouseFollow && !isDraggingRef.current) return;
    const now = Date.now();
    if (now - lastMoveSentRef.current < 75) return;
    lastMoveSentRef.current = now;
    void postInput({ type: 'mouse_move', normX: coords.normX, normY: coords.normY }, -1);
  };

  const handleImageMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!hasQemuDisplay) return;
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

    // Physical middle or right mouse button
    if (e.button === 1) {
      e.preventDefault();
      triggerClickIndicator(coords.normX, coords.normY, 'middle');
      void postInput({ type: 'mouse_click', normX: coords.normX, normY: coords.normY, button: 'middle' }, 150);
      showToast(`Chuột giữa (${coords.px}, ${coords.py})`);
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      // Right-click is also handled in onContextMenu to ensure browser context menu stays blocked
      return;
    }

    // Left physical click — obeys clickMode selector for trackpad/touch convenience
    if (e.button === 0) {
      if (clickMode === 'right') {
        triggerClickIndicator(coords.normX, coords.normY, 'right');
        void postInput({ type: 'mouse_click', normX: coords.normX, normY: coords.normY, button: 'right' }, 150);
        showToast(`Chuột phải (${coords.px}, ${coords.py})`);
      } else if (clickMode === 'double') {
        triggerClickIndicator(coords.normX, coords.normY, 'left');
        void postInput({ type: 'mouse_click', normX: coords.normX, normY: coords.normY, button: 'left', doubleClick: true }, 180);
        showToast(`Click đúp (${coords.px}, ${coords.py})`);
      } else {
        isDraggingRef.current = true;
        triggerClickIndicator(coords.normX, coords.normY, 'left');
        void postInput({ type: 'mouse_down', normX: coords.normX, normY: coords.normY, button: 'left' }, -1);
      }
    }
  };

  const handleImageMouseUp = (e: React.MouseEvent<HTMLImageElement>) => {
    if (e.button === 0 && isDraggingRef.current) {
      isDraggingRef.current = false;
      const coords = getNormalizedCoords(e.clientX, e.clientY);
      if (!coords) return;
      void postInput({ type: 'mouse_up', normX: coords.normX, normY: coords.normY, button: 'left' }, 120);
      showToast(`Click trái (${coords.px}, ${coords.py})`);
    }
  };

  const handleImageContextMenu = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    if (!hasQemuDisplay) return;
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;
    triggerClickIndicator(coords.normX, coords.normY, 'right');
    void postInput({ type: 'mouse_click', normX: coords.normX, normY: coords.normY, button: 'right' }, 150);
    showToast(`Chuột phải (${coords.px}, ${coords.py})`);
  };

  const handleImageDoubleClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!hasQemuDisplay || clickMode !== 'left') return;
    e.preventDefault();
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;
    triggerClickIndicator(coords.normX, coords.normY, 'left');
    void postInput({ type: 'mouse_click', normX: coords.normX, normY: coords.normY, button: 'left', doubleClick: true }, 180);
    showToast(`Click đúp (${coords.px}, ${coords.py})`);
  };

  const handleImageWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    if (!hasQemuDisplay) return;
    e.preventDefault();
    const coords = getNormalizedCoords(e.clientX, e.clientY);
    const direction = e.deltaY < 0 ? 'up' : 'down';
    void postInput(
      {
        type: 'mouse_wheel',
        normX: coords?.normX,
        normY: coords?.normY,
        direction,
      },
      150
    );
  };

  const handleViewportKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasQemuDisplay || !captureKeyboard) return;
    // Do not hijack typing inside the dedicated text input bar
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const mapped = mapKeyboardEventToQcodes(e);
    if (!mapped) return;
    e.preventDefault();
    e.stopPropagation();
    void sendKeyCombo(mapped.keys, mapped.label);
  };

  const handleSendTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput || sendingText || !hasQemuDisplay) return;
    setSendingText(true);
    try {
      const ok = await postInput({ type: 'text', text: textInput }, 250);
      if (ok) {
        showToast(`Đã gõ ${textInput.length} ký tự`);
        setTextInput('');
      }
    } finally {
      setSendingText(false);
    }
  };

  return (
    <div
      className={`bg-[#0d1424] border border-[#1e2a44] rounded-xl shadow-2xl overflow-hidden transition-all ${
        isFullscreen ? 'fixed inset-4 z-50 flex flex-col bg-[#070b14]' : ''
      }`}
    >
      {/* Header */}
      <div className="p-3.5 sm:p-4 bg-[#0a101d] border-b border-[#1e2a44] flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-[#070b14] border border-[#1e2a44] text-[#2f8bff]">
            <Monitor className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-xs sm:text-sm font-bold text-white tracking-wide">
                Màn hình tương tác QEMU (Real VM Console)
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#42d6a0]/15 text-[#42d6a0] border border-[#42d6a0]/30">
                100% QMP Mouse + Keyboard
              </span>
              {resolution && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#070b14] text-[#8a99ad] border border-[#1e2a44]">
                  {resolution.w}×{resolution.h}
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#8a99ad]">
              {vmName || 'Virtual Machine'} • Cập nhật lúc: {lastRefreshed || 'Đang tải...'}
              {cursorCoords ? ` • Con trỏ: (${cursorCoords.x}, ${cursorCoords.y})` : ''}
            </p>
          </div>
        </div>

        {/* Refresh Rate & Fullscreen Controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="inline-flex items-center rounded-lg bg-[#070b14] border border-[#1e2a44] p-0.5 text-[11px]">
            {[
              { label: '0.6s', ms: 600 },
              { label: '1.5s', ms: 1500 },
              { label: '4s', ms: 4000 },
              { label: 'Tắt', ms: 0 },
            ].map((opt) => (
              <button
                key={opt.ms}
                type="button"
                onClick={() => setRefreshIntervalMs(opt.ms)}
                className={`px-2 py-1 rounded font-mono transition-colors cursor-pointer ${
                  refreshIntervalMs === opt.ms
                    ? 'bg-[#2f8bff] text-white font-bold'
                    : 'text-[#8a99ad] hover:text-white'
                }`}
                title="Tần suất làm mới khung hình QEMU"
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => refreshScreenshot(true)}
            className="p-1.5 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-[#8a99ad] hover:text-white border border-[#1e2a44] transition-colors cursor-pointer"
            title="Chụp lại màn hình ngay"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#2f8bff]' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-[#8a99ad] hover:text-white border border-[#1e2a44] transition-colors cursor-pointer"
            title={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Pointer & Input Mode Bar */}
      {hasQemuDisplay && (
        <div className="px-3.5 py-2 bg-[#070b14] border-b border-[#1e2a44] flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[#8a99ad] flex items-center gap-1 mr-1">
              <MousePointer className="w-3.5 h-3.5 text-[#2f8bff]" />
              Chế độ click:
            </span>
            {(
              [
                { id: 'left', label: 'Chuột Trái' },
                { id: 'right', label: 'Chuột Phải' },
                { id: 'double', label: 'Click Đúp' },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setClickMode(mode.id)}
                className={`px-2 py-0.5 rounded border font-medium transition-colors cursor-pointer ${
                  clickMode === mode.id
                    ? 'bg-[#2f8bff]/20 border-[#2f8bff] text-white'
                    : 'bg-[#0a101d] border-[#1e2a44] text-[#8a99ad] hover:text-white'
                }`}
              >
                {mode.label}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setMouseFollow(!mouseFollow)}
              className={`ml-1 px-2 py-0.5 rounded border font-medium transition-colors cursor-pointer ${
                mouseFollow
                  ? 'bg-[#42d6a0]/15 border-[#42d6a0]/40 text-[#42d6a0]'
                  : 'bg-[#0a101d] border-[#1e2a44] text-[#8a99ad] hover:text-white'
              }`}
              title="Di chuyển trỏ chuột thật trong QEMU theo vị trí chuột trên màn hình"
            >
              {mouseFollow ? '● Theo dõi di chuột' : '○ Chỉ gửi khi click'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCaptureKeyboard(!captureKeyboard)}
              className={`px-2.5 py-0.5 rounded border font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                captureKeyboard
                  ? isScreenFocused
                    ? 'bg-[#42d6a0]/20 border-[#42d6a0] text-[#42d6a0]'
                    : 'bg-[#2f8bff]/15 border-[#2f8bff]/40 text-[#2f8bff]'
                  : 'bg-[#0a101d] border-[#1e2a44] text-[#8a99ad] hover:text-white'
              }`}
              title="Click vào màn hình VM để gõ phím trực tiếp bằng bàn phím của bạn"
            >
              <Keyboard className="w-3.5 h-3.5" />
              <span>
                {captureKeyboard
                  ? isScreenFocused
                    ? 'Đang bắt phím trực tiếp'
                    : 'Bắt phím: Bật (nhấp vào màn hình để gõ)'
                  : 'Bắt phím trực tiếp: Tắt'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Screen Framebuffer Canvas / Interactive Viewport */}
      <div
        tabIndex={hasQemuDisplay ? 0 : -1}
        onKeyDown={handleViewportKeyDown}
        onFocus={() => setIsScreenFocused(true)}
        onBlur={() => setIsScreenFocused(false)}
        className={`relative bg-black flex items-center justify-center min-h-[280px] sm:min-h-[400px] p-2 overflow-hidden flex-1 outline-none ${
          isScreenFocused && captureKeyboard ? 'ring-2 ring-inset ring-[#42d6a0]/60' : ''
        }`}
      >
        {screenshotUrl ? (
          <div className="relative inline-flex items-center justify-center">
            <img
              ref={imgRef}
              src={screenshotUrl}
              alt="Real VM Live Framebuffer"
              draggable={false}
              onMouseMove={handleImageMouseMove}
              onMouseDown={handleImageMouseDown}
              onMouseUp={handleImageMouseUp}
              onContextMenu={handleImageContextMenu}
              onDoubleClick={handleImageDoubleClick}
              onWheel={handleImageWheel}
              className={`max-w-full object-contain rounded border border-[#1e2a44]/80 shadow-2xl select-none cursor-crosshair ${
                isFullscreen ? 'max-h-[calc(100vh-260px)]' : 'max-h-[540px]'
              }`}
            />
            {clickMarker && (
              <span
                style={{
                  left: `${clickMarker.pctX}%`,
                  top: `${clickMarker.pctY}%`,
                }}
                className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 animate-ping ${
                  clickMarker.button === 'right'
                    ? 'border-amber-400 bg-amber-400/30'
                    : 'border-[#2f8bff] bg-[#2f8bff]/30'
                }`}
              />
            )}
          </div>
        ) : osId === 'debian-12' ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2.5 text-center px-6 max-w-md">
            <ShieldCheck className="w-8 h-8 text-[#42d6a0]" />
            <p className="text-xs font-semibold text-white">
              Debian 12 đang chạy ở chế độ Native Cloud Host (XRDP / XFCE4)
            </p>
            <p className="text-[11px] text-[#8a99ad] leading-relaxed">
              Debian 12 không sử dụng QEMU VGA framebuffer. Hãy dùng Cloud Web Shell hoặc kết nối Remote Desktop tới cổng 3389.
            </p>
          </div>
        ) : status === 'Failed' || status === 'Stopped' ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2.5 text-center px-6 max-w-md">
            <Power className="w-8 h-8 text-amber-400" />
            <p className="text-xs font-semibold text-white">
              {status === 'Failed' ? 'Máy ảo chưa thể khởi động QEMU Framebuffer' : 'Máy ảo đang tạm dừng (Stopped)'}
            </p>
            <p className="text-[11px] text-[#8a99ad] leading-relaxed">
              {status === 'Failed'
                ? 'Kiểm tra thông báo lỗi ở thẻ kết nối phía trên hoặc Server Logs bên dưới để biết nguyên nhân chi tiết.'
                : 'Nhấn "Bật máy" ở phía trên để khởi động lại tiến trình QEMU.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
            <RefreshCw className="w-8 h-8 text-[#2f8bff] animate-spin" />
            <p className="text-xs text-[#8a99ad] font-mono">
              Đang kết nối framebuffer máy ảo QEMU...
            </p>
          </div>
        )}

        {feedbackMsg && (
          <div className="pointer-events-none absolute top-3 right-3 bg-black/85 border border-[#42d6a0] text-[#42d6a0] px-2.5 py-1 rounded text-[11px] font-mono shadow-lg flex items-center gap-1.5">
            <CornerDownLeft className="w-3 h-3" />
            <span>{feedbackMsg}</span>
          </div>
        )}
      </div>

      {/* Text Typing Bar & Comprehensive Keyboard Controls */}
      {hasQemuDisplay && (
        <div className="p-3 bg-[#0a101d] border-t border-[#1e2a44] space-y-2.5 text-xs">
          {/* Direct Text Injection Form */}
          <form onSubmit={handleSendTextSubmit} className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px] flex items-center gap-2 bg-[#070b14] border border-[#1e2a44] rounded-lg px-2.5 py-1.5 focus-within:border-[#2f8bff]">
              <Keyboard className="w-3.5 h-3.5 text-[#2f8bff] shrink-0" />
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Nhập chuỗi văn bản hoặc mật khẩu để gõ tự động vào máy ảo..."
                className="w-full bg-transparent text-xs text-white placeholder-[#8a99ad]/60 font-mono focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!textInput || sendingText}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2f8bff] hover:bg-[#2573d9] disabled:opacity-40 text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{sendingText ? 'Đang gõ...' : 'Gửi chữ'}</span>
            </button>
          </form>

          {/* System Combos & Navigation Quick Keys */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { keys: ['ctrl', 'alt', 'delete'], label: 'Ctrl+Alt+Del', accent: 'amber' },
                { keys: ['meta_l'], label: 'Win', accent: 'blue' },
                { keys: ['meta_l', 'r'], label: 'Win+R', accent: 'blue' },
                { keys: ['alt', 'tab'], label: 'Alt+Tab', accent: 'default' },
                { keys: ['alt', 'f4'], label: 'Alt+F4', accent: 'default' },
                { keys: ['shift', 'f10'], label: 'Shift+F10', accent: 'default' },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => sendKeyCombo(item.keys, item.label)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono font-bold transition-colors cursor-pointer ${
                    item.accent === 'amber'
                      ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30'
                      : item.accent === 'blue'
                      ? 'bg-[#2f8bff]/10 hover:bg-[#2f8bff]/20 text-[#2f8bff] border-[#2f8bff]/30'
                      : 'bg-[#070b14] hover:bg-[#1e2a44] text-white border-[#1e2a44]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { keys: ['ret'], label: '↵ Enter' },
                { keys: ['spc'], label: '␣ Space' },
                { keys: ['backspace'], label: '⌫ Back' },
                { keys: ['tab'], label: 'Tab' },
                { keys: ['esc'], label: 'Esc' },
                { keys: ['delete'], label: 'Del' },
                { keys: ['up'], label: '↑' },
                { keys: ['down'], label: '↓' },
                { keys: ['left'], label: '←' },
                { keys: ['right'], label: '→' },
                { keys: ['f8'], label: 'F8' },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => sendKeyCombo(item.keys, item.label)}
                  className="px-2 py-1 rounded bg-[#070b14] hover:bg-[#1e2a44] text-white border border-[#1e2a44] text-[11px] font-mono font-bold transition-colors cursor-pointer"
                >
                  {item.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setShowFnKeys(!showFnKeys)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#070b14] hover:bg-[#1e2a44] text-[#8a99ad] hover:text-white border border-[#1e2a44] text-[11px] font-mono transition-colors cursor-pointer"
              >
                <span>F1–F12</span>
                {showFnKeys ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {showFnKeys && (
            <div className="pt-1.5 border-t border-[#1e2a44]/60 flex items-center gap-1.5 flex-wrap">
              {Array.from({ length: 12 }, (_, idx) => `f${idx + 1}`).map((fn) => (
                <button
                  key={fn}
                  type="button"
                  onClick={() => sendKeyCombo([fn], fn.toUpperCase())}
                  className="px-2 py-1 rounded bg-[#070b14] hover:bg-[#1e2a44] text-white border border-[#1e2a44] text-[11px] font-mono font-bold transition-colors cursor-pointer"
                >
                  {fn.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
