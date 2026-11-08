import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base58Decode, base58Encode, dangerousExtensions, isAddress, pumpBondingCurve } from '../lib/solana.js';

test('base58 round-trips, including leading zero bytes', () => {
  for (const bytes of [Uint8Array.from([0, 0, 1, 2, 255]), Uint8Array.from({ length: 32 }, (_, i) => i * 7)]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
  assert.equal(base58Encode(base58Decode('So11111111111111111111111111111111111111112')), 'So11111111111111111111111111111111111111112');
  assert.ok(isAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  assert.ok(!isAddress('not-an-address'));
});

// Test vectors: real pump.fun mints and the bonding-curve accounts RugCheck labels "Pump Fun" for them.
test('derives pump.fun bonding curve PDAs that match on-chain accounts', async () => {
  const vectors = {
    BWh8q5etuPwekJ2JEDkbMxMQWy4FysoJ8LEwE3rFpump: 'B4gDkfJerQ6UEadw3FKQakAZSLVCrJS5JCXaP1QLQAxr',
    AWaBBNoVuwQ22B8Y5nEtLne2uEfk8UaYEFws7vT7pump: '3RsrjHnzwbjxS26DasTYSy1BW9TeJFWDbqX9zWwN5QA7',
    '483nprwoMSoGQgrojSHWiePMbKPre7ZRDy4f8YNSpump': 'ABoN7MDoSg5VedtWL2bwMsxpT4LyeYBQmd57iQrqk3ZL',
  };
  for (const [mint, curve] of Object.entries(vectors)) assert.equal(await pumpBondingCurve(mint), curve);
});

test('flags Token-2022 extensions that let someone else move, tax or freeze tokens', () => {
  assert.deepEqual(dangerousExtensions([{ extension: 'metadataPointer', state: {} }, { extension: 'tokenMetadata', state: {} }]), []);
  assert.deepEqual(dangerousExtensions([{ extension: 'permanentDelegate', state: { delegate: 'x' } }]), ['permanent delegate']);
  assert.deepEqual(dangerousExtensions([{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 500 }, olderTransferFee: { transferFeeBasisPoints: 0 } } }]), ['transfer fee 5%']);
  assert.deepEqual(dangerousExtensions([{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: 'x' } }]), ['transfer fee can be enabled']);
  assert.deepEqual(dangerousExtensions([{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }, { extension: 'transferHook', state: { programId: 'p' } }]), ['accounts frozen by default', 'transfer hook']);
});
