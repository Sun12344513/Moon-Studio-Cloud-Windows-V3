import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { serverLogger } from './logger';
import { imageManager, SupportedOsId } from './imageManager';
import { dockurEngine } from './dockurEngine';

export interface OsCapabilityAssessment {
  osId: SupportedOsId;
  supported: boolean;
  ready: boolean;
  mode: 'native_container' | 'qemu_kvm' | 'qemu_tcg' | 'external_hypervisor' | 'blocked';
  reason: string;
}

export interface HostInfrastructureReport {
  timestamp: string;
  host: {
    os: string;
    kernel: string;
    hostname: string;
    uptimeSeconds: number;
  };
  cpu: {
    model: string;
    cores: number;
    hasHardwareVirtFlags: boolean; // svm / vmx flags in cpuinfo
    virtType: string;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    totalFormatted: string;
    availableFormatted: string;
  };
  storage: {
    totalFormatted: string;
    availableFormatted: string;
  };
  virtualization: {
    qemuInstalled: boolean;
    qemuVersion: string;
    qemuPath: string;
    qemuImgInstalled: boolean;
    ovmfInstalled: boolean;
    ovmfCodePath: string | null;
    ovmfVarsPath: string | null;
    swtpmInstalled: boolean;
    genisoimageInstalled: boolean;
    p7zipInstalled: boolean;
    kvmAvailable: boolean;
    devKvmExists: boolean;
    devKvmAccessible: boolean;
    nestedVirtSupported: boolean;
    accelerationMode: 'kvm' | 'tcg' | 'none';
    dockerAvailable: boolean;
    dockerfileReady: boolean;
    requiresDevKvmForIso: boolean;
    dockurAutoIsoEnabled: boolean;
    externalHypervisorUrl: string | null;
  };
  networking: {
    interfaces: string[];
    tunTapAvailable: boolean;
    bridgeCapable: boolean;
    iptablesAvailable: boolean;
    publicIpv4: string;
    ingressType: 'direct_tcp' | 'cloud_run_http_proxy' | 'natted';
  };
  osCapabilities: Record<SupportedOsId, OsCapabilityAssessment>;
  assessment: {
    readyForFullEmulation: boolean;
    readyForKvmHardwareAcc: boolean;
    summary: string;
    bottlenecks: string[];
    remediation: string[];
  };
}

export function resolveOvmfPaths(): { codePath: string | null; varsPath: string | null } {
  const candidates: Array<{ code: string; vars: string }> = [
    { code: '/usr/share/OVMF/OVMF_CODE_4M.fd', vars: '/usr/share/OVMF/OVMF_VARS_4M.fd' },
    { code: '/usr/share/OVMF/OVMF_CODE.fd', vars: '/usr/share/OVMF/OVMF_VARS.fd' },
    { code: '/usr/share/ovmf/OVMF.fd', vars: '/usr/share/ovmf/OVMF.fd' },
  ];
  for (const item of candidates) {
    if (fs.existsSync(item.code) && fs.existsSync(item.vars)) {
      return { codePath: item.code, varsPath: item.vars };
    }
  }
  return { codePath: null, varsPath: null };
}

export function probeHostInfrastructure(): HostInfrastructureReport {
  const timestamp = new Date().toISOString();
  serverLogger.info('HostInspector', 'Initiating thorough host infrastructure probe...');

  // 1. Host OS & Kernel
  let kernel = os.release();
  let osDesc = os.type();
  try {
    if (fs.existsSync('/etc/os-release')) {
      const releaseContent = fs.readFileSync('/etc/os-release', 'utf8');
      const match = releaseContent.match(/PRETTY_NAME="([^"]+)"/);
      if (match) osDesc = match[1];
    }
  } catch {
    // ignore
  }

  // 2. CPU
  const cpus = os.cpus();
  const cores = cpus.length;
  const cpuModel = cpus[0]?.model || 'AMD/Intel x86_64';
  let hasHardwareVirtFlags = false;
  let virtType = 'None';
  try {
    if (fs.existsSync('/proc/cpuinfo')) {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      if (cpuinfo.includes('svm')) {
        hasHardwareVirtFlags = true;
        virtType = 'AMD-V (SVM)';
      } else if (cpuinfo.includes('vmx')) {
        hasHardwareVirtFlags = true;
        virtType = 'Intel VT-x (VMX)';
      }
    }
  } catch {
    // ignore
  }

  // 3. Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const totalFormatted = (totalMem / 1024 / 1024 / 1024).toFixed(1) + ' GiB';
  const availableFormatted = (freeMem / 1024 / 1024 / 1024).toFixed(1) + ' GiB';

  // 4. Storage
  let storageTotal = 'Unknown';
  let storageAvail = 'Unknown';
  try {
    const dfOut = execSync('df -h / | tail -n 1', { encoding: 'utf8' }).trim().split(/\s+/);
    if (dfOut.length >= 4) {
      storageTotal = dfOut[1];
      storageAvail = dfOut[3];
    }
  } catch {
    // ignore
  }

  // 5. Virtualization, QEMU, UEFI/OVMF & TPM
  let qemuInstalled = false;
  let qemuVersion = 'Not installed';
  let qemuPath = '';
  try {
    const whichQemu = execSync('which qemu-system-x86_64', { encoding: 'utf8' }).trim();
    if (whichQemu) {
      qemuInstalled = true;
      qemuPath = whichQemu;
      const verOut = execSync(`${whichQemu} --version`, { encoding: 'utf8' });
      const verMatch = verOut.match(/version ([0-9.]+)/);
      qemuVersion = verMatch ? verMatch[1] : '7.2+';
    }
  } catch {
    // ignore
  }

  const qemuImgInstalled = fs.existsSync('/usr/bin/qemu-img');
  const ovmf = resolveOvmfPaths();
  const ovmfInstalled = Boolean(ovmf.codePath && ovmf.varsPath);
  const swtpmInstalled = fs.existsSync('/usr/bin/swtpm');
  const genisoimageInstalled = fs.existsSync('/usr/bin/genisoimage') || fs.existsSync('/usr/bin/mkisofs');
  const p7zipInstalled = fs.existsSync('/usr/bin/7z') || fs.existsSync('/usr/bin/7za');
  const externalHypervisorUrl = process.env.EXTERNAL_HYPERVISOR_URL?.trim() || null;

  const devKvmExists = fs.existsSync('/dev/kvm');
  let devKvmAccessible = false;
  if (devKvmExists) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      devKvmAccessible = true;
    } catch {
      devKvmAccessible = false;
    }
  }

  const kvmAvailable = devKvmExists && devKvmAccessible;
  const accelerationMode: 'kvm' | 'tcg' | 'none' = kvmAvailable
    ? 'kvm'
    : qemuInstalled
    ? 'tcg'
    : 'none';

  // 6. Networking
  const networkIfaces = os.networkInterfaces();
  const interfaces = Object.keys(networkIfaces);
  const tunTapAvailable = fs.existsSync('/dev/net/tun');
  const bridgeCapable = false;
  let iptablesAvailable = false;
  try {
    execSync('which iptables', { stdio: 'ignore' });
    iptablesAvailable = true;
  } catch {
    iptablesAvailable = false;
  }

  let publicIpv4 = 'Unknown';
  try {
    const curlOut = execSync('curl -s4 --connect-timeout 2 ifconfig.me || curl -s4 --connect-timeout 2 api.ipify.org', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (curlOut && !curlOut.startsWith('169.254.') && /^[0-9.]+$/.test(curlOut)) {
      publicIpv4 = curlOut;
    }
  } catch {
    // fallback
  }

  const isGvisor = kernel.includes('gvisor');
  const ingressType = isGvisor ? 'cloud_run_http_proxy' : 'direct_tcp';

  // 7. OS-level capabilities
  const win10Media = imageManager.getImageStatus('windows-10');
  const win7Media = imageManager.getImageStatus('windows-7');
  const dockerRuntime = dockurEngine.getRuntimeInfo();

  const win10MediaReadyOrAuto = win10Media.status === 'READY' || win10Media.autoDownloadAvailable;
  const win7MediaReadyOrAuto = win7Media.status === 'READY' || win7Media.autoDownloadAvailable;

  const win10Ready =
    Boolean(externalHypervisorUrl) ||
    dockerRuntime.dockerDaemonRunning ||
    (qemuInstalled && ovmfInstalled && win10MediaReadyOrAuto);
  const win7Ready =
    Boolean(externalHypervisorUrl) ||
    dockerRuntime.dockerDaemonRunning ||
    (qemuInstalled && win7MediaReadyOrAuto);

  const osCapabilities: Record<SupportedOsId, OsCapabilityAssessment> = {
    'debian-12': {
      osId: 'debian-12',
      supported: true,
      ready: true,
      mode: 'native_container',
      reason: 'Operational via native Debian 12 container host with XFCE4 + xrdp + Cloud Web Terminal.',
    },
    'windows-10': {
      osId: 'windows-10',
      supported: true,
      ready: win10Ready,
      mode: externalHypervisorUrl
        ? 'external_hypervisor'
        : !qemuInstalled && !dockerRuntime.dockerDaemonRunning
        ? 'blocked'
        : kvmAvailable
        ? 'qemu_kvm'
        : 'qemu_tcg',
      reason: externalHypervisorUrl
        ? `External KVM hypervisor configured (${externalHypervisorUrl}).`
        : win10Media.status === 'READY'
        ? kvmAvailable
          ? 'Ready on QEMU/KVM with OVMF UEFI + TPM 2.0.'
          : 'Media cached; QEMU TCG software emulation active (/dev/kvm unavailable).'
        : `Ready via dockurr/windows auto-ISO downloader (${win10Media.dockurVersion}); ${kvmAvailable ? 'KVM enabled' : 'QEMU TCG mode without /dev/kvm'}.`,
    },
    'windows-7': {
      osId: 'windows-7',
      supported: true,
      ready: win7Ready,
      mode: externalHypervisorUrl
        ? 'external_hypervisor'
        : !qemuInstalled && !dockerRuntime.dockerDaemonRunning
        ? 'blocked'
        : kvmAvailable
        ? 'qemu_kvm'
        : 'qemu_tcg',
      reason: externalHypervisorUrl
        ? `External KVM hypervisor configured (${externalHypervisorUrl}).`
        : win7Media.status === 'READY'
        ? kvmAvailable
          ? 'Ready on QEMU/KVM (Legacy i440FX SeaBIOS).'
          : 'Media cached; QEMU TCG software emulation active (/dev/kvm unavailable).'
        : `Ready via dockurr/windows auto-ISO downloader (${win7Media.dockurVersion}); ${kvmAvailable ? 'KVM enabled' : 'QEMU TCG mode without /dev/kvm'}.`,
    },
  };

  // 8. Assessment
  const bottlenecks: string[] = [];
  const remediation: string[] = [];

  const dockerfileSetup = dockurEngine.getDockerfileSetup();

  if (!devKvmExists) {
    bottlenecks.push('/dev/kvm device is not present in container kernel (using Dockerfile KVM=N / QEMU TCG mode).');
    remediation.push('Use the included Dockerfile (target: iso-downloader / runtime with KVM=N) or configure EXTERNAL_HYPERVISOR_URL if hardware KVM speed is needed.');
  }

  if (isGvisor) {
    bottlenecks.push('Container environment runs on Cloud Run gVisor with ephemeral filesystem & HTTP ingress; raw TCP 3389 inbound uses bore TCP relay.');
  }

  const readyForFullEmulation = qemuInstalled;
  const readyForKvmHardwareAcc = kvmAvailable;

  const summary = kvmAvailable
    ? 'Hardware acceleration (KVM) is available and functional.'
    : qemuInstalled
    ? `QEMU ${qemuVersion} installed (OVMF=${ovmfInstalled ? 'YES' : 'NO'}, swtpm=${swtpmInstalled ? 'YES' : 'NO'}); local VMs use TCG emulation because /dev/kvm is unavailable.`
    : 'QEMU hypervisor binary missing.';

  const report: HostInfrastructureReport = {
    timestamp,
    host: {
      os: osDesc,
      kernel,
      hostname: os.hostname(),
      uptimeSeconds: os.uptime(),
    },
    cpu: {
      model: cpuModel,
      cores,
      hasHardwareVirtFlags,
      virtType,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      totalFormatted,
      availableFormatted,
    },
    storage: {
      totalFormatted: storageTotal,
      availableFormatted: storageAvail,
    },
    virtualization: {
      qemuInstalled,
      qemuVersion,
      qemuPath,
      qemuImgInstalled,
      ovmfInstalled,
      ovmfCodePath: ovmf.codePath,
      ovmfVarsPath: ovmf.varsPath,
      swtpmInstalled,
      genisoimageInstalled,
      p7zipInstalled,
      kvmAvailable,
      devKvmExists,
      devKvmAccessible,
      nestedVirtSupported: kvmAvailable,
      accelerationMode,
      dockerAvailable: dockerRuntime.dockerDaemonRunning,
      dockerfileReady: dockerfileSetup.dockerfilePresent,
      requiresDevKvmForIso: dockerfileSetup.requiresDevKvm,
      dockurAutoIsoEnabled: true,
      externalHypervisorUrl,
    },
    networking: {
      interfaces,
      tunTapAvailable,
      bridgeCapable,
      iptablesAvailable,
      publicIpv4,
      ingressType,
    },
    osCapabilities,
    assessment: {
      readyForFullEmulation,
      readyForKvmHardwareAcc,
      summary,
      bottlenecks,
      remediation,
    },
  };

  serverLogger.info(
    'HostInspector',
    `Host probe complete: OS=${report.host.os}, Kernel=${report.host.kernel}, Cores=${report.cpu.cores}, RAM=${report.memory.totalFormatted}, KVM=${report.virtualization.kvmAvailable ? 'YES' : 'NO (/dev/kvm missing)'}, QEMU=${report.virtualization.qemuVersion}, OVMF=${ovmfInstalled ? 'YES' : 'NO'}, swtpm=${swtpmInstalled ? 'YES' : 'NO'}`
  );

  return report;
}
