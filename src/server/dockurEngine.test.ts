import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCKUR_MIRROR_CATALOG,
  getDockurVersionCode,
  getOrderedMirrorsForOs,
  buildDockurContainerSpec,
} from './dockurEngine';

test('dockurEngine maps OS IDs to official dockurr/windows VERSION tags automatically', () => {
  assert.equal(getDockurVersionCode('windows-10'), '10');
  assert.equal(getDockurVersionCode('windows-7'), '7u');
  assert.equal(getDockurVersionCode('debian-12'), 'debian-12');
});

test('dockurEngine mirror catalog includes valid genuine Windows 10 and Windows 7 mirrors', () => {
  assert.ok(DOCKUR_MIRROR_CATALOG['windows-10'].length >= 2);
  assert.ok(DOCKUR_MIRROR_CATALOG['windows-7'].length >= 2);
  for (const item of [...DOCKUR_MIRROR_CATALOG['windows-10'], ...DOCKUR_MIRROR_CATALOG['windows-7']]) {
    assert.ok(item.url.startsWith('https://'));
    assert.ok(item.expectedSizeBytes > 3 * 1024 * 1024 * 1024);
  }
});

test('dockurEngine prioritizes compact Windows 10 ISO first when host disk free space is under 14 GiB', () => {
  const tightOrdered = getOrderedMirrorsForOs('windows-10', 11 * 1024 * 1024 * 1024);
  const spaciousOrdered = getOrderedMirrorsForOs('windows-10', 40 * 1024 * 1024 * 1024);

  assert.ok(tightOrdered[0].expectedSizeBytes <= tightOrdered[1].expectedSizeBytes);
  assert.equal(tightOrdered[0].id, 'archive-win10-ltsc-2021');
  assert.equal(spaciousOrdered[0].id, 'archive-win10-22h2-business');
});

test('dockurEngine builds valid dockurr/windows docker run spec without manual ISO paths', () => {
  const spec = buildDockurContainerSpec({
    vmId: 'vm-win10-test',
    osId: 'windows-10',
    cores: 2,
    memoryMb: 4096,
    diskGb: 40,
    username: 'Administrator',
    password: 'StrongPassword#2026',
    rdpPort: 3390,
    webPort: 8006,
  });

  assert.equal(spec.image, 'dockurr/windows:latest');
  assert.equal(spec.versionTag, '10');
  assert.ok(spec.args.includes('VERSION=10'));
  assert.ok(spec.args.includes('RAM_SIZE=4G'));
  assert.ok(spec.args.includes('CPU_CORES=2'));
  assert.ok(spec.args.includes('DISK_SIZE=40G'));
  assert.ok(spec.args.includes('3390:3389/tcp'));
  assert.ok(spec.args.includes('8006:8006'));
  assert.equal(spec.args.some((a) => a.includes('ISO_PATH')), false);
});
