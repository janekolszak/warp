import fs from 'fs';

import ArLocal from 'arlocal';
import Arweave from 'arweave';
import { JWKInterface } from 'arweave/node/lib/wallet';
import path from 'path';
import { mineBlock } from '../_helpers';
import { PstContract, PstState } from '../../../contract/PstContract';
import { Warp } from '../../../core/Warp';
import { WarpFactory } from '../../../core/WarpFactory';
import { LoggerFactory } from '../../../logging/LoggerFactory';
import exp from 'constants';

describe('Testing unsafe client in nested contracts with "skip" option', () => {
  let contractSrc: string;

  let wallet: JWKInterface;
  let walletAddress: string;

  let initialState: PstState;

  let arweave: Arweave;
  let arlocal: ArLocal;
  let warp: Warp;
  let pst: PstContract;
  let unsafeContractTxId: string;

  beforeAll(async () => {
    arlocal = new ArLocal(1666, false);
    await arlocal.start();
    LoggerFactory.INST.logLevel('error');
    warp = WarpFactory.forLocal(1666);

    ({ arweave } = warp);
    ({ jwk: wallet, address: walletAddress } = await warp.generateWallet());

    contractSrc = fs.readFileSync(path.join(__dirname, '../data/token-pst.js'), 'utf8');
    const stateFromFile: PstState = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/token-pst.json'), 'utf8'));

    initialState = {
      ...stateFromFile,
      ...{
        owner: walletAddress,
        balances: {
          ...stateFromFile.balances,
          [walletAddress]: 555669
        }
      }
    };

    const { contractTxId } = await warp.createContract.deploy({
      wallet,
      initState: JSON.stringify(initialState),
      src: contractSrc
    });
    pst = warp.pst(contractTxId).setEvaluationOptions({
      unsafeClient: 'skip'
    }) as PstContract;
    pst.connect(wallet);

    const unsafeContractSrc = fs.readFileSync(path.join(__dirname, '../data/token-pst-unsafe.js'), 'utf8');
    ({ contractTxId: unsafeContractTxId } = await warp.createContract.deploy({
      wallet,
      initState: JSON.stringify(initialState),
      src: unsafeContractSrc
    }));
    await mineBlock(warp);
  });

  afterAll(async () => {
    await arlocal.stop();
  });

  it('should properly transfer tokens', async () => {
    await pst.transfer({
      target: 'uhE-QeYS8i4pmUtnxQyHD7dzXFNaJ9oMK-IM-QPNY6M',
      qty: 555
    });

    await mineBlock(warp);

    expect((await pst.currentState()).balances[walletAddress]).toEqual(555669 - 555);
    expect((await pst.currentState()).balances['uhE-QeYS8i4pmUtnxQyHD7dzXFNaJ9oMK-IM-QPNY6M']).toEqual(10000000 + 555);
  });

  it('should stop evaluation of a nested unsafe contract', async () => {
    const readUnsafeTx = await pst.writeInteraction({
      function: 'readUnsafe',
      contractTxId: unsafeContractTxId
    });
    await mineBlock(warp);

    const result = await pst.readState();

    expect(Object.keys(result.cachedValue.validity).length == 2);
    expect(Object.keys(result.cachedValue.errorMessages).length == 2);

    console.log(result.cachedValue.validity);
    console.log(result.cachedValue.errorMessages);

    expect(result.cachedValue.validity[readUnsafeTx.originalTxId]).toBe(false);
    expect(result.cachedValue.errorMessages[readUnsafeTx.originalTxId]).toMatch(
      'Skipping evaluation of the unsafe contract'
    );

    // note: the 'readUnsafe' function - after successful readState from an unsafe contract - should clear its state
    // if the state wasn't cleared, then this mean tha the 'readContractState' on an unsafe contract call threw 'ContractError'
    // - as expected
    expect(result.cachedValue.state).not.toEqual({});
  });
});
