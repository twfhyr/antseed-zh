import db from '../database.js';
import { asyncHandler } from '../lib/async.js';
import { CACHE_TTLS } from '../lib/cache.js';
import { parseAddressList, parseEpochs, requireAddress } from '../lib/validation.js';

export function registerEmissionsRoutes(app, {
  readChainMetrics,
  emissionsClient,
  emissionsV1Client,
  antsTokenClient,
  migrationEpoch,
}) {
  app.get('/api/chain-stats', (_req, res) => {
    const data = readChainMetrics();
    if (!data) {
      return res.status(503).json({ error: 'Chain metrics not yet available. Wait for the next poller cycle.' });
    }
    res.json(data);
  });

  app.get('/api/emissions/epoch-info', asyncHandler(async (_req, res) => {
    const [epochInfo, shares] = await Promise.all([
      emissionsClient.getEpochInfo(),
      emissionsClient.getShares(),
    ]);
    res.json({
      currentEpoch: epochInfo.epoch,
      currentEmission: Number(epochInfo.emission) / 1e18,
      epochDuration: epochInfo.epochDuration,
      shares,
    });
  }));

  app.get('/api/emissions/pending', asyncHandler(async (req, res) => {
    const rawAddress = requireAddress(req.query.address);
    const extraAddresses = parseAddressList(req.query.buyer_addresses);
    const epochs = parseEpochs(req.query.epochs);
    if (epochs.length === 0) return res.json({ seller: '0', buyer: '0', epochs: [] });

    const bustCache = req.query.bust === '1';
    const cacheKey = rawAddress + (extraAddresses.length ? `:${extraAddresses.join(',')}` : '');
    const cached = bustCache ? null : db.prepare('SELECT data, fetched_at FROM address_emissions WHERE address = ?').get(cacheKey);
    if (cached && Date.now() - cached.fetched_at < CACHE_TTLS.addressEmissions) {
      return res.json(JSON.parse(cached.data));
    }

    const dbBuyers = db.prepare('SELECT buyer FROM operator_buyers WHERE operator = ?').all(rawAddress);
    const dbBuyerAddresses = dbBuyers.map((row) => row.buyer);
    const allAddresses = [rawAddress, ...extraAddresses, ...dbBuyerAddresses.filter((addr) => !extraAddresses.includes(addr) && addr !== rawAddress)];
    const uniqueAddresses = [...new Set(allAddresses.map((addr) => addr.toLowerCase()))];
    const epochInfo = await emissionsClient.getEpochInfo();
    const currentEpoch = Number(epochInfo.epoch);
    const epochDetails = [];
    let sellerTotal = 0;
    let buyerTotal = 0;

    for (const epoch of epochs) {
      const isCurrent = epoch >= currentEpoch;
      let epochSellerPts = 0;
      let epochBuyerPts = 0;
      let epochSellerReward = 0;
      let epochBuyerReward = 0;
      let epochSellerClaimed = false;
      let epochBuyerClaimed = false;

      for (const addr of uniqueAddresses) {
        const [sp, bp, esp, ebp, sc, bc, epochEmission] = await Promise.all([
          emissionsClient.userSellerPoints(addr, epoch),
          emissionsClient.userBuyerPoints(addr, epoch),
          emissionsClient.epochTotalSellerPoints(epoch),
          emissionsClient.epochTotalBuyerPoints(epoch),
          emissionsClient.sellerEpochClaimed(addr, epoch),
          emissionsClient.buyerEpochClaimed(addr, epoch),
          emissionsClient.getEpochEmission(epoch),
        ]);

        let v1SellerPts = 0;
        let v1BuyerPts = 0;
        let v1TotalSellerPts = 0;
        let v1TotalBuyerPts = 0;
        if (epoch <= migrationEpoch) {
          const [v1sp, v1bp, v1esp, v1ebp] = await Promise.all([
            emissionsV1Client.userSellerPoints(addr, epoch),
            emissionsV1Client.userBuyerPoints(addr, epoch),
            emissionsV1Client.epochTotalSellerPoints(epoch),
            emissionsV1Client.epochTotalBuyerPoints(epoch),
          ]);
          v1SellerPts = Number(v1sp);
          v1BuyerPts = Number(v1bp);
          v1TotalSellerPts = Number(v1esp);
          v1TotalBuyerPts = Number(v1ebp);

          if (epoch < migrationEpoch) {
            const [v1sc, v1bc] = await Promise.all([
              emissionsV1Client.sellerEpochClaimed(addr, epoch),
              emissionsV1Client.buyerEpochClaimed(addr, epoch),
            ]);
            if (v1sc) epochSellerClaimed = true;
            if (v1bc) epochBuyerClaimed = true;
          }
        }

        const userSellerPts = Number(sp) + v1SellerPts;
        const userBuyerPts = Number(bp) + v1BuyerPts;
        const totalSellerPts = Number(esp) + v1TotalSellerPts;
        const totalBuyerPts = Number(ebp) + v1TotalBuyerPts;
        const emission = Number(epochEmission) / 1e18;

        if (userSellerPts > 0 || userBuyerPts > 0) {
          epochSellerPts += userSellerPts;
          epochBuyerPts += userBuyerPts;

          if (isCurrent) {
            epochSellerReward += totalSellerPts > 0 ? (userSellerPts / totalSellerPts) * emission * 0.5 : 0;
            epochBuyerReward += totalBuyerPts > 0 ? (userBuyerPts / totalBuyerPts) * emission * 0.2 : 0;
          } else {
            const pending = await emissionsClient.pendingEmissions(addr, [epoch]);
            epochSellerReward += Number(pending.seller) / 1e18;
            epochBuyerReward += Number(pending.buyer) / 1e18;
            if (epoch <= migrationEpoch) {
              const v1Pending = await emissionsV1Client.pendingEmissions(addr, [epoch]);
              epochSellerReward += Number(v1Pending.seller) / 1e18;
              epochBuyerReward += Number(v1Pending.buyer) / 1e18;
            }
          }
        }

        if (sc) epochSellerClaimed = true;
        if (bc) epochBuyerClaimed = true;
      }

      epochDetails.push({
        epoch,
        sellerPoints: epochSellerPts,
        buyerPoints: epochBuyerPts,
        sellerReward: epochSellerReward,
        buyerReward: epochBuyerReward,
        sellerClaimed: epochSellerClaimed,
        buyerClaimed: epochBuyerClaimed,
        isCurrentEpoch: isCurrent,
      });
    }

    for (const addr of uniqueAddresses) {
      const pending = await emissionsClient.pendingEmissions(addr, epochs);
      sellerTotal += Number(pending.seller) / 1e18;
      buyerTotal += Number(pending.buyer) / 1e18;
      const v1Epochs = epochs.filter((epoch) => epoch <= migrationEpoch);
      if (v1Epochs.length > 0) {
        const v1Pending = await emissionsV1Client.pendingEmissions(addr, v1Epochs);
        sellerTotal += Number(v1Pending.seller) / 1e18;
        buyerTotal += Number(v1Pending.buyer) / 1e18;
      }
    }

    const data = {
      seller: sellerTotal.toFixed(6),
      buyer: buyerTotal.toFixed(6),
      epochs: epochDetails,
    };

    db.prepare('INSERT OR REPLACE INTO address_emissions (address, data, fetched_at) VALUES (?, ?, ?)').run(
      cacheKey,
      JSON.stringify(data),
      Date.now()
    );

    res.json(data);
  }));

  app.get('/api/operator-buyers', (req, res) => {
    const operator = req.query.operator;
    if (operator) {
      const normalized = requireAddress(operator, 'operator');
      const rows = db.prepare('SELECT operator, buyer FROM operator_buyers WHERE operator = ?').all(normalized);
      return res.json(rows);
    }
    const rows = db.prepare('SELECT operator, buyer FROM operator_buyers').all();
    res.json(rows);
  });

  app.post('/api/operator-buyers', (req, res) => {
    const operator = requireAddress(req.body.operator, 'operator');
    const buyer = requireAddress(req.body.buyer, 'buyer');
    db.prepare('INSERT OR IGNORE INTO operator_buyers (operator, buyer) VALUES (?, ?)').run(operator, buyer);
    res.json({ ok: true });
  });

  app.delete('/api/operator-buyers', (req, res) => {
    const operator = requireAddress(req.body.operator, 'operator');
    const buyer = requireAddress(req.body.buyer, 'buyer');
    db.prepare('DELETE FROM operator_buyers WHERE operator = ? AND buyer = ?').run(operator, buyer);
    res.json({ ok: true });
  });

  app.get('/api/emissions/claimed', asyncHandler(async (req, res) => {
    const address = requireAddress(req.query.address);
    const epochs = parseEpochs(req.query.epochs);
    if (epochs.length === 0) return res.json({ seller: [], buyer: [] });

    const sellerStatuses = await Promise.all(epochs.map((epoch) => emissionsClient.sellerEpochClaimed(address, epoch)));
    const buyerStatuses = await Promise.all(epochs.map((epoch) => emissionsClient.buyerEpochClaimed(address, epoch)));
    const legacyEpochs = epochs.filter((epoch) => epoch < migrationEpoch);
    const v1SellerStatuses = await Promise.all(legacyEpochs.map((epoch) => emissionsV1Client.sellerEpochClaimed(address, epoch)));
    const v1BuyerStatuses = await Promise.all(legacyEpochs.map((epoch) => emissionsV1Client.buyerEpochClaimed(address, epoch)));
    const v1EpochIndexes = {};
    legacyEpochs.forEach((epoch, index) => { v1EpochIndexes[epoch] = index; });

    res.json({
      seller: epochs.map((epoch, index) => ({
        epoch,
        claimed: sellerStatuses[index] || (v1EpochIndexes[epoch] !== undefined ? v1SellerStatuses[v1EpochIndexes[epoch]] : false),
      })),
      buyer: epochs.map((epoch, index) => ({
        epoch,
        claimed: buyerStatuses[index] || (v1EpochIndexes[epoch] !== undefined ? v1BuyerStatuses[v1EpochIndexes[epoch]] : false),
      })),
    });
  }));

  app.get('/api/emissions/balance', asyncHandler(async (req, res) => {
    const address = requireAddress(req.query.address);
    const cached = db.prepare('SELECT ants, fetched_at FROM address_balances WHERE address = ?').get(address);
    if (cached && Date.now() - cached.fetched_at < CACHE_TTLS.addressBalances) {
      return res.json({ ants: cached.ants });
    }

    const balance = await antsTokenClient.balanceOf(address);
    const ants = Number(balance) / 1e18;
    db.prepare('INSERT OR REPLACE INTO address_balances (address, ants, fetched_at) VALUES (?, ?, ?)').run(address, ants, Date.now());
    res.json({ ants });
  }));
}
