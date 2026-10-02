// Official `antseed ants` read APIs, hosted for the web My Antseed dashboard.
// Same `{ ok, data }` envelope as apps/ants. No session token: the wallet is
// `?address=`; writes are signed in the browser.
//
// Network GETs are Antscan + SQLite (see hosted.js). They must not construct
// an AntsContext / RotatingJsonRpcProvider per request. Wallet-connect
// reward fills use one Multicall3 and persist completed epochs.
import { Router } from 'express';
import { ZeroAddress } from 'ethers';
import { resolveChainConfig } from '@antseed/node';
import { AntsContext, previewWithdraw, proofStatus } from './service/index.js';
import {
  hostedOverview,
  hostedPools,
  hostedSinglePool,
  hostedPositions,
  hostedRewards,
  hostedUsage,
  hostedEmissions,
  hostedSeller,
  hostedVerification,
  startHostedRefresh,
} from './hosted.js';

const chain = { ...resolveChainConfig('base-mainnet') };
if (!chain.explorerApiUrl) chain.explorerApiUrl = 'https://antscan.co';

startHostedRefresh();

function parseAddress(raw) {
  const value = String(raw || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value;
  return ZeroAddress;
}

function send(res, load) {
  return load()
    .then((data) => res.json({ ok: true, data }))
    .catch((error) => {
      const message = error.message || String(error);
      const status = /rate limit|timed out|unreachable|Explorer/i.test(message) ? 503 : 400;
      res.status(status).json({ ok: false, error: message });
    });
}

export function antsRouter() {
  const router = Router();

  router.get('/config', (req, res) => {
    const address = parseAddress(req.query.address);
    res.json({
      ok: true,
      data: {
        address: address === ZeroAddress ? null : address,
        chainId: chain.chainId,
        evmChainId: chain.evmChainId,
        readOnly: true,
        dataDir: null,
      },
    });
  });

  router.get('/overview', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => hostedOverview(address));
  });

  router.get('/positions', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => hostedPositions(address));
  });

  router.get('/rewards', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => hostedRewards(address));
  });

  router.get('/pools/:agentId', (req, res) => {
    const address = parseAddress(req.query.address);
    const agentId = Number(req.params.agentId);
    if (!Number.isSafeInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ ok: false, error: 'agentId must be a positive integer' });
    }
    return send(res, () => hostedSinglePool(address, agentId));
  });

  router.get('/pools', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => hostedPools(address));
  });

  router.get('/usage', (req, res) => {
    const address = parseAddress(req.query.address);
    const epochs = req.query.epochs ? Number(req.query.epochs) : undefined;
    return send(res, () => hostedUsage(address, { epochs }));
  });

  router.get('/emissions', (_req, res) => send(res, () => hostedEmissions()));

  router.get('/verification/proofs/:proofId', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => proofStatus(new AntsContext({ chain, address }), req.params.proofId));
  });

  router.get('/verification', (req, res) => {
    const sellerAddr = req.query.seller ? String(req.query.seller) : undefined;
    return send(res, () => hostedVerification(sellerAddr));
  });

  router.get('/seller', (req, res) => {
    const address = parseAddress(req.query.address);
    return send(res, () => hostedSeller(address));
  });

  router.post('/positions/withdraw/preview', (req, res) => {
    const address = parseAddress(req.query.address || req.body?.address);
    const ids = Array.isArray(req.body?.positionIds) ? req.body.positionIds : [];
    if (address === ZeroAddress) return res.status(400).json({ ok: false, error: 'address required' });
    return send(res, () => previewWithdraw(new AntsContext({ chain, address }), ids));
  });

  return router;
}
