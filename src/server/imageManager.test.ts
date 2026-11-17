import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageManager, isSupportedOsId } from './imageManager';
import { vmManager } from './vmManager';

test('ImageManager provides Debian 12, Windows 10, and Windows 7', () => {
  const catalog = imageManager.getOsCatalog();
  assert.equal(catalog.length, 3);

  const ids = catalog.map((o) => o.id);
  assert.ok(ids.includes('debian-12'));
  assert.ok(ids.includes('windows-10'));
  assert.ok(ids.includes('windows-7'));
  assert.equal(isSupportedOsId('windows-10'), true);
  assert.equal(isSupportedOsId('ubuntu'), false);
});

test('ImageManager Debian 12 has active LTS support', () => {
  const debian = imageManager.getOsDefinition('debian-12');
  assert.ok(debian);
  assert.equal(debian.name, 'Debian 12');
  assert.equal(debian.supportStatus, 'Active LTS');
});

test('ImageManager Windows 10 configures UEFI OVMF + TPM 2.0 and Active Support', () => {
  const win10 = imageManager.getOsDefinition('windows-10');
  assert.ok(win10);
  assert.equal(win10.name, 'Windows 10');
  assert.equal(win10.supportStatus, 'Active Support');
  assert.equal(win10.firmware, 'UEFI (OVMF + TPM 2.0)');
  assert.equal(win10.recommendedRamMb, 4096);
  assert.equal(win10.defaultUsername, 'Administrator');
});

test('ImageManager Windows 7 includes End of Support warning', () => {
  const win7 = imageManager.getOsDefinition('windows-7');
  assert.ok(win7);
  assert.equal(win7.name, 'Windows 7');
  assert.equal(win7.supportStatus, 'End of Support (EOS)');
  assert.ok(win7.securityWarning);
  assert.ok(win7.securityWarning.includes('Microsoft'));
});

test('ImageManager exposes dockurr/windows auto-download status without manual ISO env vars and rejects fake stubs', async () => {
  const debianIso = await imageManager.ensureImageReady('debian-12');
  assert.ok(debianIso.includes('debian-12-standard.iso'));

  // Reject small synthetic stub ISO
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-iso-check-'));
  try {
    const fakeStubPath = path.join(tmpDir, 'fake-windows.iso');
    fs.writeFileSync(fakeStubPath, Buffer.alloc(64 * 1024, 0));
    const check = imageManager.validateWindowsIsoMedia(fakeStubPath);
    assert.equal(check.valid, false);
    assert.equal(check.mediaState, 'INVALID_STUB_ISO');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const win10Status = imageManager.getImageStatus('windows-10');
  assert.equal(win10Status.autoDownloadAvailable, true);
  assert.equal(win10Status.dockurVersion, '10');
  assert.ok(win10Status.status === 'READY' || win10Status.status === 'AUTO_DOWNLOAD');

  const win7Status = imageManager.getImageStatus('windows-7');
  assert.equal(win7Status.autoDownloadAvailable, true);
  assert.equal(win7Status.dockurVersion, '7u');
  assert.ok(win7Status.status === 'READY' || win7Status.status === 'AUTO_DOWNLOAD');
});

test('VmManager checkProvisioningPreflight permits Debian 12, Windows 10, and Windows 7 via dockurr/windows auto-ISO', () => {
  const debCheck = vmManager.checkProvisioningPreflight('debian-12');
  assert.equal(debCheck.ready, true);
  assert.equal(debCheck.source, 'native');

  const win10Check = vmManager.checkProvisioningPreflight('windows-10');
  assert.equal(win10Check.ready, true);
  assert.equal(win10Check.dockurVersion, '10');
  assert.ok(win10Check.source === 'cached' || win10Check.source === 'dockur-auto');

  const win7Check = vmManager.checkProvisioningPreflight('windows-7');
  assert.equal(win7Check.ready, true);
  assert.equal(win7Check.dockurVersion, '7u');
  assert.ok(win7Check.source === 'cached' || win7Check.source === 'dockur-auto');
});
