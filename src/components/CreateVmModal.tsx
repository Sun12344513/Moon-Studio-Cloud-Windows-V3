import React, { useState, useEffect } from 'react';
import { X, Plus, Cpu, HardDrive, Layers, AlertTriangle, ShieldCheck, RefreshCw } from 'lucide-react';
import { OsSelector } from './OsSelector';
import { SupportedOsId, OsDefinition } from '../server/imageManager';

interface ImagePreflightItem {
  osId: SupportedOsId;
  status: string;
  mediaState?: string;
  filePath?: string;
  progressPercent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  autoDownloadAvailable?: boolean;
  dockurVersion?: string;
  sourceLabel?: string;
  error?: string;
  remediation?: string;
}

interface CreateVmModalProps {
  isOpen: boolean;
  onClose: () => void;
  osList: OsDefinition[];
  initialOs?: SupportedOsId;
  onVmCreated: (vm: any) => void;
}

export function CreateVmModal({ isOpen, onClose, osList, initialOs, onVmCreated }: CreateVmModalProps) {
  const [selectedOs, setSelectedOs] = useState<SupportedOsId>(initialOs || 'debian-12');
  const [vmName, setVmName] = useState<string>('');
  const [cores, setCores] = useState<number>(2);
  const [memoryMb, setMemoryMb] = useState<number>(initialOs === 'windows-10' ? 4096 : 2048);
  const [diskGb, setDiskGb] = useState<number>(40);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [imageStatuses, setImageStatuses] = useState<Record<string, ImagePreflightItem>>({});
  const [kvmAvailable, setKvmAvailable] = useState<boolean | null>(null);

  const applyOsDefaults = (osId: SupportedOsId) => {
    setSelectedOs(osId);
    setError(null);
    const osDef = osList.find((o) => o.id === osId);
    if (osDef) {
      setMemoryMb(osDef.recommendedRamMb || (osId === 'windows-10' ? 4096 : 2048));
      setDiskGb(Math.max(40, osDef.minDiskGb || 40));
    } else if (osId === 'windows-10') {
      setMemoryMb(4096);
      setDiskGb(40);
    } else {
      setMemoryMb(2048);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    applyOsDefaults(initialOs || 'debian-12');

    Promise.all([
      fetch('/api/v1/images').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/v1/infra').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([imgJson, infraJson]) => {
      if (imgJson?.success && Array.isArray(imgJson.images)) {
        const map: Record<string, ImagePreflightItem> = {};
        for (const item of imgJson.images) {
          map[item.osId] = item;
        }
        setImageStatuses(map);
      }
      if (infraJson?.success && infraJson.report?.virtualization) {
        setKvmAvailable(Boolean(infraJson.report.virtualization.kvmAvailable));
      }
    });
  }, [isOpen, initialOs]);

  if (!isOpen) return null;

  const handleSelectOs = (osId: SupportedOsId) => {
    applyOsDefaults(osId);
  };

  const selectedMedia = imageStatuses[selectedOs];
  const isWindowsOs = selectedOs === 'windows-10' || selectedOs === 'windows-7';
  const isMediaBlocked = false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const targetDef = osList.find((o) => o.id === selectedOs);
    const finalName = vmName.trim() || `Cloud VPS (${targetDef?.name || selectedOs})`;

    try {
      const res = await fetch('/api/v1/vms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osId: selectedOs,
          name: finalName,
          cores,
          memoryMb,
          diskGb,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        onVmCreated(json.vm);
        onClose();
      } else {
        throw new Error(json.error || 'Không thể tạo máy ảo mới.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0d1424] border border-[#1e2a44] rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#1e2a44] flex items-center justify-between bg-[#0a101d]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-[#2f8bff]/10 border border-[#2f8bff]/30 text-[#2f8bff]">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Tạo máy ảo Cloud VPS mới
              </h2>
              <p className="text-xs text-[#8a99ad]">
                Lựa chọn giữa Debian 12 (Linux), Windows 10 (UEFI) hoặc Windows 7 (Legacy)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8a99ad] hover:text-white hover:bg-[#1e2a44] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          {/* OS Selector */}
          <OsSelector
            selectedOs={selectedOs}
            onSelectOs={handleSelectOs}
            osList={osList}
            disabled={isSubmitting}
          />

          {/* Auto-configured dockurr/windows ISO Engine Info */}
          {isWindowsOs && (
            <div className="p-3.5 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-start gap-3">
              <RefreshCw className={`w-5 h-5 text-sky-400 shrink-0 mt-0.5 ${selectedMedia?.status === 'DOWNLOADING' ? 'animate-spin' : ''}`} />
              <div className="text-xs text-sky-100/90 leading-relaxed space-y-1">
                <span className="font-bold text-sky-300 block">
                  {selectedMedia?.status === 'READY'
                    ? `Bộ cài đặt ${selectedOs === 'windows-10' ? 'Windows 10' : 'Windows 7'} ISO đã sẵn sàng trên máy chủ`
                    : selectedMedia?.status === 'DOWNLOADING'
                    ? `Đang tự động tải ISO qua dockurr/windows (${selectedMedia.progressPercent || 0}%)`
                    : `Tự động tải ISO qua dockurr/windows (VERSION=${selectedMedia?.dockurVersion || (selectedOs === 'windows-10' ? '10' : '7u')})`}
                </span>
                <p>
                  {selectedMedia?.status === 'READY'
                    ? 'File ISO Windows chuẩn đã được xác minh cục bộ và sẵn sàng khởi tạo máy ảo ngay.'
                    : 'Hệ thống tự động phân giải và tải bộ cài đặt Windows chính thức từ hệ thống mirror dockurr/windows mà không cần cấu hình thủ công.'}
                </p>
                {kvmAvailable === false && (
                  <p className="text-amber-300/90">
                    Lưu ý hạ tầng: Máy chủ container hiện không có <code className="font-mono">/dev/kvm</code> (chạy QEMU TCG software emulation nên quá trình cài Windows sẽ chậm hơn so với máy chủ Linux KVM).
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Windows 10 UEFI + TPM 2.0 Architecture Info */}
          {selectedOs === 'windows-10' && (
            <div className="p-3 rounded-xl bg-[#2f8bff]/10 border border-[#2f8bff]/30 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-[#2f8bff] shrink-0 mt-0.5" />
              <div className="text-xs text-[#c7dcf7] leading-relaxed">
                <span className="font-semibold text-[#2f8bff] block mb-0.5">
                  Cấu hình Windows 10 Pro (UEFI + TPM 2.0 + AHCI):
                </span>
                Sử dụng máy ảo QEMU Q35, firmware UEFI (OVMF), TPM 2.0 (swtpm), ổ cứng QCOW2 SATA và card mạng Intel e1000e. Yêu cầu file ISO/đĩa Windows 10 hợp lệ trên máy chủ; tài khoản quản trị mặc định có đầy đủ quyền Administrator với UAC tiêu chuẩn.
              </div>
            </div>
          )}

          {/* Windows 7 Security Warning */}
          {selectedOs === 'windows-7' && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200/90 leading-relaxed">
                <span className="font-semibold text-amber-400 block mb-0.5">
                  Lưu ý bảo mật về Windows 7:
                </span>
                Hệ điều hành Windows 7 đã kết thúc hỗ trợ cập nhật từ Microsoft. Máy ảo sẽ được cấu hình phần cứng tương thích chuẩn Legacy PC (SeaBIOS, IDE, Intel e1000).
              </div>
            </div>
          )}

          {/* VM Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#8a99ad] uppercase">
              Tên máy ảo (VM Name)
            </label>
            <input
              type="text"
              placeholder={
                selectedOs === 'windows-10'
                  ? 'Cloud Windows 10 Pro Workstation'
                  : selectedOs === 'windows-7'
                  ? 'Cloud Windows 7 Workstation'
                  : 'Cloud Debian 12 Linux'
              }
              value={vmName}
              onChange={(e) => setVmName(e.target.value)}
              disabled={isSubmitting}
              className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#8a99ad]/40 focus:outline-none focus:border-[#2f8bff]"
            />
          </div>

          {/* Resource Configurations */}
          <div className="grid grid-cols-3 gap-3">
            {/* CPU Cores */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> Cores
              </label>
              <select
                value={cores}
                onChange={(e) => setCores(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1}>1 vCPU</option>
                <option value={2}>2 vCPUs</option>
                <option value={4}>4 vCPUs</option>
              </select>
            </div>

            {/* RAM */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" /> RAM
              </label>
              <select
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1024}>1 GB</option>
                <option value={2048}>2 GB (Khuyến nghị Debian/Win7)</option>
                <option value={4096}>4 GB (Khuyến nghị Win10)</option>
                <option value={8192}>8 GB</option>
              </select>
            </div>

            {/* Disk */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <HardDrive className="w-3.5 h-3.5" /> Ổ đĩa
              </label>
              <select
                value={diskGb}
                onChange={(e) => setDiskGb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={20}>20 GB</option>
                <option value={40}>40 GB (Khuyến nghị)</option>
                <option value={80}>80 GB</option>
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-4 border-t border-[#1e2a44] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg border border-[#1e2a44] text-[#8a99ad] hover:text-white text-xs font-medium transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isMediaBlocked}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-[#2f8bff] hover:bg-[#2573d9] text-white text-xs font-semibold shadow-lg shadow-[#2f8bff]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Đang khởi tạo VM...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Tạo máy ảo ngay
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
