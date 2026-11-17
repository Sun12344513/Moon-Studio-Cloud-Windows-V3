import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertP6PpmToPng,
  clamp01,
  buildMouseMoveEvents,
  buildMouseButtonEvents,
  buildMouseClickEvents,
  buildMouseWheelEvents,
  buildKeyComboEvents,
  mapCharToQcodeCombo,
} from './qmpInput';

describe('qmpInput helpers', () => {
  it('converts a valid P6 PPM buffer (with header comment) into a valid PNG buffer', () => {
    const width = 4;
    const height = 3;
    const header = Buffer.from(`P6\n# QEMU screendump\n${width} ${height}\n255\n`, 'ascii');
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = 12;
      pixels[i + 1] = 140;
      pixels[i + 2] = 250;
    }
    const ppm = Buffer.concat([header, pixels]);
    const result = convertP6PpmToPng(ppm);
    assert.ok(result, 'Expected valid PNG conversion result');
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    // PNG magic signature
    assert.deepEqual(
      Array.from(result.png.subarray(0, 8)),
      [137, 80, 78, 71, 13, 10, 26, 10]
    );
    // IHDR chunk width/height verification
    assert.equal(result.png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(result.png.readUInt32BE(16), width);
    assert.equal(result.png.readUInt32BE(20), height);
    // IEND chunk at end
    assert.equal(result.png.subarray(result.png.length - 8, result.png.length - 4).toString('ascii'), 'IEND');
  });

  it('rejects malformed or truncated PPM buffers cleanly', () => {
    assert.equal(convertP6PpmToPng(Buffer.from('P3\n2 2\n255\n')), null);
    assert.equal(convertP6PpmToPng(Buffer.from('P6\n100 100\n255\n\x00\x01')), null);
    assert.equal(convertP6PpmToPng(Buffer.alloc(4)), null);
  });

  it('clamps and scales normalized pointer coordinates to QMP USB-tablet range 0..32767', () => {
    assert.equal(clamp01(-0.5), 0);
    assert.equal(clamp01(1.8), 1);
    assert.equal(clamp01(Number.NaN), 0);

    const center = buildMouseMoveEvents(0.5, 0.5);
    assert.deepEqual(center, [
      { type: 'abs', data: { axis: 'x', value: 16384 } },
      { type: 'abs', data: { axis: 'y', value: 16384 } },
    ]);

    const bounds = buildMouseMoveEvents(-1, 2);
    assert.deepEqual(bounds, [
      { type: 'abs', data: { axis: 'x', value: 0 } },
      { type: 'abs', data: { axis: 'y', value: 32767 } },
    ]);
  });

  it('builds left, right, double click, drag button, and wheel QMP events', () => {
    const rightClick = buildMouseClickEvents(0.25, 0.75, 'right', false);
    assert.equal(rightClick.length, 4);
    assert.deepEqual(rightClick[2], { type: 'btn', data: { down: true, button: 'right' } });
    assert.deepEqual(rightClick[3], { type: 'btn', data: { down: false, button: 'right' } });

    const dblClick = buildMouseClickEvents(0.5, 0.5, 'left', true);
    assert.equal(dblClick.length, 6);

    const dragDown = buildMouseButtonEvents('left', true, 0.1, 0.2);
    assert.equal(dragDown.length, 3);
    assert.deepEqual(dragDown[2], { type: 'btn', data: { down: true, button: 'left' } });

    const wheelUp = buildMouseWheelEvents('up', 0.5, 0.5);
    assert.deepEqual(wheelUp.slice(2), [
      { type: 'btn', data: { down: true, button: 'wheel-up' } },
      { type: 'btn', data: { down: false, button: 'wheel-up' } },
    ]);
  });

  it('builds ordered press and reverse-ordered release events for key combos', () => {
    const cad = buildKeyComboEvents(['ctrl', 'alt', 'delete']);
    assert.equal(cad.length, 6);
    assert.deepEqual(
      cad.map((e) => [e.data.down, (e.data.key as { data: string }).data]),
      [
        [true, 'ctrl'],
        [true, 'alt'],
        [true, 'delete'],
        [false, 'delete'],
        [false, 'alt'],
        [false, 'ctrl'],
      ]
    );
  });

  it('maps ASCII characters and shifted symbols to valid QEMU qcode combos', () => {
    assert.deepEqual(mapCharToQcodeCombo('a'), ['a']);
    assert.deepEqual(mapCharToQcodeCombo('Z'), ['shift', 'z']);
    assert.deepEqual(mapCharToQcodeCombo('7'), ['7']);
    assert.deepEqual(mapCharToQcodeCombo('@'), ['shift', '2']);
    assert.deepEqual(mapCharToQcodeCombo(' '), ['spc']);
    assert.deepEqual(mapCharToQcodeCombo('\n'), ['ret']);
    assert.deepEqual(mapCharToQcodeCombo('-'), ['minus']);
    assert.deepEqual(mapCharToQcodeCombo('_'), ['shift', 'minus']);
  });
});
