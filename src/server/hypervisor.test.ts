import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hypervisor } from './hypervisor';

test('Hypervisor prepares virtual disk image correctly and cleans up artifacts', () => {
  const vmId = `test-unit-vm-${Date.now()}`;
  try {
    const diskPath = hypervisor.prepareDisk(vmId, 20);
    assert.ok(fs.existsSync(diskPath));
    assert.ok(diskPath.endsWith('.qcow2'));
  } finally {
    hypervisor.cleanupVmArtifacts(vmId);
  }
});

test('Hypervisor configures Windows 10 with Q35, UEFI OVMF, AHCI SATA, and Intel e1000e', async () => {
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

test('Hypervisor configures Windows 7 with SeaBIOS, IDE, and e1000', async () => {
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

