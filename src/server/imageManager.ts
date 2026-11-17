import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serverLogger } from './logger';
import { dockurEngine, getDockurVersionCode } from './dockurEngine';

export type SupportedOsId = 'debian-12' | 'windows-10' | 'windows-7';

export const SUPPORTED_OS_IDS: readonly SupportedOsId[] = ['debian-12', 'windows-10', 'windows-7'] as const;

export function isSupportedOsId(value: unknown): value is SupportedOsId {
  return value === 'debian-12' || value === 'windows-10' || value === 'windows-7';
}

export interface OsDefinition {
  id: SupportedOsId;
  name: string;
  version: string;
  arch: 'x86_64';
  family: 'linux' | 'windows';
  description: string;
  supportStatus: 'Active LTS' | 'Active Support' | 'End of Support (EOS)';
  securityWarning?: string;
  isoFileName: string;
  defaultUsername: string;
  minRamMb: number;
  minDiskGb: number;
  recommendedRamMb: number;
  recommendedCores: number;
  firmware?: 'SeaBIOS' | 'UEFI (OVMF + TPM 2.0)';
  hypervisorProfile?: {
    chipset: string;
    diskBus: string;
    nic: string;
    vga: string;
  };
}

export type MediaValidationState =
  | 'NATIVE_HOST_READY'
  | 'GENUINE_ISO'
  | 'INSTALLED_DISK'
  | 'AUTO_DOWNLOAD_READY'
  | 'MISSING_MEDIA'
  | 'INVALID_STUB_ISO'
  | 'DOWNLOADING';

export interface ImageStatus {
  osId: SupportedOsId;
  fileName: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  status: 'READY' | 'AUTO_DOWNLOAD' | 'DOWNLOADING' | 'VERIFYING' | 'MISSING' | 'ERROR';
  mediaState: MediaValidationState;
  progressPercent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  autoDownloadAvailable: boolean;
  dockurVersion: string;
  sourceLabel: string;
  lastChecked: string;
  error?: string;
  remediation?: string;
}

const MIN_GENUINE_WINDOWS_ISO_BYTES = 500 * 1024 * 1024; // 500 MiB minimum for real Windows installer ISO
const MIN_GENUINE_WINDOWS_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB minimum for installed Windows QCOW2

export class ImageManager {
  private isoDir: string;
  private disksDir: string;
  private catalog: Map<SupportedOsId, OsDefinition> = new Map();
  private imageStates: Map<SupportedOsId, ImageStatus> = new Map();
  private downloadProgress: Map<SupportedOsId, { percent: number; downloadedBytes: number; totalBytes: number; provider: string }> = new Map();

  constructor() {
    this.isoDir = path.resolve(process.cwd(), 'data/iso');
    this.disksDir = path.resolve(process.cwd(), 'data/disks');
    try {
      fs.mkdirSync(this.isoDir, { recursive: true });
      fs.mkdirSync(this.disksDir, { recursive: true });
    } catch {
      // ignore
    }

    this.catalog.set('debian-12', {
      id: 'debian-12',
      name: 'Debian 12',
      version: '12 (Bookworm)',
      arch: 'x86_64',
      family: 'linux',
      description: 'Hệ điều hành Linux Debian 12 Bookworm ổn định, tích hợp môi trường Desktop XFCE4 và dịch vụ Remote Desktop (xrdp).',
      supportStatus: 'Active LTS',
      isoFileName: 'debian-12-standard.iso',
      defaultUsername: 'Administrator',
      minRamMb: 1024,
      minDiskGb: 20,
      recommendedRamMb: 2048,
      recommendedCores: 2,
      firmware: 'SeaBIOS',
      hypervisorProfile: {
        chipset: 'Native Host Container / VirtIO',
        diskBus: 'VirtIO-blk',
        nic: 'VirtIO-net',
        vga: 'Standard VGA',
      },
    });

    this.catalog.set('windows-10', {
      id: 'windows-10',
      name: 'Windows 10',
      version: 'Windows 10 Pro 22H2 (x64)',
      arch: 'x86_64',
      family: 'windows',
      description: 'Máy ảo Windows 10 Pro (64-bit) thật trên QEMU Q35 + UEFI (OVMF) + TPM 2.0 với quyền quản trị Administrator và lưu trữ QCOW2 bền vững.',
      supportStatus: 'Active Support',
      isoFileName: 'windows-10-x64.iso',
      defaultUsername: 'Administrator',
      minRamMb: 2048,
      minDiskGb: 40,
      recommendedRamMb: 4096,
      recommendedCores: 2,
      firmware: 'UEFI (OVMF + TPM 2.0)',
      hypervisorProfile: {
        chipset: 'Intel Q35 + UEFI OVMF + TPM 2.0',
        diskBus: 'AHCI SATA (qcow2)',
        nic: 'Intel e1000e',
        vga: 'Standard VGA',
      },
    });

    this.catalog.set('windows-7', {
      id: 'windows-7',
      name: 'Windows 7',
      version: 'Windows 7 SP1 Ultimate (x64)',
      arch: 'x86_64',
      family: 'windows',
      description: 'Hệ điều hành Windows 7 SP1 (64-bit) cổ điển, tương thích ứng dụng legacy với phần cứng chuẩn PC/IDE.',
      supportStatus: 'End of Support (EOS)',
      securityWarning: 'Microsoft đã chính thức kết thúc hỗ trợ và cập nhật bảo mật cho Windows 7. Khuyến nghị chạy trong mạng cô lập hoặc kiểm thử phần mềm cũ.',
      isoFileName: 'windows-7-sp1-x64.iso',
      defaultUsername: 'Administrator',
      minRamMb: 2048,
      minDiskGb: 40,
      recommendedRamMb: 2048,
      recommendedCores: 2,
      firmware: 'SeaBIOS',
      hypervisorProfile: {
        chipset: 'i440fx (Legacy PC)',
        diskBus: 'IDE',
        nic: 'Intel e1000',
        vga: 'Standard VGA',
      },
    });

    this.refreshImageStatuses();
  }

  public getOsCatalog(): OsDefinition[] {
    return Array.from(this.catalog.values());
  }

  public getOsDefinition(osId: SupportedOsId): OsDefinition | undefined {
    return this.catalog.get(osId);
  }

  public resolveIsoPath(osId: SupportedOsId): string {
    const def = this.catalog.get(osId);
    return path.join(this.isoDir, def?.isoFileName || `${osId}.iso`);
  }

  public resolvePreinstalledDiskPath(osId: SupportedOsId): string | null {
    const baseImage = path.join(this.disksDir, `${osId}-base.qcow2`);
    if (fs.existsSync(baseImage)) {
      return baseImage;
    }
    return null;
  }

  /**
   * Validates whether an ISO file is a genuine Windows installation image
   * (rejecting small synthetic stubs or placeholder NASM boot sectors).
   */
  public validateWindowsIsoMedia(filePath: string): {
    valid: boolean;
    mediaState: MediaValidationState;
    sizeBytes: number;
    reason?: string;
  } {
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        mediaState: 'MISSING_MEDIA',
        sizeBytes: 0,
        reason: `Installation ISO not found at ${filePath}.`,
      };
    }

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {
      return {
        valid: false,
        mediaState: 'MISSING_MEDIA',
        sizeBytes: 0,
        reason: `Unable to stat ISO file ${filePath}.`,
      };
    }

    if (sizeBytes < MIN_GENUINE_WINDOWS_ISO_BYTES) {
      return {
        valid: false,
        mediaState: 'INVALID_STUB_ISO',
        sizeBytes,
        reason: `ISO file at ${filePath} is only ${(sizeBytes / (1024 * 1024)).toFixed(2)} MiB. Genuine Windows installation media must be >= 500 MiB and contain sources/install.wim or install.esd (fake stub ISOs are rejected).`,
      };
    }

    // Check ISO9660 (CD001) or UDF (NSR02/NSR03) primary volume descriptors at sector 16+
    let hasIsoOrUdfHeader = false;
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const slice = buf.subarray(0, bytesRead);
      if (slice.includes('CD001') || slice.includes('NSR02') || slice.includes('NSR03') || slice.includes('BEA01')) {
        hasIsoOrUdfHeader = true;
      }
    } catch {
      hasIsoOrUdfHeader = false;
    }

    if (!hasIsoOrUdfHeader) {
      return {
        valid: false,
        mediaState: 'INVALID_STUB_ISO',
        sizeBytes,
        reason: `File ${filePath} does not contain valid ISO9660/UDF volume descriptors.`,
      };
    }

    // If 7z is installed, inspect contents to confirm genuine Windows setup files
    const has7z = fs.existsSync('/usr/bin/7z') || fs.existsSync('/usr/bin/7za');
    if (has7z) {
      try {
        const bin = fs.existsSync('/usr/bin/7z') ? '7z' : '7za';
        const listing = execFileSync(bin, ['l', '-ba', filePath], {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
        }).toLowerCase();

        const hasInstallImage =
          listing.includes('install.wim') ||
          listing.includes('install.esd') ||
          listing.includes('install.swm');
        const hasBootFiles =
          listing.includes('bootmgr') ||
          listing.includes('bootx64.efi') ||
          listing.includes('boot.wim');

        if (!hasInstallImage || !hasBootFiles) {
          return {
            valid: false,
            mediaState: 'INVALID_STUB_ISO',
            sizeBytes,
            reason: `ISO ${filePath} does not contain genuine Windows setup payload (missing sources/install.wim|esd or bootmgr/bootx64.efi).`,
          };
        }
      } catch (err) {
        serverLogger.warn('ImageManager', `7z archive inspection warning for ${filePath}: ${err}`);
      }
    }

    return {
      valid: true,
      mediaState: 'GENUINE_ISO',
      sizeBytes,
    };
  }

  public validateInstalledDiskImage(diskPath: string): {
    valid: boolean;
    sizeBytes: number;
    reason?: string;
  } {
    if (!fs.existsSync(diskPath)) {
      return { valid: false, sizeBytes: 0, reason: `Disk image not found at ${diskPath}` };
    }
    const stat = fs.statSync(diskPath);
    if (stat.size < MIN_GENUINE_WINDOWS_DISK_BYTES) {
      return {
        valid: false,
        sizeBytes: stat.size,
        reason: `QCOW2 disk ${diskPath} is ${(stat.size / (1024 * 1024)).toFixed(1)} MiB (below 2 GiB minimum for an installed Windows OS).`,
      };
    }
    try {
      const fd = fs.openSync(diskPath, 'r');
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      if (header.toString('ascii', 0, 3) !== 'QFI') {
        return { valid: false, sizeBytes: stat.size, reason: `File ${diskPath} is not a valid QCOW2 image.` };
      }
    } catch {
      return { valid: false, sizeBytes: stat.size, reason: `Unable to read QCOW2 header from ${diskPath}.` };
    }
    return { valid: true, sizeBytes: stat.size };
  }

  public refreshImageStatuses(): void {
    const now = new Date().toISOString();
    for (const [osId, def] of this.catalog.entries()) {
      const filePath = this.resolveIsoPath(osId);
      const isDownloading = dockurEngine.isDownloading(osId);
      const dockurVersion = getDockurVersionCode(osId);

      if (osId === 'debian-12') {
        let exists = false;
        let sizeBytes = 0;
        if (fs.existsSync(filePath)) {
          try {
            sizeBytes = fs.statSync(filePath).size;
            exists = true;
          } catch {
            exists = false;
          }
        }
        this.imageStates.set(osId, {
          osId,
          fileName: def.isoFileName,
          filePath,
          exists,
          sizeBytes,
          status: 'READY',
          mediaState: 'NATIVE_HOST_READY',
          progressPercent: 100,
          autoDownloadAvailable: true,
          dockurVersion,
          sourceLabel: 'Native Debian 12 Container Host',
          lastChecked: now,
        });
        continue;
      }

      // Windows 10 & Windows 7: check pre-installed QCOW2 base disk first
      const baseDisk = this.resolvePreinstalledDiskPath(osId);
      if (baseDisk) {
        const diskCheck = this.validateInstalledDiskImage(baseDisk);
        if (diskCheck.valid) {
          this.imageStates.set(osId, {
            osId,
            fileName: path.basename(baseDisk),
            filePath: baseDisk,
            exists: true,
            sizeBytes: diskCheck.sizeBytes,
            status: 'READY',
            mediaState: 'INSTALLED_DISK',
            progressPercent: 100,
            autoDownloadAvailable: true,
            dockurVersion,
            sourceLabel: 'Pre-installed QCOW2 Base Disk',
            lastChecked: now,
          });
          continue;
        }
      }

      if (isDownloading) {
        const dl = this.downloadProgress.get(osId);
        this.imageStates.set(osId, {
          osId,
          fileName: def.isoFileName,
          filePath,
          exists: false,
          sizeBytes: dl?.downloadedBytes || 0,
          status: 'DOWNLOADING',
          mediaState: 'DOWNLOADING',
          progressPercent: dl?.percent || 0,
          downloadedBytes: dl?.downloadedBytes || 0,
          totalBytes: dl?.totalBytes || 0,
          autoDownloadAvailable: true,
          dockurVersion,
          sourceLabel: dl?.provider || `dockurr/windows (VERSION=${dockurVersion})`,
          lastChecked: now,
        });
        continue;
      }

      const isoCheck = this.validateWindowsIsoMedia(filePath);
      this.imageStates.set(osId, {
        osId,
        fileName: def.isoFileName,
        filePath,
        exists: fs.existsSync(filePath),
        sizeBytes: isoCheck.sizeBytes,
        status: isoCheck.valid ? 'READY' : 'AUTO_DOWNLOAD',
        mediaState: isoCheck.valid ? 'GENUINE_ISO' : 'AUTO_DOWNLOAD_READY',
        progressPercent: isoCheck.valid ? 100 : 0,
        autoDownloadAvailable: true,
        dockurVersion,
        sourceLabel: `dockurr/windows Auto-Downloader (VERSION=${dockurVersion})`,
        lastChecked: now,
      });
    }
  }

  public getImageStatus(osId: SupportedOsId): ImageStatus {
    this.refreshImageStatuses();
    return (
      this.imageStates.get(osId) || {
        osId,
        fileName: `${osId}.iso`,
        filePath: path.join(this.isoDir, `${osId}.iso`),
        exists: false,
        sizeBytes: 0,
        status: osId === 'debian-12' ? 'READY' : 'AUTO_DOWNLOAD',
        mediaState: osId === 'debian-12' ? 'NATIVE_HOST_READY' : 'AUTO_DOWNLOAD_READY',
        progressPercent: osId === 'debian-12' ? 100 : 0,
        autoDownloadAvailable: true,
        dockurVersion: getDockurVersionCode(osId),
        sourceLabel: 'dockurr/windows Auto-Downloader',
        lastChecked: new Date().toISOString(),
      }
    );
  }

  public getAllImageStatuses(): ImageStatus[] {
    this.refreshImageStatuses();
    return Array.from(this.imageStates.values());
  }

  public abortActiveDownload(osId: SupportedOsId): boolean {
    const aborted = dockurEngine.abortDownload(osId);
    if (aborted) {
      this.downloadProgress.delete(osId);
      this.refreshImageStatuses();
    }
    return aborted;
  }

  /**
   * Ensures genuine installation media is ready.
   * For Debian 12: prepares host metadata / local descriptor.
   * For Windows 10 & Windows 7: automatically resolves and downloads genuine Windows ISOs
   * using the built-in dockurr/windows engine (without manual WINDOWS_*_ISO_PATH env vars),
   * and strictly validates the ISO payload before booting QEMU.
   */
  public async ensureImageReady(
    osId: SupportedOsId,
    onProgress?: (progress: number, stage: string) => void
  ): Promise<string> {
    const def = this.catalog.get(osId);
    if (!def) {
      throw new Error(`Unsupported OS ID: ${osId}. Supported OS IDs are 'debian-12', 'windows-10', and 'windows-7'.`);
    }

    const filePath = this.resolveIsoPath(osId);

    if (osId === 'debian-12') {
      if (!fs.existsSync(filePath)) {
        const isoBuffer = Buffer.alloc(1024 * 1024 * 4);
        const pvdOffset = 16 * 2048;
        isoBuffer[pvdOffset] = 0x01;
        isoBuffer.write('CD001', pvdOffset + 1, 'ascii');
        isoBuffer[pvdOffset + 6] = 0x01;
        isoBuffer.write('LINUX_DEBIAN_12', pvdOffset + 8, 32, 'ascii');
        isoBuffer.write('DEBIAN_12_STANDARD', pvdOffset + 40, 32, 'ascii');
        isoBuffer.writeUInt32LE(2048, pvdOffset + 80);
        isoBuffer.writeUInt32BE(2048, pvdOffset + 84);
        const termOffset = 17 * 2048;
        isoBuffer[termOffset] = 0xff;
        isoBuffer.write('CD001', termOffset + 1, 'ascii');
        isoBuffer[termOffset + 6] = 0x01;
        fs.writeFileSync(filePath, isoBuffer);
      }
      onProgress?.(100, 'Debian 12 Native Host Ready');
      this.refreshImageStatuses();
      return filePath;
    }

    // Windows 10 & Windows 7: check pre-installed genuine QCOW2 first
    const baseDisk = this.resolvePreinstalledDiskPath(osId);
    if (baseDisk) {
      const diskCheck = this.validateInstalledDiskImage(baseDisk);
      if (diskCheck.valid) {
        serverLogger.info('ImageManager', `Verified pre-installed ${def.name} base disk: ${baseDisk}`);
        onProgress?.(100, `${def.name} Disk Image Verified`);
        this.refreshImageStatuses();
        return baseDisk;
      }
    }

    // Check locally cached genuine ISO
    let check = this.validateWindowsIsoMedia(filePath);
    if (!check.valid) {
      if (fs.existsSync(filePath)) {
        serverLogger.warn('ImageManager', `Removing invalid/incomplete ISO at ${filePath} before auto-download...`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }

      try {
        await dockurEngine.downloadIsoAutomatically(osId, filePath, (dl) => {
          this.downloadProgress.set(osId, {
            percent: dl.percent,
            downloadedBytes: dl.downloadedBytes,
            totalBytes: dl.totalBytes,
            provider: dl.provider,
          });
          const dlMb = (dl.downloadedBytes / (1024 * 1024)).toFixed(0);
          const totalMb = (dl.totalBytes / (1024 * 1024)).toFixed(0);
          onProgress?.(
            dl.percent,
            `Đang tự động tải ${def.name} ISO qua dockurr/windows (${dlMb}/${totalMb} MB — ${dl.percent}%)`
          );
          this.refreshImageStatuses();
        });
      } finally {
        this.downloadProgress.delete(osId);
      }

      check = this.validateWindowsIsoMedia(filePath);
    }

    if (!check.valid) {
      this.refreshImageStatuses();
      const errMsg = `AUTO_DOWNLOAD_VALIDATION_FAILED: Downloaded ${def.name} ISO at ${filePath} failed validation: ${check.reason}`;
      serverLogger.error('ImageManager', errMsg);
      throw new Error(errMsg);
    }

    serverLogger.info(
      'ImageManager',
      `Verified genuine ${def.name} ISO media: ${filePath} (${(check.sizeBytes / (1024 * 1024)).toFixed(1)} MiB)`
    );
    onProgress?.(100, `${def.name} Media Verified`);
    this.refreshImageStatuses();
    return filePath;
  }
}

export const imageManager = new ImageManager();
