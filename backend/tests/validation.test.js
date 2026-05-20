import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressList, parseEpochs, parsePositiveInt, requireAddress } from '../lib/validation.js';

test('requireAddress normalizes valid addresses', () => {
  assert.equal(
    requireAddress('0xAbCdEfabcdefABCDEFabcdefABCDEFabcdefABCD'),
    '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  );
});

test('parseEpochs filters invalid values and deduplicates', () => {
  assert.deepEqual(parseEpochs('1,2,2,-1,foo,3'), [1, 2, 3]);
});

test('parsePositiveInt enforces range', () => {
  assert.equal(parsePositiveInt('7', 1, { min: 1, max: 10 }), 7);
  assert.throws(() => parsePositiveInt('0', 1, { min: 1, max: 10 }));
});

test('parseAddressList validates and normalizes all addresses', () => {
  assert.deepEqual(parseAddressList('0xAbCdEfabcdefABCDEFabcdefABCDEFabcdefABCD,0x1111111111111111111111111111111111111111'), [
    '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    '0x1111111111111111111111111111111111111111',
  ]);
});
