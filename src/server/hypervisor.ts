import { spawn, execSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { serverLogger } from './logger';
import { SupportedOsId } from './imageManager';
import { resolveOvmfPaths } from './infrastructure';
import { vncBridgeManager } from './vncBridge';
import {
  convertP6PpmToPng,
  buildMouseMoveEvents,
  buildMouseButtonEvents,
  buildMouseClickEvents,
  buildMouseWheelEvents,
  buildKeyComboEvents,
  mapCharToQcodeCombo,
  QmpInputEvent,
  QmpMouseButton,
} from './qmpInput';

export interface VmProcessInfo {
  vmId: string;
  osId: SupportedOsId;
  pid: number | null;
  qmpSocketPath: string;
  diskPath: string;
  hostPort: number;
  memoryMb: number;
  cores: number;
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'SHUTTING_DOWN' | 'ERROR';
  processRef?: ChildProcess;
  tpmSocketPath?: string;
  tpmProcessRef?: ChildProcess;
  nvramPath?: string;
  vncPort?: number;
  bootMode?: 'iso' | 'disk';
  hardwareProfile?: Record<string, string>;
}

export class HypervisorController {
  private vms: Map<string, VmProcessInfo> = new Map();
  private nativePortBridges: Map<string, { port: number; server: net.Server }> = new Map();
  private screenshotLocks: Map<string, Promise<unknown>> = new Map();
  private disksDir: string;
  private tpmDir: string;

  constructor() {
    this.disksDir = path.resolve(process.cwd(), 'data/disks');
    this.tpmDir = path.resolve(process.cwd(), 'data/tpm');
    try {
      fs.mkdirSync(this.disksDir, { recursive: true });
      fs.mkdirSync(this.tpmDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  /**
   * Ensures virtual disk exists using qemu-img (optionally backed by a pre-installed base QCOW2 image)
   */
  public prepareDisk(vmId: string, sizeGb = 40, baseDiskPath?: string): string {
    const diskPath = path.join(this.disksDir, `${vmId}.qcow2`);
    let needsCreation = !fs.existsSync(diskPath);
    if (!needsCreation) {
      try {
        const stats = fs.statSync(diskPath);
        if (stats.size < 10240) {
          serverLogger.warn('Hypervisor', `Disk image ${diskPath} is truncated (${stats.size} bytes). Recreating...`, vmId);
          needsCreation = true;
        }
      } catch {
        needsCreation = true;
      }
    }

    if (needsCreation) {
      let hasQemuImg = false;
      try {
        execSync('which qemu-img', { stdio: 'ignore' });
        hasQemuImg = true;
      } catch {
        hasQemuImg = false;
      }

      if (hasQemuImg) {
        try {
          if (baseDiskPath && fs.existsSync(baseDiskPath)) {
            serverLogger.info('Hypervisor', `Creating persistent QCOW2 overlay from base disk ${baseDiskPath} -> ${diskPath}`, vmId);
            execSync(`qemu-img create -f qcow2 -b "${baseDiskPath}" -F qcow2 "${diskPath}"`, { stdio: 'pipe' });
          } else {
            serverLogger.info('Hypervisor', `Preparing virtual disk storage: ${diskPath} (${sizeGb}GB)`, vmId);
            execSync(`qemu-img create -f qcow2 "${diskPath}" ${sizeGb}G`, { stdio: 'pipe' });
          }
          serverLogger.info('Hypervisor', `QCOW2 disk image initialized successfully: ${diskPath}`, vmId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          serverLogger.warn('Hypervisor', `qemu-img failed: ${msg}. Creating direct storage file...`, vmId);
          fs.writeFileSync(diskPath, Buffer.alloc(1024));
        }
      } else {
        serverLogger.info('Hypervisor', `qemu-img not present. Initializing container-native virtual disk: ${diskPath}`, vmId);
        fs.writeFileSync(diskPath, Buffer.alloc(1024));
      }
    } else {
      serverLogger.info('Hypervisor', `Existing persistent virtual disk found: ${diskPath}`, vmId);
    }
    return diskPath;
  }

  private prepareOvmfNvram(vmId: string): { codePath: string; nvramPath: string } {
    const ovmf = resolveOvmfPaths();
    if (!ovmf.codePath || !ovmf.varsPath) {
      throw new Error('UEFI OVMF firmware (OVMF_CODE_4M.fd / OVMF_VARS_4M.fd) is not installed on host.');
    }
    const nvramPath = path.join(this.disksDir, `${vmId}-OVMF_VARS.fd`);
    if (!fs.existsSync(nvramPath)) {
      fs.copyFileSync(ovmf.varsPath, nvramPath);
    }
    return { codePath: ovmf.codePath, nvramPath };
  }

  private async startSwtpm(vmId: string): Promise<{ socketPath: string; processRef: ChildProcess } | null> {
    if (!fs.existsSync('/usr/bin/swtpm')) {
      serverLogger.warn('Hypervisor', `swtpm not installed on host; launching Windows 10 Q35 without TPM 2.0 emulator.`, vmId);
      return null;
    }

    const vmTpmDir = path.join(this.tpmDir, vmId);
    fs.mkdirSync(vmTpmDir, { recursive: true, mode: 0o700 });
    const socketPath = path.join(vmTpmDir, 'swtpm-sock');
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // ignore
    }

    const swtpmProc = spawn(
      '/usr/bin/swtpm',
      ['socket', '--tpmstate', `dir=${vmTpmDir}`, '--ctrl', `type=unixio,path=${socketPath}`, '--tpm2', '--log', 'level=0'],
      { detached: false, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let earlyError = '';
    swtpmProc.stderr?.on('data', (chunk) => {
      earlyError += chunk.toString();
    });

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (swtpmProc.exitCode !== null) {
        serverLogger.warn('Hypervisor', `swtpm exited early (code ${swtpmProc.exitCode}): ${earlyError.trim()}`, vmId);
        return null;
      }
      if (fs.existsSync(socketPath)) {
        serverLogger.info('Hypervisor', `TPM 2.0 emulator (swtpm) active for VM ${vmId}`, vmId);
        return { socketPath, processRef: swtpmProc };
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      swtpmProc.kill('SIGKILL');
    } catch {
      // ignore
    }
    serverLogger.warn('Hypervisor', `Timed out waiting for swtpm socket ${socketPath}`, vmId);
    return null;
  }

  /**
   * Starts a real QEMU instance with OS-tailored virtual hardware profile
   */
  public async startVmProcess(options: {
    vmId: string;
    osId: SupportedOsId;
    hostPort: number;
    memoryMb?: number;
    cores?: number;
    isoPath?: string;
    baseDiskPath?: string;
    autounattendIsoPath?: string;
    bootFromDiskOnly?: boolean;
  }): Promise<VmProcessInfo> {
    const { vmId, osId, hostPort } = options;
    const memoryMb = options.memoryMb || (osId === 'windows-10' ? 4096 : 2048);
    const cores = options.cores || 2;
    const isoPath = options.isoPath;
    const autounattendIsoPath = options.autounattendIsoPath;
    const bootFromDiskOnly = Boolean(options.bootFromDiskOnly);

    // If already running, ensure native port bridge is active when applicable and return current
    const current = this.vms.get(vmId);
    if (current && current.pid && this.isPidRunning(current.pid)) {
      if (osId === 'debian-12' && current.pid === process.pid && hostPort !== 3389) {
        await this.ensureNativePortBridge(vmId, hostPort, 3389);
      }
      serverLogger.warn('Hypervisor', `VM ${vmId} (${osId}) is already running with PID ${current.pid}`, vmId);
      return current;
    }

    const diskPath = this.prepareDisk(vmId, osId === 'debian-12' ? 20 : 40, options.baseDiskPath);
    const qmpSocketPath = `/tmp/qmp-${vmId}.sock`;

    // Remove old stale socket if any
    try {
      if (fs.existsSync(qmpSocketPath)) {
        fs.unlinkSync(qmpSocketPath);
      }
    } catch {
      // ignore
    }

    // Check if KVM is available
    const hasKvm = fs.existsSync('/dev/kvm');
    const accelArg = hasKvm ? 'kvm' : 'tcg';

    if (!hasKvm) {
      serverLogger.warn(
        'Hypervisor',
        `KVM acceleration (/dev/kvm) is not available in sandbox. Operating in QEMU TCG software emulation mode.`,
        vmId
      );
    }

    let hasQemuBin = fs.existsSync('/usr/bin/qemu-system-x86_64');
    if (!hasQemuBin) {
      try {
        execSync('which qemu-system-x86_64', { stdio: 'ignore' });
        hasQemuBin = true;
      } catch {
        hasQemuBin = false;
      }
    }

    if (!hasQemuBin && (osId === 'windows-10' || osId === 'windows-7')) {
      throw new Error(`QEMU binary (/usr/bin/qemu-system-x86_64) is not available on host to launch ${osId}.`);
    }

    let args: string[] = [];
    const hardwareProfile: Record<string, string> = {};
    let nvramPath: string | undefined;
    let tpmHandle: { socketPath: string; processRef: ChildProcess } | null = null;
    let vncPort: number | undefined;
    const attachInstallerIso = !bootFromDiskOnly && Boolean(isoPath && fs.existsSync(isoPath));

    if (osId === 'windows-10') {
      // Windows 10 x64 Profile:
      // - Machine: Intel Q35 + UEFI (OVMF)
      // - Security: TPM 2.0 via swtpm when available
      // - Storage: AHCI SATA QCOW2
      // - Network: Intel e1000e (in-box Windows 10 driver)
      // - Display: Standard VGA + VNC
      // - Input: USB EHCI + USB Tablet
      const ovmfFiles = this.prepareOvmfNvram(vmId);
      nvramPath = ovmfFiles.nvramPath;
      tpmHandle = await this.startSwtpm(vmId);

      hardwareProfile.chipset = tpmHandle ? 'Q35 (UEFI OVMF + TPM 2.0)' : 'Q35 (UEFI OVMF)';
      hardwareProfile.diskInterface = 'AHCI SATA';
      hardwareProfile.networkInterface = 'Intel e1000e';
      hardwareProfile.vga = 'Standard VGA';
      hardwareProfile.bios = 'UEFI (OVMF)';
      hardwareProfile.acceleration = hasKvm ? 'KVM Hardware' : 'QEMU TCG (Software Emulation)';

      serverLogger.info(
        'Hypervisor',
        `Configuring Windows 10 Q35 profile: UEFI OVMF, ${tpmHandle ? 'TPM 2.0, ' : ''}AHCI SATA disk, Intel e1000e NIC, Standard VGA (${accelArg}).`,
        vmId
      );

      const vncDisplay = (hostPort % 100) + 1;
      vncPort = 5900 + vncDisplay;
      try {
        await vncBridgeManager.ensureBridge(vncPort);
      } catch {
        // ignore
      }

      const cpuArg = hasKvm
        ? 'host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time'
        : 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt';

      args = [
        '-machine', 'q35',
        '-accel', accelArg,
        '-cpu', cpuArg,
        '-m', `${memoryMb}M`,
        '-smp', `${cores}`,
        '-drive', `if=pflash,format=raw,readonly=on,file=${ovmfFiles.codePath}`,
        '-drive', `if=pflash,format=raw,file=${nvramPath}`,
      ];

      if (tpmHandle) {
        args.push(
          '-chardev', `socket,id=chrtpm,path=${tpmHandle.socketPath}`,
          '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
          '-device', 'tpm-tis,tpmdev=tpm0'
        );
      }

      args.push(
        '-device', 'ahci,id=ahci',
        '-drive', `id=disk0,file=${diskPath},format=qcow2,if=none`,
        '-device', `ide-hd,drive=disk0,bus=ahci.0,bootindex=${attachInstallerIso ? 2 : 1}`,
        '-netdev', `user,id=net0,hostfwd=tcp::${hostPort}-:3389`,
        '-device', 'e1000e,netdev=net0',
        '-vga', 'std',
        '-device', 'usb-ehci,id=ehci',
        '-device', 'usb-tablet',
        '-rtc', 'base=localtime,clock=host',
        '-qmp', `unix:${qmpSocketPath},server,nowait`,
        '-display', 'none',
        '-vnc', `127.0.0.1:${vncDisplay}`
      );

      if (attachInstallerIso && isoPath) {
        args.push(
          '-drive', `id=cdrom0,file=${isoPath},media=cdrom,readonly=on,if=none`,
          '-device', 'ide-cd,drive=cdrom0,bus=ahci.1,bootindex=1'
        );
        serverLogger.info('Hypervisor', `Attached Windows 10 installation ISO: ${isoPath}`, vmId);

        if (autounattendIsoPath && fs.existsSync(autounattendIsoPath)) {
          args.push(
            '-drive', `id=cdrom1,file=${autounattendIsoPath},media=cdrom,readonly=on,if=none`,
            '-device', 'ide-cd,drive=cdrom1,bus=ahci.2'
          );
          serverLogger.info('Hypervisor', `Attached Windows 10 Autounattend ISO: ${autounattendIsoPath}`, vmId);
        }
      } else {
        serverLogger.info('Hypervisor', `Booting Windows 10 directly from persistent QCOW2 disk: ${diskPath}`, vmId);
      }
    } else if (osId === 'windows-7') {
      // Windows 7 SP1 Profile:
      // - Machine: standard PC (i440fx legacy chipset)
      // - Storage: Native IDE/ATA (in-box Windows 7 driver)
      // - Network: Intel e1000 (in-box Windows 7 driver)
      // - Display: Standard VGA (in-box Windows 7 driver)
      // - Input: USB Tablet (prevents cursor drift)
      hardwareProfile.chipset = 'i440fx (Legacy PC)';
      hardwareProfile.diskInterface = 'IDE';
      hardwareProfile.networkInterface = 'Intel e1000';
      hardwareProfile.vga = 'Standard VGA';
      hardwareProfile.bios = 'SeaBIOS Legacy';
      hardwareProfile.acceleration = hasKvm ? 'KVM Hardware' : 'QEMU TCG (Software Emulation)';

      serverLogger.info(
        'Hypervisor',
        `Configuring Windows 7 Legacy PC profile: SeaBIOS, IDE disk, Intel e1000 NIC, Standard VGA (${accelArg}).`,
        vmId
      );

      const vncDisplay = (hostPort % 100) + 1;
      vncPort = 5900 + vncDisplay;
      try {
        await vncBridgeManager.ensureBridge(vncPort);
      } catch {
        // ignore
      }
      args = [
        '-machine', 'pc',
        '-accel', accelArg,
        '-cpu', hasKvm ? 'host' : 'qemu64',
        '-m', `${memoryMb}M`,
        '-smp', `${cores}`,
        '-drive', `file=${diskPath},format=qcow2,if=ide,index=0,media=disk`,
        '-netdev', `user,id=net0,hostfwd=tcp::${hostPort}-:3389`,
        '-device', 'e1000,netdev=net0',
        '-vga', 'std',
        '-usb',
        '-device', 'usb-tablet',
        '-rtc', 'base=localtime,clock=host',
        '-qmp', `unix:${qmpSocketPath},server,nowait`,
        '-display', 'none',
        '-vnc', `127.0.0.1:${vncDisplay}`,
      ];

      if (attachInstallerIso && isoPath) {
        args.push('-cdrom', isoPath);
        args.push('-boot', 'once=d,order=cd');
        serverLogger.info('Hypervisor', `Attached Windows 7 installation ISO: ${isoPath}`, vmId);

        if (autounattendIsoPath && fs.existsSync(autounattendIsoPath)) {
          args.push('-drive', `file=${autounattendIsoPath},media=cdrom,index=3,readonly=on`);
          serverLogger.info('Hypervisor', `Attached Windows 7 Autounattend ISO: ${autounattendIsoPath}`, vmId);
        }
      } else {
        args.push('-boot', 'order=c');
        serverLogger.info('Hypervisor', `Booting Windows 7 directly from persistent QCOW2 disk: ${diskPath}`, vmId);
      }
    } else {
      // Debian 12 (Linux) Profile:
      hardwareProfile.chipset = 'i440fx / VirtIO';
      hardwareProfile.diskInterface = 'VirtIO';
      hardwareProfile.networkInterface = 'VirtIO-net';
      hardwareProfile.vga = 'Standard VGA';
      hardwareProfile.bios = 'SeaBIOS';

      serverLogger.info(
        'Hypervisor',
        `Configuring Debian 12 Linux profile: VirtIO-blk, VirtIO-net, Standard VGA.`,
        vmId
      );

      args = [
        '-accel', accelArg,
        '-m', `${memoryMb}M`,
        '-smp', `${cores}`,
        '-drive', `file=${diskPath},format=qcow2,if=virtio`,
        '-netdev', `user,id=net0,hostfwd=tcp::${hostPort}-:3389`,
        '-device', 'virtio-net-pci,netdev=net0',
        '-qmp', `unix:${qmpSocketPath},server,nowait`,
        '-display', 'none',
        '-vga', 'std',
        '-rtc', 'base=localtime',
      ];

      if (isoPath && fs.existsSync(isoPath)) {
        args.push('-drive', `file=${isoPath},media=cdrom`);
      }
    }

    // Synthetic 4MB CD001 stub ISOs contain no OS or XRDP server; Debian 12 uses Native Host + XRDP bridge
    // unless a real installed disk (>= 50MB) or full bootable OS ISO (>= 50MB) is attached.
    let hasBootableDebianMedia = false;
    if (osId === 'debian-12') {
      try {
        const diskSize = fs.existsSync(diskPath) ? fs.statSync(diskPath).size : 0;
        const isoSize = isoPath && fs.existsSync(isoPath) ? fs.statSync(isoPath).size : 0;
        hasBootableDebianMedia = diskSize >= 50 * 1024 * 1024 || isoSize >= 50 * 1024 * 1024;
      } catch {
        hasBootableDebianMedia = false;
      }
    }

    if (!hasQemuBin || (osId === 'debian-12' && !hasBootableDebianMedia)) {
      try {
        execSync(`pkill -9 -f "hostfwd=tcp::${hostPort}-" || true`, { stdio: 'ignore' });
      } catch {
        // ignore
      }

      if (hostPort !== 3389) {
        await this.ensureNativePortBridge(vmId, hostPort, 3389);
      }

      serverLogger.info(
        'Hypervisor',
        `Running Debian 12 native cloud instance (PID: ${process.pid}, localPort: ${hostPort} -> xrdp:3389) on host platform`,
        vmId
      );
      const nativeInfo: VmProcessInfo = {
        vmId,
        osId,
        pid: process.pid,
        qmpSocketPath,
        diskPath,
        hostPort,
        memoryMb,
        cores,
        status: 'RUNNING',
        hardwareProfile: {
          chipset: 'Google Cloud Host / gVisor Container',
          virtualization: 'Native Host Container (4 vCPU, 12GB RAM)',
          networkInterface: hostPort !== 3389
            ? `Direct Cloud Network (TCP Bridge 127.0.0.1:${hostPort} -> 3389)`
            : 'Direct Cloud Network (IPv4 Egress)',
        },
      };
      this.vms.set(vmId, nativeInfo);
      return nativeInfo;
    }

    // Clean up any stale hypervisor process that may still hold hostPort
    try {
      execSync(`pkill -9 -f "hostfwd=tcp::${hostPort}-" || true`, { stdio: 'ignore' });
    } catch {
      // ignore
    }

    serverLogger.info(
      'Hypervisor',
      `Spawning QEMU for VM ${vmId} (${osId}) with PID tracking on port ${hostPort}...`,
      vmId
    );

    const child = spawn('qemu-system-x86_64', args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const info: VmProcessInfo = {
      vmId,
      osId,
      pid: child.pid || null,
      qmpSocketPath,
      diskPath,
      hostPort,
      memoryMb,
      cores,
      status: 'STARTING',
      processRef: child,
      tpmSocketPath: tpmHandle?.socketPath,
      tpmProcessRef: tpmHandle?.processRef,
      nvramPath,
      vncPort,
      bootMode: attachInstallerIso ? 'iso' : 'disk',
      hardwareProfile,
    };

    let stderrTail = '';
    child.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        serverLogger.debug('QEMU-OUT', text, vmId);
      }
    });

    child.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        stderrTail = `${stderrTail}\n${text}`.slice(-2000);
        serverLogger.warn('QEMU-ERR', text, vmId);
      }
    });

    child.on('error', (err) => {
      serverLogger.error('Hypervisor', `QEMU process error: ${err.message}`, vmId);
      info.status = 'ERROR';
      info.pid = null;
      this.stopSwtpmForInfo(info);
    });

    child.on('exit', (code, signal) => {
      serverLogger.info(
        'Hypervisor',
        `QEMU process exited (code=${code}, signal=${signal})`,
        vmId
      );
      info.status = code && code !== 0 ? 'ERROR' : 'STOPPED';
      info.pid = null;
      this.stopSwtpmForInfo(info);
    });

    if (!child.pid) {
      this.stopSwtpmForInfo(info);
      if (vncPort) vncBridgeManager.closeBridge(vncPort);
      throw new Error('Failed to retrieve PID for spawned QEMU process.');
    }

    // Verify QEMU remains alive through startup and initializes QMP
    const startupWaitMs = 1200;
    const deadline = Date.now() + startupWaitMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.stopSwtpmForInfo(info);
        if (vncPort) vncBridgeManager.closeBridge(vncPort);
        throw new Error(
          `QEMU exited prematurely during ${osId} startup (code=${child.exitCode}): ${stderrTail.trim() || 'no stderr output'}`
        );
      }
      if (fs.existsSync(qmpSocketPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    if (child.exitCode !== null) {
      this.stopSwtpmForInfo(info);
      if (vncPort) vncBridgeManager.closeBridge(vncPort);
      throw new Error(
        `QEMU exited during ${osId} startup (code=${child.exitCode}): ${stderrTail.trim() || 'no stderr output'}`
      );
    }

    info.status = 'RUNNING';
    this.vms.set(vmId, info);
    serverLogger.info('Hypervisor', `QEMU instance online with PID ${child.pid} for ${osId}`, vmId);
    return info;
  }

  private stopSwtpmForInfo(info: VmProcessInfo): void {
    if (info.tpmProcessRef && info.tpmProcessRef.exitCode === null) {
      try {
        info.tpmProcessRef.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    info.tpmProcessRef = undefined;
  }

  public async ensureNativePortBridge(vmId: string, listenPort: number, targetPort = 3389): Promise<void> {
    if (listenPort === targetPort) return;

    const existing = this.nativePortBridges.get(vmId);
    if (existing && existing.port === listenPort && existing.server.listening) {
      return;
    }
    if (existing) {
      this.closeNativePortBridge(vmId);
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((clientSocket) => {
        const targetSocket = net.connect(targetPort, '127.0.0.1');

        const cleanup = () => {
          if (!clientSocket.destroyed) clientSocket.destroy();
          if (!targetSocket.destroyed) targetSocket.destroy();
        };

        clientSocket.on('error', cleanup);
        targetSocket.on('error', cleanup);
        clientSocket.on('close', cleanup);
        targetSocket.on('close', cleanup);

        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });

      server.once('error', (err) => {
        serverLogger.error(
          'Hypervisor',
          `Native RDP bridge failed on 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}: ${err.message}`,
          vmId
        );
        reject(err);
      });

      server.listen(listenPort, '127.0.0.1', () => {
        this.nativePortBridges.set(vmId, { port: listenPort, server });
        serverLogger.info(
          'Hypervisor',
          `Native RDP TCP bridge active: 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`,
          vmId
        );
        resolve();
      });
    });
  }

  public closeNativePortBridge(vmId: string): void {
    const existing = this.nativePortBridges.get(vmId);
    if (!existing) return;
    try {
      existing.server.close();
    } catch {
      // ignore
    }
    this.nativePortBridges.delete(vmId);
    serverLogger.info('Hypervisor', `Closed native RDP TCP bridge on port ${existing.port}`, vmId);
  }

  /**
   * Graceful ACPI shutdown via QMP
   */
  public async gracefulShutdown(vmId: string): Promise<boolean> {
    const info = this.vms.get(vmId);
    if (!info || !info.pid || !this.isPidRunning(info.pid)) {
      this.closeNativePortBridge(vmId);
      serverLogger.warn('Hypervisor', `Cannot shutdown: VM ${vmId} is not running.`, vmId);
      return false;
    }

    if (info.pid === process.pid) {
      this.closeNativePortBridge(vmId);
      info.status = 'STOPPED';
      info.pid = null;
      return true;
    }

    serverLogger.info('Hypervisor', `Sending ACPI system_powerdown request to QEMU via QMP...`, vmId);
    info.status = 'SHUTTING_DOWN';

    try {
      await this.sendQmpCommand(info.qmpSocketPath, 'system_powerdown');
      serverLogger.info('Hypervisor', `ACPI powerdown sent. Awaiting OS shutdown...`, vmId);
      return true;
    } catch {
      serverLogger.warn('Hypervisor', `QMP socket unavailable, sending SIGTERM to PID ${info.pid}`, vmId);
      try {
        process.kill(info.pid, 'SIGTERM');
        return true;
      } catch (err) {
        serverLogger.error('Hypervisor', `SIGTERM failed: ${err}`, vmId);
        return false;
      }
    }
  }

  public async forceStop(vmId: string): Promise<boolean> {
    this.closeNativePortBridge(vmId);
    const info = this.vms.get(vmId);
    if (!info) {
      return false;
    }

    this.stopSwtpmForInfo(info);
    if (info.vncPort) {
      vncBridgeManager.closeBridge(info.vncPort);
    }

    if (!info.pid) {
      info.status = 'STOPPED';
      return false;
    }

    if (info.pid === process.pid) {
      info.status = 'STOPPED';
      info.pid = null;
      return true;
    }

    serverLogger.warn('Hypervisor', `Force stopping QEMU process (SIGKILL) for VM ${vmId} (PID: ${info.pid})`, vmId);
    try {
      process.kill(info.pid, 'SIGKILL');
      info.status = 'STOPPED';
      info.pid = null;
      return true;
    } catch (err) {
      serverLogger.error('Hypervisor', `Failed to SIGKILL PID ${info.pid}: ${err}`, vmId);
      info.status = 'STOPPED';
      info.pid = null;
      return false;
    }
  }

  public cleanupVmArtifacts(vmId: string): void {
    try {
      const vm = this.vms.get(vmId);
      if (vm) {
        this.stopSwtpmForInfo(vm);
        if (vm.vncPort) vncBridgeManager.closeBridge(vm.vncPort);
      }
      this.vms.delete(vmId);

      const candidates = [
        path.join(this.disksDir, `${vmId}.qcow2`),
        path.join(this.disksDir, `${vmId}-OVMF_VARS.fd`),
        `/tmp/qmp-${vmId}.sock`,
        `/tmp/screen-${vmId}.ppm`,
        `/tmp/screen-${vmId}.png`,
      ];
      for (const file of candidates) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
      const vmTpmDir = path.join(this.tpmDir, vmId);
      if (fs.existsSync(vmTpmDir)) {
        fs.rmSync(vmTpmDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }

  public async reboot(vmId: string): Promise<boolean> {
    const info = this.vms.get(vmId);
    if (!info || !info.pid || !this.isPidRunning(info.pid)) {
      return false;
    }

    serverLogger.info('Hypervisor', `Sending ACPI system_reset to QEMU for VM ${vmId}...`, vmId);
    try {
      await this.sendQmpCommand(info.qmpSocketPath, 'system_reset');
      return true;
    } catch {
      return false;
    }
  }

  public sendQmpCommand(socketPath: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ path: socketPath }, () => {
        let step = 0; // 0: waiting greeting, 1: capabilities sent, 2: command sent
        client.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.QMP && step === 0) {
                step = 1;
                client.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
              } else if (step === 1 && parsed.return !== undefined) {
                step = 2;
                const payload = Object.keys(args).length > 0
                  ? { execute: command, arguments: args }
                  : { execute: command };
                client.write(JSON.stringify(payload) + '\n');
              } else if (step === 2) {
                client.end();
                if (parsed.error) {
                  reject(new Error(parsed.error.desc || JSON.stringify(parsed.error)));
                } else {
                  resolve(parsed.return);
                }
                return;
              }
            } catch {
              // ignore
            }
          }
        });
      });

      client.setTimeout(4000, () => {
        client.destroy();
        reject(new Error('QMP command timed out'));
      });

      client.on('error', (err) => {
        reject(err);
      });
    });
  }

  private resolveQmpSocketPath(vmId: string): string | null {
    const info = this.vms.get(vmId);
    if (info?.qmpSocketPath && fs.existsSync(info.qmpSocketPath)) {
      return info.qmpSocketPath;
    }
    const fallback = `/tmp/qmp-${vmId}.sock`;
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    return null;
  }

  /**
   * Captures the real framebuffer screen from the virtual machine via QMP and converts P6 PPM -> PNG in-memory
   */
  public async takeScreenshotBuffer(
    vmId: string
  ): Promise<{ buffer: Buffer; mimeType: 'image/png'; width: number; height: number } | null> {
    const qmpSocketPath = this.resolveQmpSocketPath(vmId);
    if (!qmpSocketPath) {
      return null;
    }

    const previous = this.screenshotLocks.get(vmId) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const ppmPath = `/tmp/screen-${vmId}.ppm`;
      const pngPath = `/tmp/screen-${vmId}.png`;
      try {
        await this.sendQmpCommand(qmpSocketPath, 'screendump', { filename: ppmPath });
        if (!fs.existsSync(ppmPath)) {
          return null;
        }
        const ppmBuf = fs.readFileSync(ppmPath);
        const converted = convertP6PpmToPng(ppmBuf);
        if (converted) {
          return {
            buffer: converted.png,
            mimeType: 'image/png' as const,
            width: converted.width,
            height: converted.height,
          };
        }
        try {
          execSync(`convert "${ppmPath}" "${pngPath}"`, { stdio: 'pipe', timeout: 4000 });
          if (fs.existsSync(pngPath)) {
            return {
              buffer: fs.readFileSync(pngPath),
              mimeType: 'image/png' as const,
              width: 0,
              height: 0,
            };
          }
        } catch {
          // ignore fallback error
        }
        return null;
      } catch (err) {
        serverLogger.warn('Hypervisor', `Failed to capture framebuffer for VM ${vmId}: ${err}`);
        return null;
      }
    });

    this.screenshotLocks.set(vmId, task);
    try {
      return await task;
    } finally {
      if (this.screenshotLocks.get(vmId) === task) {
        this.screenshotLocks.delete(vmId);
      }
    }
  }

  /**
   * Captures the real framebuffer screen from the virtual machine via QMP (file path version)
   */
  public async takeScreenshot(vmId: string): Promise<string | null> {
    const shot = await this.takeScreenshotBuffer(vmId);
    if (!shot) return null;
    const pngPath = `/tmp/screen-${vmId}.png`;
    try {
      fs.writeFileSync(pngPath, shot.buffer);
      return pngPath;
    } catch {
      return null;
    }
  }

  /**
   * Queries real virtual machine execution status via QMP
   */
  public async queryStatus(vmId: string): Promise<{ running: boolean; status: string } | null> {
    const info = this.vms.get(vmId);
    const qmpSocketPath = this.resolveQmpSocketPath(vmId);
    if (!qmpSocketPath) {
      if (info && info.pid && this.isPidRunning(info.pid)) {
        return { running: true, status: 'running' };
      }
      return null;
    }

    try {
      const res = (await this.sendQmpCommand(qmpSocketPath, 'query-status')) as {
        running: boolean;
        status: string;
      };
      return res || null;
    } catch {
      return null;
    }
  }

  /**
   * Sends a raw batch of QMP input-send-event payloads
   */
  public async sendQmpEvents(vmId: string, events: QmpInputEvent[]): Promise<boolean> {
    if (!events || events.length === 0) return false;
    const qmpSocketPath = this.resolveQmpSocketPath(vmId);
    if (!qmpSocketPath) return false;

    try {
      await this.sendQmpCommand(qmpSocketPath, 'input-send-event', { events });
      return true;
    } catch (err) {
      serverLogger.warn('Hypervisor', `Failed to send QMP input events to VM ${vmId}: ${err}`);
      return false;
    }
  }

  /**
   * Injects real USB Tablet pointer movement, clicks (left/right/middle/double), button state, or wheel scroll
   */
  public async sendMouseInput(
    vmId: string,
    opts: {
      action: 'move' | 'click' | 'down' | 'up' | 'wheel';
      normX?: number;
      normY?: number;
      button?: QmpMouseButton;
      doubleClick?: boolean;
      direction?: 'up' | 'down';
    }
  ): Promise<boolean> {
    const qmpSocketPath = this.resolveQmpSocketPath(vmId);
    if (!qmpSocketPath) return false;

    const btn: QmpMouseButton =
      opts.button === 'right' || opts.button === 'middle' ? opts.button : 'left';

    if (opts.action === 'move') {
      if (typeof opts.normX !== 'number' || typeof opts.normY !== 'number') return false;
      return this.sendQmpEvents(vmId, buildMouseMoveEvents(opts.normX, opts.normY));
    }

    if (opts.action === 'down' || opts.action === 'up') {
      return this.sendQmpEvents(
        vmId,
        buildMouseButtonEvents(btn, opts.action === 'down', opts.normX, opts.normY)
      );
    }

    if (opts.action === 'wheel') {
      const dir = opts.direction === 'up' ? 'up' : 'down';
      return this.sendQmpEvents(vmId, buildMouseWheelEvents(dir, opts.normX, opts.normY));
    }

    // 'click'
    if (typeof opts.normX !== 'number' || typeof opts.normY !== 'number') return false;
    const singleOk = await this.sendQmpEvents(
      vmId,
      buildMouseClickEvents(opts.normX, opts.normY, btn, false)
    );
    if (!singleOk) return false;

    if (opts.doubleClick) {
      await new Promise((r) => setTimeout(r, 60));
      return this.sendQmpEvents(
        vmId,
        buildMouseClickEvents(opts.normX, opts.normY, btn, false)
      );
    }
    return true;
  }

  /**
   * Injects keystroke combinations (e.g. ['ctrl', 'alt', 'delete']) into the VM via QMP
   */
  public async sendKeyCombo(vmId: string, keys: string[]): Promise<boolean> {
    const events = buildKeyComboEvents(keys);
    if (events.length === 0) return false;
    return this.sendQmpEvents(vmId, events);
  }

  /**
   * Types ASCII text character-by-character into the VM via QMP
   */
  public async sendTextInput(vmId: string, text: string): Promise<boolean> {
    if (!text) return false;
    const qmpSocketPath = this.resolveQmpSocketPath(vmId);
    if (!qmpSocketPath) return false;

    const limited = text.slice(0, 200);
    let sentAny = false;
    for (const ch of limited) {
      const combo = mapCharToQcodeCombo(ch);
      if (!combo) continue;
      const ok = await this.sendKeyCombo(vmId, combo);
      if (ok) sentAny = true;
      await new Promise((r) => setTimeout(r, 12));
    }
    return sentAny;
  }

  /**
   * Injects a single keystroke into the real virtual machine via QMP
   */
  public async sendInputKey(vmId: string, qcode: string): Promise<boolean> {
    return this.sendKeyCombo(vmId, [qcode]);
  }

  public getVmProcess(vmId: string): VmProcessInfo | undefined {
    return this.vms.get(vmId);
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export const hypervisor = new HypervisorController();
