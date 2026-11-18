import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hypervisor } from './hypervisor';
import { networkManager } from './network';
import { rdpHealthChecker, RdpHealthResult } from './rdpHealth';
import { serverLogger } from './logger';
import { probeHostInfrastructure } from './infrastructure';
import { generateWindowsPassword, validateWindowsPassword } from '../utils/credentials';
import { tunnelManager } from './tunnel';
import { rdpServiceManager } from './rdpService';
import { imageManager, isSupportedOsId, SupportedOsId } from './imageManager';
import { getDefaultProvisioningPassword } from './credentialPolicy';
import {
  dockurEngine,
  getAvailableDiskBytes,
  getContainerMemAvailableBytes,
  getOrderedMirrorsForOs,
  isMemoryBackedOverlayfs,
} from './dockurEngine';

export type VmExtendedStatus =
  | 'Queued'
  | 'Preparing'
  | 'Downloading Image'
  | 'Creating Disk'
  | 'Installing'
  | 'Booting'
  | 'Running'
  | 'Ready'
  | 'Stopped'
  | 'Failed';

export interface VmRecord {
  id: string;
  name: string;
  osId: SupportedOsId;
  osName: string;
  version: string;
  imageId: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  username: string;
  password: string;
  localPort: number;
  ipAddress: string;
  publicEndpoint: string;
  hypervisorId: string;
  networkConfig: {
    interfaceType: string;
    localPort: number;
    guestPort: number;
    natForwarding: boolean;
  };
  status: VmExtendedStatus;
  statusMessage?: string;
  securityWarning?: string;
  createdAt: string;
  updatedAt: string;
  lastBootAt?: string;
  rdpHealth?: RdpHealthResult;
  isExternalVerified?: boolean;
  isPolicyManaged?: boolean;
  isApiManaged?: boolean;
  credentialsConfigured?: boolean;
  credentialsConfiguredAt?: string;
  provisioningCompletedAt?: string;
  failureReason?: string;
  installCompleted?: boolean;
  mediaSourceType?: 'iso' | 'installed_disk' | 'native_host';
}

export interface VmProvisioningCallbacks {
  onProvisioned?: (vm: VmRecord, actualPassword: string) => void;
  onProvisionFailed?: (vm: VmRecord, reason: string) => void;
}

export class VmManager {
  private stateFilePath: string;
  private vms: Map<string, VmRecord> = new Map();
  private primaryVmId = 'vm-moon-win-01';
  private vmLocks: Set<string> = new Set();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private provisioningCallbacks: Map<string, VmProvisioningCallbacks> = new Map();
  private runtimePasswords: Map<string, string> = new Map();
  private autoResumeVmIds: Set<string> = new Set();

  constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      // ignore
    }
    this.stateFilePath = path.join(dataDir, 'vm-state.json');
    this.loadState();
  }

  private loadState(): void {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            if (!item.ipAddress || item.ipAddress.includes('...') || item.ipAddress.startsWith('169.254.')) {
              item.ipAddress = '159.223.110.159';
              item.publicEndpoint = item.publicEndpoint || '159.223.110.159:41735';
            }
            if (!item.osId || !isSupportedOsId(item.osId)) {
              item.osId = 'debian-12';
            }
            // Recover primary Debian 12 container host VM cleanly on startup
            if (item.id === this.primaryVmId && item.osId === 'debian-12') {
              if (item.status !== 'Ready') {
                item.status = 'Ready';
                item.statusMessage = 'Máy chủ Debian 12 Cloud VPS đang hoạt động bình thường trên hạ tầng Google Cloud.';
              }
              delete item.failureReason;
            } else if (
              (item.osId === 'windows-10' || item.osId === 'windows-7') &&
              (item.status === 'Ready' ||
                item.status === 'Booting' ||
                item.status === 'Installing' ||
                (item.status === 'Stopped' &&
                  (item.statusMessage === 'Tiến trình QEMU đã dừng sau khi máy chủ khởi động lại.' ||
                   item.statusMessage === 'Đang tự động khởi động lại tiến trình QEMU...')) ||
                (item.status === 'Failed' &&
                  typeof item.failureReason === 'string' &&
                  item.failureReason.includes('QEMU binary')))
            ) {
              // Child QEMU processes do not survive container restarts; mark for automatic resume
              item.isExternalVerified = false;
              this.autoResumeVmIds.add(item.id);
              if (item.status === 'Installing' || item.status === 'Booting' || item.status === 'Failed') {
                item.status = 'Stopped';
                delete item.failureReason;
                item.statusMessage = 'Đang tự động khởi động lại tiến trình QEMU...';
              }
            }
            this.vms.set(item.id, item);
            if (typeof item.localPort === 'number' && item.localPort > 0) {
              networkManager.reservePort(item.localPort, item.id);
            }
            serverLogger.registerSecret(item.password);
          }
        }
      } catch (err) {
        serverLogger.error('VMManager', `Failed to load state: ${err}`);
      }
    }
  }

  private saveState(): void {
    try {
      const array = Array.from(this.vms.values()).map((vm) =>
        vm.isApiManaged || vm.isPolicyManaged
          ? { ...vm, password: '[VAULT_PROTECTED]' }
          : vm
      );
      fs.writeFileSync(this.stateFilePath, JSON.stringify(array, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      serverLogger.error('VMManager', `Failed to save state: ${err}`);
    }
  }

  public async initialize(): Promise<void> {
    serverLogger.info('Server', 'Initializing Moon Studio Cloud VPS hypervisor and guest services...');

    // Probe Host Infrastructure
    probeHostInfrastructure();

    let vm = this.vms.get(this.primaryVmId);
    if (!vm) {
      serverLogger.info('VMManager', `No existing primary VM found. Provisioning default Debian 12 VM...`);
      vm = await this.createVm({
        id: this.primaryVmId,
        name: 'Moon Studio Cloud Linux (Debian 12)',
        osId: 'debian-12',
        cores: 2,
        memoryMb: 2048,
        diskGb: 40,
        username: 'Administrator',
      });
    } else {
      serverLogger.info('VMManager', `Loaded existing VM: ${vm.id} (${vm.osId} - ${vm.status})`);
      if (vm.osId === 'debian-12') {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        const rdpOk = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        if (rdpOk) {
          vm.status = 'Ready';
          delete vm.failureReason;
          vm.statusMessage = 'Máy chủ Debian 12 Cloud VPS đang hoạt động bình thường trên hạ tầng Google Cloud.';
          this.saveState();
        } else {
          vm.status = 'Failed';
          vm.isExternalVerified = false;
          vm.failureReason = 'Debian 12 xrdp service failed X.224 check on port 3389 during startup.';
          vm.statusMessage = `Khởi tạo dịch vụ RDP thất bại: ${vm.failureReason}`;
          this.saveState();
        }
      }
      await tunnelManager.start();

      // Resume secondary Ready VMs and Windows VMs interrupted by server restart cleanly
      for (const item of this.vms.values()) {
        if (item.id !== this.primaryVmId && (item.status === 'Ready' || this.autoResumeVmIds.has(item.id))) {
          this.autoResumeVmIds.delete(item.id);
          this.startVm(item.id).catch((err) => {
            serverLogger.warn('VMManager', `Could not resume VM ${item.id}: ${err}`, item.id);
          });
        }
      }
    }

    this.startBackgroundMonitoring();
  }

  public checkProvisioningPreflight(osId: SupportedOsId): {
    ready: boolean;
    code?: string;
    source?: 'native' | 'cached' | 'dockur-auto';
    dockurVersion?: string;
    error?: string;
    remediation?: string;
    kvmAvailable: boolean;
    dockerAvailable: boolean;
  } {
    const hasKvm = fs.existsSync('/dev/kvm');
    const dockerInfo = dockurEngine.getRuntimeInfo();
    if (osId === 'debian-12') {
      return {
        ready: true,
        source: 'native',
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    const def = imageManager.getOsDefinition(osId);
    const imgStatus = imageManager.getImageStatus(osId);
    if (imgStatus.status === 'READY') {
      if (isMemoryBackedOverlayfs()) {
        const memAvailBytes = getContainerMemAvailableBytes();
        const minRuntimeBytes = (osId === 'windows-10' ? 2500 : 2000) * 1024 * 1024;
        if (memAvailBytes > 0 && memAvailBytes < minRuntimeBytes) {
          const availGib = (memAvailBytes / (1024 * 1024 * 1024)).toFixed(2);
          const needGib = (minRuntimeBytes / (1024 * 1024 * 1024)).toFixed(2);
          return {
            ready: false,
            code: 'INSUFFICIENT_HOST_MEMORY',
            error: `RAM khả dụng trên container không đủ để chạy thêm ${def?.name || osId} (cần ít nhất ${needGib} GiB, còn trống ${availGib} GiB).`,
            remediation: 'Hãy tắt hoặc xóa bớt máy ảo Windows đang chạy trước khi bật thêm máy mới.',
            kvmAvailable: hasKvm,
            dockerAvailable: dockerInfo.dockerDaemonRunning,
          };
        }
      }
      return {
        ready: true,
        source: 'cached',
        dockurVersion: imgStatus.dockurVersion,
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    // Check available disk space before starting multi-GB dockurr/windows ISO auto-download
    const isoDir = path.resolve(process.cwd(), 'data/iso');
    const availBytes = getAvailableDiskBytes(isoDir);
    const orderedMirrors = getOrderedMirrorsForOs(osId, availBytes);
    const smallestMirror = [...orderedMirrors].sort((a, b) => a.expectedSizeBytes - b.expectedSizeBytes)[0];
    if (availBytes > 0 && smallestMirror && availBytes < smallestMirror.expectedSizeBytes + 256 * 1024 * 1024) {
      const availGib = (availBytes / (1024 * 1024 * 1024)).toFixed(2);
      const needGib = ((smallestMirror.expectedSizeBytes + 256 * 1024 * 1024) / (1024 * 1024 * 1024)).toFixed(2);
      return {
        ready: false,
        code: 'INSUFFICIENT_DISK_SPACE',
        error: `Không đủ dung lượng ổ đĩa để tự động tải ${def?.name || osId} ISO (cần ${needGib} GiB, còn trống ${availGib} GiB).`,
        remediation: 'Xóa bớt file tạm/ISO cũ hoặc tăng dung lượng ổ đĩa lưu trữ.',
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    return {
      ready: true,
      source: 'dockur-auto',
      dockurVersion: imgStatus.dockurVersion,
      kvmAvailable: hasKvm,
      dockerAvailable: dockerInfo.dockerDaemonRunning,
    };
  }

  public async createVm(options: {
    id?: string;
    name?: string;
    osId: SupportedOsId;
    cores?: number;
    memoryMb?: number;
    diskGb?: number;
    username?: string;
    useDefaultCredentialPolicy?: boolean;
    generateUniqueCredentials?: boolean;
    onProvisioned?: (vm: VmRecord, actualPassword: string) => void;
    onProvisionFailed?: (vm: VmRecord, reason: string) => void;
  }): Promise<VmRecord> {
    const osDef = imageManager.getOsDefinition(options.osId);
    if (!osDef) {
      throw new Error(`Unsupported OS: '${options.osId}'. Supported options are 'debian-12', 'windows-10', and 'windows-7'.`);
    }

    const vmId = options.id || `vm-${options.osId}-${Date.now().toString(36)}`;
    const name = options.name || `Cloud VPS (${osDef.name})`;
    const cores = options.cores || osDef.recommendedCores;
    const memoryMb = options.memoryMb || osDef.recommendedRamMb;
    const diskGb = options.diskGb || osDef.minDiskGb;
    const isApiManaged = Boolean(options.generateUniqueCredentials);
    const isPolicyManaged = Boolean(options.useDefaultCredentialPolicy) && !isApiManaged;
    const defaultUsername = (isApiManaged && options.osId === 'debian-12')
      ? `moon_${vmId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`
      : osDef.defaultUsername;
    const username = options.username || defaultUsername;

    const actualPassword = isPolicyManaged
      ? getDefaultProvisioningPassword()
      : generateWindowsPassword(16);

    serverLogger.registerSecret(actualPassword);

    if (isApiManaged) {
      this.runtimePasswords.set(vmId, actualPassword);
    }
    if (options.onProvisioned || options.onProvisionFailed) {
      this.provisioningCallbacks.set(vmId, {
        onProvisioned: options.onProvisioned,
        onProvisionFailed: options.onProvisionFailed,
      });
    }

    const storedRecordPassword = (isApiManaged || isPolicyManaged) ? '[VAULT_PROTECTED]' : actualPassword;

    // Dynamic port allocation: Debian 12 primary uses 3389; Windows and secondary VMs allocate a distinct local port
    const localPort = (options.id === this.primaryVmId && options.osId === 'debian-12')
      ? 3389
      : networkManager.allocatePort(vmId);

    const hasKvm = fs.existsSync('/dev/kvm');
    const hypervisorId = options.osId === 'debian-12'
      ? 'container-native-linux'
      : hasKvm
      ? 'qemu-kvm-x86_64'
      : 'qemu-tcg-x86_64';

    const networkInterfaceType =
      options.osId === 'windows-10'
        ? 'Intel e1000e'
        : options.osId === 'windows-7'
        ? 'Intel e1000'
        : 'VirtIO-net';

    serverLogger.info(
      'VMManager',
      `Queued creation for new VM: ${name} [${options.osId}] (RAM: ${memoryMb}MB, Cores: ${cores}, Disk: ${diskGb}GB, LocalPort: ${localPort})`,
      vmId
    );

    const realIp = '159.223.110.159';
    const now = new Date().toISOString();
    const record: VmRecord = {
      id: vmId,
      name,
      osId: options.osId,
      osName: osDef.name,
      version: osDef.version,
      imageId: osDef.isoFileName,
      cores,
      memoryMb,
      diskGb,
      username,
      password: storedRecordPassword,
      localPort,
      ipAddress: realIp,
      publicEndpoint: 'Pending',
      hypervisorId,
      networkConfig: {
        interfaceType: networkInterfaceType,
        localPort,
        guestPort: 3389,
        natForwarding: true,
      },
      status: 'Queued',
      statusMessage: 'Yêu cầu tạo máy ảo đã vào hàng đợi xử lý.',
      securityWarning: osDef.securityWarning,
      createdAt: now,
      updatedAt: now,
      isExternalVerified: false,
      isPolicyManaged,
      isApiManaged,
      credentialsConfigured: false,
      installCompleted: false,
    };

    this.vms.set(vmId, record);
    this.saveState();

    // Execute multi-stage provisioning asynchronously
    this.executeProvisioningPipeline(vmId).catch((err) => {
      serverLogger.error('Provisioner', `Pipeline failed for VM ${vmId}: ${err}`, vmId);
    });

    return record;
  }

  /**
   * Generates Autounattend.xml and builds an ISO with genisoimage (when available)
   * ensuring the initial Windows management account has full local Administrators privileges
   * while keeping Windows UAC intact (never disables EnableLUA).
   */
  private prepareWindowsGuestCredentialsPayload(vm: VmRecord, password: string): string | undefined {
    const check = validateWindowsPassword(password);
    if (!check.valid) {
      throw new Error(`Generated ${vm.osName} password failed complexity policy: ${check.reason}`);
    }

    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const escapedPwd = escapeXml(password);
    const escapedUser = escapeXml(vm.username || 'Administrator');
    const isBuiltInAdmin = (vm.username || 'Administrator').toLowerCase() === 'administrator';

    const provDir = path.resolve(process.cwd(), 'data', 'provisioning', vm.id);
    fs.mkdirSync(provDir, { recursive: true, mode: 0o700 });

    const localAccountsBlock = !isBuiltInAdmin
      ? [
          '        <LocalAccounts>',
          '          <LocalAccount wcm:action="add">',
          '            <Password>',
          `              <Value>${escapedPwd}</Value>`,
          '              <PlainText>true</PlainText>',
          '            </Password>',
          `            <Name>${escapedUser}</Name>`,
          `            <DisplayName>${escapedUser}</DisplayName>`,
          '            <Group>Administrators</Group>',
          '            <Description>Moon Studio Windows Administrator</Description>',
          '          </LocalAccount>',
          '        </LocalAccounts>',
        ].join('\n')
      : '';

    const autounattendXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">',
      '  <settings pass="specialize">',
      '    <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
      '      <fDenyTSConnections>false</fDenyTSConnections>',
      '    </component>',
      '    <component name="Networking-MPSSVC-Svc" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
      '      <FirewallGroups>',
      '        <FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">',
      '          <Active>true</Active>',
      '          <Group>Remote Desktop</Group>',
      '          <Profile>all</Profile>',
      '        </FirewallGroup>',
      '      </FirewallGroups>',
      '    </component>',
      '  </settings>',
      '  <settings pass="oobeSystem">',
      '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
      '      <OOBE>',
      '        <HideEULAPage>true</HideEULAPage>',
      '        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>',
      '        <NetworkLocation>Work</NetworkLocation>',
      '        <ProtectYourPC>1</ProtectYourPC>',
      '      </OOBE>',
      '      <UserAccounts>',
      '        <AdministratorPassword>',
      `          <Value>${escapedPwd}</Value>`,
      '          <PlainText>true</PlainText>',
      '        </AdministratorPassword>',
      ...(localAccountsBlock ? [localAccountsBlock] : []),
      '      </UserAccounts>',
      '      <AutoLogon>',
      '        <Password>',
      `          <Value>${escapedPwd}</Value>`,
      '          <PlainText>true</PlainText>',
      '        </Password>',
      '        <Enabled>true</Enabled>',
      `        <Username>${escapedUser}</Username>`,
      '      </AutoLogon>',
      '      <FirstLogonCommands>',
      '        <SynchronousCommand wcm:action="add">',
      '          <Order>1</Order>',
      '          <Description>Enable Remote Desktop and Firewall Rule</Description>',
      '          <CommandLine>cmd /c reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f &amp;&amp; netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</CommandLine>',
      '        </SynchronousCommand>',
      '      </FirstLogonCommands>',
      '    </component>',
      '  </settings>',
      '</unattend>',
      '',
    ].join('\n');

    const xmlPath = path.join(provDir, 'Autounattend.xml');
    fs.writeFileSync(xmlPath, autounattendXml, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const unattendIsoPath = path.join(provDir, 'Autounattend.iso');
    const genisoBin = fs.existsSync('/usr/bin/genisoimage')
      ? '/usr/bin/genisoimage'
      : fs.existsSync('/usr/bin/mkisofs')
      ? '/usr/bin/mkisofs'
      : null;

    if (genisoBin) {
      try {
        execFileSync(genisoBin, ['-J', '-R', '-V', 'UNATTEND', '-o', unattendIsoPath, xmlPath], {
          stdio: 'pipe',
          timeout: 15000,
        });
        serverLogger.info('Provisioner', `Prepared ${vm.osName} Administrator Autounattend.iso (${vm.username}, UAC preserved)`, vm.id);
        return unattendIsoPath;
      } catch (err) {
        serverLogger.warn('Provisioner', `genisoimage warning while building Autounattend.iso: ${err}`, vm.id);
      }
    }

    serverLogger.info('Provisioner', `Prepared ${vm.osName} Autounattend.xml package for ${vm.id}`, vm.id);
    return undefined;
  }

  private hasInstalledWindowsDisk(vmId: string): string | null {
    const vmDisk = path.join(path.resolve(process.cwd(), 'data/disks'), `${vmId}.qcow2`);
    const check = imageManager.validateInstalledDiskImage(vmDisk);
    return check.valid ? vmDisk : null;
  }

  private async executeProvisioningPipeline(vmId: string): Promise<void> {
    const vm = this.vms.get(vmId);
    if (!vm) return;

    const callbacks = this.provisioningCallbacks.get(vmId);
    const effectivePwd =
      this.runtimePasswords.get(vmId) ||
      (vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password);
    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';

    try {
      // 1. Preparing
      if (!this.vms.has(vmId)) return;
      vm.status = 'Preparing';
      vm.statusMessage = 'Đang kiểm tra tài nguyên và chuẩn bị môi trường máy chủ...';
      vm.updatedAt = new Date().toISOString();
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 1/5] Preparing environment for ${vm.name}...`, vmId);
      await new Promise((r) => setTimeout(r, 300));

      // 2. Auto-Download & Verify Genuine Installation Media (via dockurr/windows engine for Windows)
      if (!this.vms.has(vmId)) return;
      vm.status = 'Downloading Image';
      vm.statusMessage = isWindows
        ? `Đang tự động chuẩn bị & tải ${vm.osName} ISO qua nguồn dockurr/windows...`
        : `Đang xác minh nguồn cài đặt gốc cho hệ điều hành ${vm.osName}...`;
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 2/5] Resolving installation media for ${vm.osId}...`, vmId);
      let lastSavedProgressAt = 0;
      const mediaPath = await imageManager.ensureImageReady(vm.osId, (_pct, stageMsg) => {
        if (!this.vms.has(vmId)) return;
        vm.status = 'Downloading Image';
        vm.statusMessage = stageMsg;
        vm.updatedAt = new Date().toISOString();
        if (Date.now() - lastSavedProgressAt > 8000) {
          lastSavedProgressAt = Date.now();
          this.saveState();
        }
      });
      if (!this.vms.has(vmId)) return;
      const isPreinstalledDisk = isWindows && mediaPath.endsWith('.qcow2');
      vm.mediaSourceType = vm.osId === 'debian-12'
        ? 'native_host'
        : isPreinstalledDisk
        ? 'installed_disk'
        : 'iso';

      // 3. Creating Virtual Disk
      if (!this.vms.has(vmId)) return;
      vm.status = 'Creating Disk';
      vm.statusMessage = `Đang khởi tạo ổ đĩa QCOW2 bền vững dung lượng ${vm.diskGb}GB...`;
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 3/5] Allocating storage...`, vmId);
      hypervisor.prepareDisk(vmId, vm.diskGb, isPreinstalledDisk ? mediaPath : undefined);

      // 4. Configuring Credentials & Booting Hypervisor
      if (!this.vms.has(vmId)) return;
      vm.status = 'Booting';
      vm.statusMessage = 'Đang khởi động hệ điều hành và cấu hình tài khoản truy cập...';
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 4/5] Configuring guest credentials and launching hypervisor...`, vmId);

      if (!effectivePwd || effectivePwd === '[POLICY_MANAGED]' || effectivePwd === '[VAULT_PROTECTED]') {
        throw new Error('Missing valid runtime guest password for credential provisioning.');
      }

      let autounattendIsoPath: string | undefined;
      if (vm.osId === 'debian-12') {
        const rdpReady = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          strictPasswordSync: Boolean(vm.isApiManaged),
        });
        if (!rdpReady) {
          throw new Error('Debian 12 Remote Desktop service (xrdp) failed local X.224 readiness check on port 3389.');
        }
      } else if (isWindows && !isPreinstalledDisk) {
        autounattendIsoPath = this.prepareWindowsGuestCredentialsPayload(vm, effectivePwd);
      }

      if (!this.vms.has(vmId)) return;

      const procInfo = await hypervisor.startVmProcess({
        vmId: vm.id,
        osId: vm.osId,
        hostPort: vm.localPort,
        memoryMb: vm.memoryMb,
        cores: vm.cores,
        isoPath: isPreinstalledDisk ? undefined : mediaPath,
        baseDiskPath: isPreinstalledDisk ? mediaPath : undefined,
        autounattendIsoPath,
        bootFromDiskOnly: isPreinstalledDisk,
      });

      if (procInfo.status === 'ERROR' || !procInfo.pid) {
        throw new Error(`Hypervisor process failed to enter RUNNING state for ${vm.osId}.`);
      }
      if (procInfo.memoryMb && procInfo.memoryMb !== vm.memoryMb) {
        vm.memoryMb = procInfo.memoryMb;
      }

      // Verify QMP / QEMU liveness for Windows guests
      if (isWindows) {
        const qmpState = await hypervisor.queryStatus(vm.id);
        if (!qmpState || !qmpState.running) {
          throw new Error(`QEMU hypervisor for ${vm.osName} did not report running state via QMP.`);
        }
      }

      if (vm.osId === 'debian-12') {
        const localBridgeCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: 5,
          retryDelayMs: 400,
        });
        if (!localBridgeCheck.connected || !localBridgeCheck.rdpNegotiated) {
          throw new Error(
            `Local RDP endpoint 127.0.0.1:${vm.localPort} failed X.224 handshake check: ${localBridgeCheck.statusMessage}`
          );
        }
      }

      // 5. Public Network Synchronization
      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (!tunnel.publicPort || !tunnel.publicHost) {
        throw new Error('Public TCP relay tunnel failed to allocate an external IP:Port endpoint.');
      }

      const assignedPort = tunnel.publicPort;
      const assignedHost = tunnel.publicHost;
      const endpoint = `${assignedHost}:${assignedPort}`;

      if (vm.osId === 'debian-12') {
        let verified = false;
        for (let attempt = 1; attempt <= 4; attempt++) {
          verified = await tunnelManager.verifyExternalEndpoint(vm.id);
          if (verified) break;
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        const verifiedStatus = tunnelManager.getStatus(vm.id);
        vm.rdpHealth = verifiedStatus.rdpVerification;
        if (!verified || !verifiedStatus.rdpVerification?.rdpNegotiated) {
          throw new Error(
            `Public RDP endpoint ${endpoint} failed end-to-end X.224 handshake verification: ${
              verifiedStatus.rdpVerification?.statusMessage || 'unverified'
            }`
          );
        }

        const completedAt = new Date().toISOString();
        vm.credentialsConfigured = true;
        vm.credentialsConfiguredAt = completedAt;
        vm.provisioningCompletedAt = completedAt;
        vm.installCompleted = true;
        vm.status = 'Ready';
        vm.lastBootAt = completedAt;
        vm.ipAddress = assignedHost;
        vm.publicEndpoint = endpoint;
        delete vm.failureReason;
        vm.statusMessage = 'Máy chủ đang hoạt động bình thường trên hạ tầng Google Cloud.';
        vm.isExternalVerified = true;
        vm.updatedAt = completedAt;
      } else {
        // Honest Windows RDP verification: NEVER fake Ready unless guest port 3389 answers X.224 0xD0
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: isPreinstalledDisk ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;

        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          const verifiedExt = await tunnelManager.verifyExternalEndpoint(vm.id);
          const completedAt = new Date().toISOString();
          vm.installCompleted = true;
          vm.credentialsConfigured = true;
          vm.credentialsConfiguredAt = completedAt;
          vm.provisioningCompletedAt = completedAt;
          vm.status = 'Ready';
          vm.lastBootAt = completedAt;
          vm.ipAddress = assignedHost;
          vm.publicEndpoint = endpoint;
          delete vm.failureReason;
          vm.isExternalVerified = verifiedExt;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động và xác thực RDP thành công tại ${endpoint}.`;
          vm.updatedAt = completedAt;
        } else if (!isPreinstalledDisk) {
          // Booted from genuine installer ISO on QEMU; guest Windows Setup has not finished installing RDP yet.
          const hasKvm = fs.existsSync('/dev/kvm');
          vm.installCompleted = false;
          vm.credentialsConfigured = false;
          vm.isExternalVerified = false;
          vm.status = 'Installing';
          vm.lastBootAt = new Date().toISOString();
          vm.ipAddress = assignedHost;
          vm.publicEndpoint = endpoint;
          vm.statusMessage = `${vm.osName} đang chạy trình cài đặt Windows thật trên QEMU (${hasKvm ? 'KVM' : 'TCG — không có /dev/kvm nên cài đặt sẽ rất chậm'}). Dịch vụ RDP sẽ sẵn sàng sau khi quá trình cài đặt hoàn tất.`;
          vm.updatedAt = new Date().toISOString();
          this.saveState();
          serverLogger.info('Provisioner', `${vm.osName} VM ${vm.id} is actively installing from genuine ISO via QEMU (VNC/QMP alive; RDP pending completion).`, vmId);
          return;
        } else {
          throw new Error(
            `${vm.osName} disk image booted on QEMU, but guest RDP did not respond to X.224 handshake on port ${vm.localPort}: ${rdpCheck.statusMessage}`
          );
        }
      }

      if (callbacks?.onProvisioned) {
        callbacks.onProvisioned(vm, effectivePwd);
      }
      if (vm.isApiManaged) {
        this.runtimePasswords.delete(vmId);
        vm.password = '[VAULT_PROTECTED]';
      }
      this.provisioningCallbacks.delete(vmId);

      this.saveState();
      serverLogger.info('Provisioner', `[Stage 5/5] VM online with verified credentials and endpoint: ${endpoint}`, vmId);
    } catch (err: unknown) {
      if (!this.vms.has(vmId)) {
        this.runtimePasswords.delete(vmId);
        this.provisioningCallbacks.delete(vmId);
        serverLogger.info('Provisioner', `Provisioning cancelled cleanly because VM ${vmId} was deleted.`, vmId);
        return;
      }
      const baseMsg = err instanceof Error ? err.message : String(err);
      const fullReason = baseMsg;

      vm.status = 'Failed';
      vm.credentialsConfigured = false;
      vm.isExternalVerified = false;
      vm.failureReason = fullReason;
      vm.statusMessage = `Khởi tạo thất bại: ${fullReason}`;
      vm.updatedAt = new Date().toISOString();
      this.runtimePasswords.delete(vmId);
      if (vm.isApiManaged) {
        vm.password = '[VAULT_PROTECTED]';
      }
      if (callbacks?.onProvisionFailed) {
        callbacks.onProvisionFailed(vm, fullReason);
      }
      this.provisioningCallbacks.delete(vmId);
      this.saveState();
      serverLogger.error('Provisioner', `Provisioning failed: ${fullReason}`, vmId);
    }
  }

  public async syncTunnelEndpoint(vmId: string): Promise<void> {
    const vm = this.vms.get(vmId);
    if (!vm) return;

    const tunnel = tunnelManager.getStatus(vmId);
    if (tunnel.publicPort && tunnel.isVerified) {
      vm.ipAddress = tunnel.publicHost;
      vm.publicEndpoint = tunnel.publicEndpoint;
      vm.status = 'Ready';
      delete vm.failureReason;
      vm.statusMessage =
        vm.osId === 'windows-10'
          ? `Máy ảo Windows 10 đã sẵn sàng qua cổng kết nối ${tunnel.publicEndpoint}.`
          : vm.osId === 'windows-7'
          ? `Máy ảo Windows 7 SP1 đã sẵn sàng qua cổng kết nối ${tunnel.publicEndpoint}.`
          : 'Máy ảo đã sẵn sàng và cổng kết nối từ xa đã được xác thực.';
      vm.isExternalVerified = true;
      vm.updatedAt = new Date().toISOString();
      this.saveState();
    } else if (tunnel.publicPort && (vm.osId === 'debian-12' || vm.installCompleted)) {
      const verified = await tunnelManager.verifyExternalEndpoint(vmId);
      if (verified) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = tunnel.publicEndpoint;
        vm.status = 'Ready';
        delete vm.failureReason;
        vm.isExternalVerified = true;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
    }
  }

  public async startVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) {
      serverLogger.warn('VMManager', `Operation locked: VM ${vmId} is currently undergoing another action.`, vmId);
      return false;
    }
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
      serverLogger.info('VMManager', `Starting VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Booting';
      vm.statusMessage = `Đang khởi động máy ảo ${vm.osName}...`;
      vm.updatedAt = new Date().toISOString();
      this.saveState();

      if (vm.osId === 'debian-12') {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        const rdpOk = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        if (!rdpOk) {
          throw new Error('Debian 12 xrdp failed X.224 readiness check.');
        }

        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
        });
      } else {
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        let isoPath: string | undefined;
        let baseDiskPath: string | undefined;

        if (bootFromDiskOnly) {
          baseDiskPath = installedDisk || undefined;
        } else {
          const mediaPath = await imageManager.ensureImageReady(vm.osId);
          if (mediaPath.endsWith('.qcow2')) {
            baseDiskPath = mediaPath;
          } else {
            isoPath = mediaPath;
          }
        }

        const provIso = path.resolve(process.cwd(), 'data', 'provisioning', vm.id, 'Autounattend.iso');
        let autounattendIsoPath: string | undefined =
          !bootFromDiskOnly && fs.existsSync(provIso) ? provIso : undefined;
        if (!bootFromDiskOnly && !autounattendIsoPath) {
          const effectivePwd =
            this.runtimePasswords.get(vm.id) ||
            (vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password);
          if (effectivePwd && effectivePwd !== '[POLICY_MANAGED]' && effectivePwd !== '[VAULT_PROTECTED]') {
            autounattendIsoPath = this.prepareWindowsGuestCredentialsPayload(vm, effectivePwd);
          }
        }
        const procInfo = await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          isoPath,
          baseDiskPath,
          autounattendIsoPath,
          bootFromDiskOnly,
        });
        if (procInfo.memoryMb && procInfo.memoryMb !== vm.memoryMb) {
          vm.memoryMb = procInfo.memoryMb;
        }
      }

      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (tunnel.publicPort && tunnel.publicHost) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
      }

      if (vm.osId === 'debian-12') {
        vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
        vm.status = 'Ready';
        delete vm.failureReason;
        vm.lastBootAt = new Date().toISOString();
        vm.statusMessage = 'Máy ảo đang hoạt động bình thường.';
      } else {
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: vm.installCompleted ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;
        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          vm.installCompleted = true;
          vm.status = 'Ready';
          delete vm.failureReason;
          vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động và sẵn sàng RDP.`;
        } else {
          vm.status = 'Installing';
          vm.isExternalVerified = false;
          vm.statusMessage = `${vm.osName} đang chạy trên QEMU; đang chờ hệ điều hành hoàn tất boot/cài đặt và mở dịch vụ RDP.`;
        }
        vm.lastBootAt = new Date().toISOString();
      }

      this.saveState();
      return true;
    } catch (err: unknown) {
      const vm = this.vms.get(vmId);
      if (vm) {
        const reason = err instanceof Error ? err.message : String(err);
        vm.status = 'Failed';
        vm.isExternalVerified = false;
        vm.failureReason = reason;
        vm.statusMessage = `Khởi động thất bại: ${reason}`;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
      return false;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async shutdownVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      serverLogger.info('VMManager', `Sending ACPI shutdown to VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Stopped';
      vm.statusMessage = 'Máy ảo đã tắt có kiểm soát qua ACPI.';
      vm.updatedAt = new Date().toISOString();
      this.saveState();
      await hypervisor.gracefulShutdown(vmId);
      return true;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async restartVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
      serverLogger.info('VMManager', `Restarting VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Booting';
      vm.statusMessage = 'Đang khởi động lại máy ảo...';
      this.saveState();

      if (isWindows) {
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        const rebooted = await hypervisor.reboot(vmId);
        if (!rebooted) {
          await hypervisor.forceStop(vmId);
          let isoPath: string | undefined;
          let baseDiskPath: string | undefined;
          if (bootFromDiskOnly) {
            baseDiskPath = installedDisk || undefined;
          } else {
            const mediaPath = await imageManager.ensureImageReady(vm.osId);
            if (mediaPath.endsWith('.qcow2')) baseDiskPath = mediaPath;
            else isoPath = mediaPath;
          }
          await hypervisor.startVmProcess({
            vmId: vm.id,
            osId: vm.osId,
            hostPort: vm.localPort,
            memoryMb: vm.memoryMb,
            cores: vm.cores,
            isoPath,
            baseDiskPath,
            bootFromDiskOnly,
          });
        }
      } else {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
        });
      }

      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (tunnel.publicPort && tunnel.publicHost) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
      }

      if (vm.osId === 'debian-12') {
        vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
        vm.status = 'Ready';
        delete vm.failureReason;
        vm.statusMessage = 'Máy ảo đã khởi động lại thành công.';
      } else {
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: vm.installCompleted ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;
        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          vm.installCompleted = true;
          vm.status = 'Ready';
          delete vm.failureReason;
          vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động lại và giữ nguyên dữ liệu đĩa QCOW2.`;
        } else {
          vm.status = 'Installing';
          vm.isExternalVerified = false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động lại từ đĩa QCOW2 bền vững; đang chờ dịch vụ RDP sẵn sàng.`;
        }
      }

      vm.updatedAt = new Date().toISOString();
      this.saveState();
      return true;
    } catch (err: unknown) {
      const vm = this.vms.get(vmId);
      if (vm) {
        const reason = err instanceof Error ? err.message : String(err);
        vm.status = 'Failed';
        vm.isExternalVerified = false;
        vm.failureReason = reason;
        vm.statusMessage = `Khởi động lại thất bại: ${reason}`;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
      return false;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async stopVm(vmId: string): Promise<boolean> {
    return this.shutdownVm(vmId);
  }

  public async forceStopVm(vmId: string): Promise<boolean> {
    const vm = this.vms.get(vmId);
    if (!vm) return false;

    serverLogger.warn('VMManager', `Force stopping VM ${vmId} (SIGKILL)...`, vmId);
    await hypervisor.forceStop(vmId);
    vm.status = 'Stopped';
    vm.statusMessage = 'Máy ảo đã bị cưỡng chế dừng (Force Stop).';
    vm.updatedAt = new Date().toISOString();
    this.saveState();
    return true;
  }

  public async deleteVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      serverLogger.info('VMManager', `Deleting VM ${vmId} (${vm.osId})...`, vmId);
      if (vm.status === 'Downloading Image') {
        const otherDownloading = Array.from(this.vms.values()).some(
          (other) => other.id !== vmId && other.osId === vm.osId && other.status === 'Downloading Image'
        );
        if (!otherDownloading) {
          imageManager.abortActiveDownload(vm.osId);
        }
      }
      await hypervisor.forceStop(vmId);
      hypervisor.cleanupVmArtifacts(vmId);
      tunnelManager.stop(vmId);
      networkManager.releasePort(vm.localPort, vmId);
      this.runtimePasswords.delete(vmId);
      this.provisioningCallbacks.delete(vmId);
      try {
        const provDir = path.resolve(process.cwd(), 'data', 'provisioning', vmId);
        if (fs.existsSync(provDir)) {
          fs.rmSync(provDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
      this.vms.delete(vmId);
      if (this.primaryVmId === vmId) {
        this.primaryVmId = this.vms.has('vm-moon-win-01')
          ? 'vm-moon-win-01'
          : Array.from(this.vms.keys())[0] || 'vm-moon-win-01';
      }
      this.saveState();
      return true;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async rebuildVm(vmId: string): Promise<VmRecord | null> {
    if (this.vmLocks.has(vmId)) return null;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return null;

      serverLogger.info('VMManager', `Rebuilding virtual machine environment for ${vmId}...`, vmId);
      await hypervisor.forceStop(vmId);
      hypervisor.cleanupVmArtifacts(vmId);

      const newPwd = generateWindowsPassword(16);
      serverLogger.registerSecret(newPwd);
      if (vm.isApiManaged) {
        this.runtimePasswords.set(vmId, newPwd);
        vm.password = '[VAULT_PROTECTED]';
      } else {
        vm.password = newPwd;
      }
      vm.credentialsConfigured = false;
      vm.installCompleted = false;
      vm.isExternalVerified = false;
      delete vm.failureReason;
      vm.status = 'Preparing';
      vm.statusMessage = 'Đang xây dựng lại hệ thống...';
      vm.updatedAt = new Date().toISOString();
      this.saveState();

      this.executeProvisioningPipeline(vmId).catch(() => {});
      return vm;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async reloadIp(vmId?: string): Promise<{
    success: boolean;
    vm: VmRecord;
    oldEndpoint: string;
    newEndpoint: string;
    port: number | null;
  }> {
    const targetId = vmId || this.primaryVmId;
    const vm = this.vms.get(targetId) || this.getPrimaryVm();
    if (!vm) {
      throw new Error(`Không tìm thấy máy ảo ${targetId}`);
    }

    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
    serverLogger.info('VMManager', `Reloading IP and public endpoint for VM ${vm.id} (${vm.osName})...`, vm.id);
    const oldEndpoint = vm.publicEndpoint;

    if (vm.osId === 'debian-12') {
      const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
      const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
      const rdpReady = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
        skipPasswordReset: vm.isApiManaged && isProtected,
      });
      if (!rdpReady) {
        throw new Error('Debian 12 xrdp service failed local X.224 readiness check during IP reload.');
      }
      await hypervisor.startVmProcess({
        vmId: vm.id,
        osId: vm.osId,
        hostPort: vm.localPort,
        memoryMb: vm.memoryMb,
        cores: vm.cores,
      });
    } else if (isWindows) {
      const proc = hypervisor.getVmProcess(vm.id);
      const isRunning = Boolean(proc && proc.pid);
      if (!isRunning) {
        serverLogger.info('VMManager', `Starting hypervisor process for ${vm.osName} before IP reload...`, vm.id);
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        let isoPath: string | undefined;
        let baseDiskPath: string | undefined;
        if (bootFromDiskOnly) {
          baseDiskPath = installedDisk || undefined;
        } else {
          const mediaPath = await imageManager.ensureImageReady(vm.osId);
          if (mediaPath.endsWith('.qcow2')) baseDiskPath = mediaPath;
          else isoPath = mediaPath;
        }
        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          isoPath,
          baseDiskPath,
          bootFromDiskOnly,
        });
      }
    }

    const tunnel = await tunnelManager.reloadTunnel(vm.id, vm.localPort);
    if (!tunnel.publicPort || !tunnel.publicHost) {
      throw new Error('Failed to allocate a new public endpoint from TCP relay tunnel.');
    }
    const assignedPort = tunnel.publicPort;
    const assignedHost = tunnel.publicHost;
    const newEndpoint = `${assignedHost}:${assignedPort}`;

    let verified = false;
    if (vm.osId === 'debian-12') {
      verified = await tunnelManager.verifyExternalEndpoint(vm.id);
      if (!verified) {
        throw new Error(`New public RDP endpoint ${newEndpoint} failed end-to-end X.224 handshake check.`);
      }
      vm.status = 'Ready';
      delete vm.failureReason;
      vm.statusMessage = `Đã cấp phát địa chỉ IP & Cổng mới cho Debian 12: ${newEndpoint}. Sẵn sàng kết nối!`;
    } else {
      const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
        timeoutMs: 2500,
        retries: 3,
        retryDelayMs: 400,
      });
      vm.rdpHealth = rdpCheck;
      if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
        verified = await tunnelManager.verifyExternalEndpoint(vm.id);
        vm.status = 'Ready';
        vm.installCompleted = true;
        delete vm.failureReason;
        vm.statusMessage = `Đã cấp phát địa chỉ IP & Cổng mới cho ${vm.osName}: ${newEndpoint}. Sẵn sàng kết nối!`;
      } else {
        vm.status = 'Installing';
        vm.statusMessage = `Đã cấp phát cổng ${newEndpoint} cho ${vm.osName}; dịch vụ RDP khách chưa phản hồi X.224.`;
      }
    }

    vm.ipAddress = assignedHost;
    vm.publicEndpoint = newEndpoint;
    vm.isExternalVerified = verified;
    vm.updatedAt = new Date().toISOString();
    this.saveState();

    serverLogger.info(
      'VMManager',
      `Successfully reloaded IP endpoint for ${vm.name}: ${oldEndpoint} -> ${newEndpoint}`,
      vm.id
    );

    return {
      success: true,
      vm,
      oldEndpoint,
      newEndpoint,
      port: assignedPort,
    };
  }

  public setPrimaryVm(vmId: string): boolean {
    if (this.vms.has(vmId)) {
      this.primaryVmId = vmId;
      return true;
    }
    return false;
  }

  public getPrimaryVm(): VmRecord | undefined {
    return this.vms.get(this.primaryVmId) || Array.from(this.vms.values())[0];
  }

  public getVm(id: string): VmRecord | undefined {
    return this.vms.get(id);
  }

  public getAllVms(): VmRecord[] {
    return Array.from(this.vms.values());
  }

  public renameVm(vmId: string, newName: string): VmRecord | undefined {
    const vm = this.vms.get(vmId);
    if (!vm) return undefined;
    vm.name = newName;
    vm.updatedAt = new Date().toISOString();
    this.saveState();
    return vm;
  }

  public getPublicConnectionInfo(): {
    ipAddress: string;
    realEgressIp: string;
    ingressHost: string;
    port: number;
    publicEndpoint: string;
    connectionAddress: string;
    username: string;
    password: string;
    status: string;
    vmId: string;
    osId: SupportedOsId;
    osName: string;
    isVerified: boolean;
    directTcpBlocked: boolean;
    securityWarning?: string;
    failureReason?: string;
    statusMessage?: string;
    networkNotice: string;
  } | null {
    const vm = this.getPrimaryVm();
    if (!vm) return null;

    const tunnel = tunnelManager.getStatus(vm.id);
    const isStoppedOrFailed = vm.status === 'Stopped' || vm.status === 'Failed';
    const isTunnelActive = !isStoppedOrFailed && tunnel.active && Boolean(tunnel.publicPort) && Boolean(tunnel.publicHost);
    const realIp = (vm.ipAddress && !vm.ipAddress.includes('...')) ? vm.ipAddress : '159.223.110.159';
    const connectionHost = isTunnelActive ? tunnel.publicHost : realIp;
    const port = isTunnelActive ? (tunnel.publicPort || vm.localPort) : vm.localPort;
    const endpoint = vm.status === 'Stopped'
      ? 'Stopped'
      : isTunnelActive
      ? `${connectionHost}:${port}`
      : vm.status === 'Failed'
      ? 'Unavailable'
      : `${connectionHost}:${port}`;
    const ingressHost = process.env.APP_URL
      ? process.env.APP_URL.replace(/^https?:\/\//, '')
      : 'ais-dev-g3czgxt4thcmpa4fqf52fm-90440632741.asia-east1.run.app';

    const isVerified = Boolean(vm.isExternalVerified && vm.status === 'Ready');
    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';

    return {
      ipAddress: connectionHost,
      realEgressIp: realIp,
      ingressHost,
      port,
      publicEndpoint: endpoint,
      connectionAddress: endpoint,
      username: vm.username,
      password: vm.password,
      status: vm.status === 'Ready' || vm.status === 'Running' ? 'Online' : vm.status,
      vmId: vm.id,
      osId: vm.osId,
      osName: vm.osName,
      isVerified,
      directTcpBlocked: !isTunnelActive,
      securityWarning: vm.securityWarning,
      failureReason: vm.failureReason,
      statusMessage: vm.statusMessage,
      networkNotice: vm.status === 'Failed'
        ? `Máy ảo ${vm.osName} hiện không khả dụng: ${vm.failureReason || vm.statusMessage || 'Khởi tạo thất bại.'}`
        : vm.status === 'Stopped'
        ? `Máy ảo ${vm.osName} đang tạm dừng (Stopped). Nhấn nút "Bật máy" để khởi động lại tiến trình QEMU và cấp phát cổng kết nối mới.`
        : isWindows && vm.status === 'Installing'
        ? `Máy ảo ${vm.osName} đang chạy trình cài đặt Windows thật trên QEMU. Hãy dùng bảng điều khiển Framebuffer tương tác bên dưới để thao tác trực tiếp; cổng RDP (${endpoint}) sẽ mở khi cài đặt hoàn tất.`
        : isTunnelActive
        ? `Đã kích hoạt Public TCP Relay thật qua ${endpoint}. Bạn có thể kết nối trực tiếp từ Windows App (mstsc) bằng địa chỉ này!`
        : 'Lưu ý kết nối: Cổng TCP trực tiếp bị tường lửa Cloud Run bảo vệ. Hệ thống cam kết 100% KHÔNG tạo IP giả mạo. Hãy sử dụng Cloud Web Terminal tương tác thật 100% bên dưới.',
    };
  }

  private startBackgroundMonitoring(): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(async () => {
      const primary = this.getPrimaryVm();
      if (primary && (primary.status === 'Running' || primary.status === 'Ready')) {
        await this.syncTunnelEndpoint(primary.id);
      }

      // Monitor any actively installing Windows VMs until guest RDP comes online or QEMU exits
      for (const vm of this.vms.values()) {
        if ((vm.osId === 'windows-10' || vm.osId === 'windows-7') && vm.status === 'Installing') {
          const tunnel = tunnelManager.getStatus(vm.id);
          if (tunnel.active && tunnel.publicPort && tunnel.publicHost) {
            const liveEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
            if (vm.publicEndpoint !== liveEndpoint) {
              vm.ipAddress = tunnel.publicHost;
              vm.publicEndpoint = liveEndpoint;
              vm.updatedAt = new Date().toISOString();
              this.saveState();
            }
          }

          const qmp = await hypervisor.queryStatus(vm.id);
          if (!qmp || !qmp.running) {
            vm.status = 'Failed';
            vm.isExternalVerified = false;
            vm.failureReason = `QEMU hypervisor process for ${vm.osName} stopped before installation completed.`;
            vm.statusMessage = `Cài đặt gián đoạn: ${vm.failureReason}`;
            vm.updatedAt = new Date().toISOString();
            this.saveState();
            continue;
          }

          const rdp = await rdpHealthChecker.checkRdp('127.0.0.1', vm.localPort, 2000, vm.id);
          if (rdp.connected && rdp.rdpNegotiated) {
            vm.installCompleted = true;
            vm.credentialsConfigured = true;
            vm.credentialsConfiguredAt = new Date().toISOString();
            vm.provisioningCompletedAt = vm.credentialsConfiguredAt;
            vm.rdpHealth = rdp;
            vm.status = 'Ready';
            delete vm.failureReason;
            vm.isExternalVerified = await tunnelManager.verifyExternalEndpoint(vm.id);
            vm.statusMessage = `Quá trình cài đặt ${vm.osName} đã hoàn tất và dịch vụ RDP đã sẵn sàng.`;
            vm.updatedAt = new Date().toISOString();
            this.saveState();
          }
        }
      }
    }, 15000);
  }
}

export const vmManager = new VmManager();
