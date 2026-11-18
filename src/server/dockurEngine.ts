import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, ChildProcess } from 'node:child_process';
import { serverLogger } from './logger';
import type { SupportedOsId } from './imageManager';

export interface DockurMirrorCandidate {
  id: string;
  provider: string;
  osId: 'windows-10' | 'windows-7';
  edition: string;
  url: string;
  expectedSizeBytes: number;
  sha256?: string;
}

export interface DockurRuntimeInfo {
  dockerInstalled: boolean;
  dockerDaemonRunning: boolean;
  recommendedImage: string;
  mode: 'docker-dockur' | 'native-dockur-mirror-qemu';
}

export interface DockurContainerSpec {
  containerName: string;
  image: string;
  versionTag: string;
  args: string[];
  webPort: number;
  rdpPort: number;
  storageDir: string;
}

export interface DockerfileBuildStatus {
  dockerfilePresent: boolean;
  dockerComposePresent: boolean;
  requiresDevKvm: boolean;
  supportedTargets: string[];
  isoDownloadCommand: string;
  runtimeCommand: string;
}

/**
 * Built-in dockurr/windows (define.sh / mido.sh) mirror catalog.
 * Automatically resolves Windows 10 and Windows 7 installation ISOs
 * without requiring manual WINDOWS_10_ISO_PATH or WINDOWS_7_ISO_PATH env vars.
 */
export const DOCKUR_MIRROR_CATALOG: Record<'windows-10' | 'windows-7', DockurMirrorCandidate[]> = {
  'windows-10': [
    {
      id: 'archive-win10-22h2-business',
      provider: 'dockurr/windows (Archive.org — Win10 Pro/Business 22H2)',
      osId: 'windows-10',
      edition: 'Windows 10 Pro / Business 22H2 (x64)',
      url: 'https://archive.org/download/windows-10-business-editions-version-22h2-updated-oct-2025-en-us/en-us_windows_10_business_editions_version_22h2_updated_oct_2025_x64_dvd_d2eef4b0.iso',
      expectedSizeBytes: 6985445376,
      sha256: '2c23bc8b95a9314f15ebff881dcbea49651f52a96a0327d7aaf523aa66043765',
    },
    {
      id: 'archive-win10-ltsc-2021',
      provider: 'dockurr/windows (Archive.org — Win10 Enterprise LTSC 2021)',
      osId: 'windows-10',
      edition: 'Windows 10 Enterprise LTSC 2021 (x64)',
      url: 'https://archive.org/download/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96_202302/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso',
      expectedSizeBytes: 4899461120,
      sha256: 'c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d',
    },
    {
      id: 'bobpony-win10-22h2',
      provider: 'dockurr/windows (BobPony CDN — Win10 22H2)',
      osId: 'windows-10',
      edition: 'Windows 10 22H2 (x64)',
      url: 'https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso',
      expectedSizeBytes: 5723299840,
      sha256: '316f718f21fc9b386d81dadd62dc60268a1cfd65b184ac6a052875a454c3431b',
    },
  ],
  'windows-7': [
    {
      id: 'filesdog-win7-ult-sp1',
      provider: 'dockurr/windows (Files.dog MSDN — Win7 Ultimate SP1)',
      osId: 'windows-7',
      edition: 'Windows 7 Ultimate SP1 (x64)',
      url: 'https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso',
      expectedSizeBytes: 3320903680,
      sha256: '36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808',
    },
    {
      id: 'archive-win7-ult-sp1',
      provider: 'dockurr/windows (Archive.org — Win7 Ultimate SP1)',
      osId: 'windows-7',
      edition: 'Windows 7 Ultimate SP1 (x64)',
      url: 'https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso',
      expectedSizeBytes: 3320903680,
      sha256: '36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808',
    },
  ],
};

export function getDockurVersionCode(osId: SupportedOsId): string {
  if (osId === 'windows-10') return '10';
  if (osId === 'windows-7') return '7u';
  return 'debian-12';
}

export function detectDockerRuntime(): DockurRuntimeInfo {
  let dockerInstalled = false;
  let dockerDaemonRunning = false;

  try {
    execSync('which docker', { stdio: 'ignore', timeout: 2000 });
    dockerInstalled = true;
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 3000 });
      dockerDaemonRunning = true;
    } catch {
      dockerDaemonRunning = false;
    }
  } catch {
    dockerInstalled = false;
    dockerDaemonRunning = false;
  }

  return {
    dockerInstalled,
    dockerDaemonRunning,
    recommendedImage: 'dockurr/windows:latest',
    mode: dockerDaemonRunning ? 'docker-dockur' : 'native-dockur-mirror-qemu',
  };
}

export function inspectDockerfileSetup(rootDir: string = process.cwd()): DockerfileBuildStatus {
  const dockerfilePresent = fs.existsSync(path.join(rootDir, 'Dockerfile'));
  const dockerComposePresent = fs.existsSync(path.join(rootDir, 'docker-compose.yml'));
  return {
    dockerfilePresent,
    dockerComposePresent,
    requiresDevKvm: false,
    supportedTargets: ['iso-downloader', 'runtime'],
    isoDownloadCommand: 'docker compose --profile iso run --rm iso-downloader windows-10',
    runtimeCommand: 'docker compose up -d --build moon-cloud',
  };
}

export function isMemoryBackedOverlayfs(): boolean {
  try {
    if (!fs.existsSync('/proc/mounts')) return false;
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    // Cloud Run / gVisor mounts root '/' on in-memory overlayfs (`none / overlay ...`)
    return /^none\s+\/\s+overlay\b/m.test(mounts);
  } catch {
    return false;
  }
}

export function getContainerMemAvailableBytes(): number {
  try {
    if (fs.existsSync('/proc/meminfo')) {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const availMatch = info.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (availMatch) {
        return Number(availMatch[1]) * 1024;
      }
      const freeMatch = info.match(/^MemFree:\s+(\d+)\s+kB/m);
      if (freeMatch) {
        return Number(freeMatch[1]) * 1024;
      }
    }
  } catch {
    // ignore
  }
  return os.freemem();
}

export function getAvailableDiskBytes(targetDir: string): number {
  let statfsBytes = 0;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const stat = fs.statfsSync(targetDir);
    statfsBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    try {
      const dfOut = execSync(`df -B1 "${targetDir}" | tail -n 1`, { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/);
      const avail = Number(dfOut[3]);
      statfsBytes = Number.isFinite(avail) ? avail : 0;
    } catch {
      statfsBytes = 0;
    }
  }

  // On Cloud Run gVisor RAM-backed overlayfs, every file written to / consumes container RAM.
  if (isMemoryBackedOverlayfs()) {
    const memAvail = getContainerMemAvailableBytes();
    if (memAvail > 0 && (statfsBytes === 0 || memAvail < statfsBytes)) {
      return memAvail;
    }
  }
  return statfsBytes;
}

/**
 * Selects candidate mirrors ordered by compatibility with current free disk space
 * so smaller genuine ISOs (e.g. Win10 LTSC 4.56 GiB) are preferred automatically when
 * free space is tighter, avoiding mid-download ENOSPC failures.
 */
export function getOrderedMirrorsForOs(
  osId: 'windows-10' | 'windows-7',
  availableBytes?: number
): DockurMirrorCandidate[] {
  const list = [...DOCKUR_MIRROR_CATALOG[osId]];
  if (typeof availableBytes === 'number' && availableBytes > 0 && availableBytes < 14 * 1024 * 1024 * 1024) {
    return list.sort((a, b) => a.expectedSizeBytes - b.expectedSizeBytes);
  }
  return list;
}

export function buildDockurContainerSpec(options: {
  vmId: string;
  osId: 'windows-10' | 'windows-7';
  cores: number;
  memoryMb: number;
  diskGb: number;
  username: string;
  password: string;
  rdpPort: number;
  webPort: number;
  storageDir?: string;
}): DockurContainerSpec {
  const versionTag = getDockurVersionCode(options.osId);
  const containerName = `moon-${options.vmId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const storageDir = options.storageDir || path.resolve(process.cwd(), 'data', 'dockur', options.vmId);
  const ramGb = Math.max(2, Math.round(options.memoryMb / 1024));
  const hasKvm = fs.existsSync('/dev/kvm');
  const hasTun = fs.existsSync('/dev/net/tun');

  const args: string[] = [
    'run',
    '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '-e', `VERSION=${versionTag}`,
    '-e', `RAM_SIZE=${ramGb}G`,
    '-e', `CPU_CORES=${options.cores}`,
    '-e', `DISK_SIZE=${options.diskGb}G`,
    '-e', `USERNAME=${options.username}`,
    '-e', `PASSWORD=${options.password}`,
    '-p', `${options.webPort}:8006`,
    '-p', `${options.rdpPort}:3389/tcp`,
    '-p', `${options.rdpPort}:3389/udp`,
    '-v', `${storageDir}:/storage`,
    '--cap-add', 'NET_ADMIN',
    '--stop-timeout', '120',
  ];

  if (hasKvm) {
    args.push('--device', '/dev/kvm');
  } else {
    args.push('-e', 'KVM=N');
  }
  if (hasTun) {
    args.push('--device', '/dev/net/tun');
  }
  args.push('dockurr/windows:latest');

  return {
    containerName,
    image: 'dockurr/windows:latest',
    versionTag,
    args,
    webPort: options.webPort,
    rdpPort: options.rdpPort,
    storageDir,
  };
}

export class DockurEngine {
  private activeDownloads: Map<SupportedOsId, { process: ChildProcess; tmpPath: string; aborted: boolean }> = new Map();

  public getRuntimeInfo(): DockurRuntimeInfo {
    return detectDockerRuntime();
  }

  public getDockerfileSetup(): DockerfileBuildStatus {
    return inspectDockerfileSetup();
  }

  public isDownloading(osId: SupportedOsId): boolean {
    return this.activeDownloads.has(osId);
  }

  public abortDownload(osId: SupportedOsId): boolean {
    const active = this.activeDownloads.get(osId);
    if (!active) return false;
    active.aborted = true;
    try {
      active.process.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (fs.existsSync(active.tmpPath)) {
      try {
        fs.unlinkSync(active.tmpPath);
      } catch {
        // ignore
      }
    }
    this.activeDownloads.delete(osId);
    return true;
  }

  /**
   * Probes dockurr/windows mirrors via HTTP HEAD and returns the first reachable ISO URL.
   */
  public async resolveWorkingIsoMirror(
    osId: 'windows-10' | 'windows-7',
    isoDir: string
  ): Promise<{ mirror: DockurMirrorCandidate; availableBytes: number }> {
    const availableBytes = getAvailableDiskBytes(isoDir);
    const ordered = getOrderedMirrorsForOs(osId, availableBytes);

    for (const candidate of ordered) {
      const ok = await this.probeMirrorHead(candidate.url);
      if (ok) {
        return { mirror: candidate, availableBytes };
      }
    }

    return { mirror: ordered[0], availableBytes };
  }

  private async probeMirrorHead(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const contentLen = Number(res.headers.get('content-length') || '0');
      if (!res.ok) return false;
      if (contentType.includes('text/html')) return false;
      if (contentLen > 0 && contentLen < 500 * 1024 * 1024) return false;
      return true;
    } catch {
      return false;
    }
  }

  private cleanCurlStderr(raw: string): string {
    const lines = raw
      .split(/\r|\n/)
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !/^\d+\s+[\d.]+[kMG]?\s+\d+/.test(l));
    return lines.slice(-3).join(' | ').slice(0, 400);
  }

  /**
   * Non-blocking async streaming ISO download via curl (mirrors dockurr/windows mido/define behavior)
   * with HTTP Range resume (-C -), transient reset retries, mirror fallback, and disk-space pre-validation.
   */
  public async downloadIsoAutomatically(
    osId: 'windows-10' | 'windows-7',
    destPath: string,
    onProgress?: (info: {
      percent: number;
      downloadedBytes: number;
      totalBytes: number;
      provider: string;
      edition: string;
    }) => void
  ): Promise<DockurMirrorCandidate> {
    const isoDir = path.dirname(destPath);
    fs.mkdirSync(isoDir, { recursive: true });

    const { mirror: primaryMirror, availableBytes } = await this.resolveWorkingIsoMirror(osId, isoDir);
    const orderedMirrors = [
      primaryMirror,
      ...getOrderedMirrorsForOs(osId, availableBytes).filter((m) => m.id !== primaryMirror.id),
    ];

    const requiredMarginBytes = 256 * 1024 * 1024;
    const tmpPath = `${destPath}.downloading`;
    const transientExitCodes = new Set([7, 18, 28, 52, 56, 92]);
    const errors: string[] = [];

    for (const mirror of orderedMirrors) {
      if (availableBytes > 0 && availableBytes < mirror.expectedSizeBytes + requiredMarginBytes) {
        const availGib = (availableBytes / (1024 * 1024 * 1024)).toFixed(2);
        const needGib = ((mirror.expectedSizeBytes + requiredMarginBytes) / (1024 * 1024 * 1024)).toFixed(2);
        errors.push(`${mirror.provider}: need ${needGib} GiB, ${availGib} GiB free`);
        continue;
      }

      const maxResumeAttempts = 4;
      let mirrorAborted = false;

      for (let attempt = 1; attempt <= maxResumeAttempts; attempt++) {
        const resumingBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
        serverLogger.info(
          'DockurEngine',
          attempt === 1
            ? `Auto-downloading ${mirror.edition} via ${mirror.provider} -> ${destPath}`
            : `Resuming ${mirror.edition} from ${(resumingBytes / (1024 * 1024)).toFixed(1)} MiB (attempt ${attempt}/${maxResumeAttempts}) via ${mirror.provider}`
        );

        try {
          await new Promise<void>((resolve, reject) => {
            const curlArgs = [
              '-fL',
              '-sS',
              '-C', '-',
              '--connect-timeout', '15',
              '--speed-time', '45',
              '--speed-limit', '1024',
              '--retry', '2',
              '--retry-delay', '3',
              '-A', 'Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0',
              '-o', tmpPath,
              mirror.url,
            ];

            const proc = spawn('curl', curlArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
            const state = { process: proc, tmpPath, aborted: false };
            this.activeDownloads.set(osId, state);

            let stderrTail = '';
            proc.stderr?.on('data', (chunk) => {
              stderrTail = `${stderrTail}${chunk.toString()}`.slice(-1500);
            });

            const pollTimer = setInterval(() => {
              try {
                if (fs.existsSync(tmpPath)) {
                  const downloadedBytes = fs.statSync(tmpPath).size;
                  const totalBytes = mirror.expectedSizeBytes;
                  const percent = totalBytes > 0
                    ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 1000) / 10)
                    : 0;
                  onProgress?.({
                    percent,
                    downloadedBytes,
                    totalBytes,
                    provider: mirror.provider,
                    edition: mirror.edition,
                  });
                }
              } catch {
                // ignore
              }
            }, 1000);

            proc.on('error', (err) => {
              clearInterval(pollTimer);
              this.activeDownloads.delete(osId);
              reject(Object.assign(new Error(`curl spawn failed: ${err.message}`), { code: -1, aborted: false }));
            });

            proc.on('close', (code) => {
              clearInterval(pollTimer);
              this.activeDownloads.delete(osId);
              if (state.aborted) {
                reject(Object.assign(new Error(`Auto-download of ${osId} ISO was cancelled.`), { code: -2, aborted: true }));
                return;
              }
              if (code !== 0) {
                const cleanErr = this.cleanCurlStderr(stderrTail) || `curl exit code ${code}`;
                reject(Object.assign(new Error(`Auto-download from ${mirror.provider} exited with code ${code}: ${cleanErr}`), { code, aborted: false }));
                return;
              }
              try {
                fs.renameSync(tmpPath, destPath);
                onProgress?.({
                  percent: 100,
                  downloadedBytes: mirror.expectedSizeBytes,
                  totalBytes: mirror.expectedSizeBytes,
                  provider: mirror.provider,
                  edition: mirror.edition,
                });
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          });

          return mirror;
        } catch (err: unknown) {
          const e = err as Error & { code?: number; aborted?: boolean };
          if (e.aborted) {
            mirrorAborted = true;
            throw e;
          }
          const errCode = typeof e.code === 'number' ? e.code : -1;
          const canResume = transientExitCodes.has(errCode) && attempt < maxResumeAttempts;
          if (canResume) {
            serverLogger.warn(
              'DockurEngine',
              `Transient download interruption (code ${errCode}) on ${mirror.provider}; resuming in 2s...`
            );
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          errors.push(e.message);
          break;
        }
      }

      if (!mirrorAborted && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    }

    if (errors.every((e) => e.includes('GiB free'))) {
      throw new Error(`INSUFFICIENT_DISK_SPACE: ${errors[0]}`);
    }
    throw new Error(errors[errors.length - 1] || `Auto-download of ${osId} failed across all dockurr/windows mirrors.`);
  }

  /**
   * Launches a real dockurr/windows Docker container when Docker daemon is available on host.
   */
  public launchDockerContainer(spec: DockurContainerSpec): string {
    fs.mkdirSync(spec.storageDir, { recursive: true });
    try {
      execSync(`docker rm -f "${spec.containerName}" 2>/dev/null || true`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
    serverLogger.info('DockurEngine', `Starting dockurr/windows container ${spec.containerName} (VERSION=${spec.versionTag})...`);
    const out = execSync(`docker ${spec.args.map((a) => `"${a}"`).join(' ')}`, { encoding: 'utf8', timeout: 60000 }).trim();
    return out;
  }
}

export const dockurEngine = new DockurEngine();
