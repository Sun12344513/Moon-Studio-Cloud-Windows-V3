import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hypervisor } from './hypervisor';

test('Hypervisor prepares virtual disk image correctly and cleans up artifacts', () => {
  const vmId = `test-unit-vm-${Date.now()}`;
  try {
    const diskPath = hypervisor.prepareDisk(vmId, 20);
    assert.ok(fs.existsSync(diskPath));
    assert.ok(diskPath.endsWith('.qcow2'));
    if (fs.existsSync('/usr/bin/qemu-img')) {
      const info = execFileSync('/usr/bin/qemu-img', ['info', diskPath], { encoding: 'utf8' });
      assert.ok(info.includes('file format: qcow2'));
      assert.ok(info.includes('compression type: zstd'));
    }
  } finally {
    hypervisor.cleanupVmArtifacts(vmId);
  }
});

test('Hypervisor configures Windows 10 with Q35, UEFI OVMF, AHCI SATA, and Intel e1000e', async (t) => {
  if (!fs.existsSync('/usr/bin/qemu-system-x86_64')) {
    t.skip('QEMU binary not installed on host; run inside Dockerfile runtime container');
    return;
  }
  const vmId = `test-win10-config-${Date.now()}`;

  try {
    const info = await hypervisor.startVmProcess({
      vmId,
      osId: 'windows-10',
      hostPort: 3398,
      memoryMb: 1024,
      cores: 2,
      bootFromDiskOnly: true,
    });

    assert.equal(info.osId, 'windows-10');
    assert.ok(info.hardwareProfile?.chipset?.includes('Q35 (UEFI OVMF'));
    assert.equal(info.hardwareProfile?.diskInterface, 'AHCI SATA');
    assert.equal(info.hardwareProfile?.networkInterface, 'Intel e1000e');
    assert.equal(info.hardwareProfile?.bios, 'UEFI (OVMF)');
    assert.ok(info.pid !== null && info.pid > 0);
    assert.ok(info.nvramPath && fs.existsSync(info.nvramPath));

    const status = await hypervisor.queryStatus(vmId);
    assert.ok(status !== null);
    assert.ok(status.running === true || status.status === 'running');

    const screenshotPath = await hypervisor.takeScreenshot(vmId);
    if (screenshotPath) {
      assert.ok(fs.existsSync(screenshotPath));
    }
  } finally {
    await hypervisor.forceStop(vmId);
    hypervisor.cleanupVmArtifacts(vmId);
  }
});

test('Hypervisor configures Windows 7 with SeaBIOS, IDE, and e1000', async (t) => {
  if (!fs.existsSync('/usr/bin/qemu-system-x86_64')) {
    t.skip('QEMU binary not installed on host; run inside Dockerfile runtime container');
    return;
  }
  const vmId = `test-win7-config-${Date.now()}`;

  try {
    const info = await hypervisor.startVmProcess({
      vmId,
      osId: 'windows-7',
      hostPort: 3399,
      memoryMb: 1024,
      cores: 2,
      bootFromDiskOnly: true,
    });

    assert.equal(info.osId, 'windows-7');
    assert.equal(info.hardwareProfile?.chipset, 'i440fx (Legacy PC)');
    assert.equal(info.hardwareProfile?.diskInterface, 'IDE');
    assert.equal(info.hardwareProfile?.networkInterface, 'Intel e1000');
    assert.equal(info.hardwareProfile?.bios, 'SeaBIOS Legacy');
    assert.ok(info.pid !== null && info.pid > 0);

    const status = await hypervisor.queryStatus(vmId);
    assert.ok(status !== null);
    assert.ok(status.running === true || status.status === 'running');

    const screenshotPath = await hypervisor.takeScreenshot(vmId);
    if (screenshotPath) {
      assert.ok(fs.existsSync(screenshotPath));
    }
  } finally {
    await hypervisor.forceStop(vmId);
    hypervisor.cleanupVmArtifacts(vmId);
  }
});

test('Hypervisor attaches Windows 7 installer + Autounattend ISOs alongside live compress disk without IDE conflicts', async (t) => {
  if (!fs.existsSync('/usr/bin/qemu-system-x86_64')) {
    t.skip('QEMU binary not installed on host; run inside Dockerfile runtime container');
    return;
  }
  const vmId = `test-win7-iso-${Date.now()}`;
  const fakeIso = `/tmp/${vmId}-main.iso`;
  const fakeAutoIso = `/tmp/${vmId}-auto.iso`;
  fs.writeFileSync(fakeIso, Buffer.alloc(65536));
  fs.writeFileSync(fakeAutoIso, Buffer.alloc(65536));

  try {
    const info = await hypervisor.startVmProcess({
      vmId,
      osId: 'windows-7',
      hostPort: 3400,
      memoryMb: 1024,
      cores: 2,
      isoPath: fakeIso,
      autounattendIsoPath: fakeAutoIso,
      bootFromDiskOnly: false,
    });

    assert.equal(info.bootMode, 'iso');
    assert.ok(info.pid !== null && info.pid > 0);
    const status = await hypervisor.queryStatus(vmId);
    assert.ok(status !== null);
    assert.ok(status.running === true || status.status === 'running');
  } finally {
    await hypervisor.forceStop(vmId);
    hypervisor.cleanupVmArtifacts(vmId);
    if (fs.existsSync(fakeIso)) fs.unlinkSync(fakeIso);
    if (fs.existsSync(fakeAutoIso)) fs.unlinkSync(fakeAutoIso);
  }
});

