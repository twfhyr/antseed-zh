-- ANTS Released vs Claimed per Epoch
-- Emissions V2 contract: 0xF13bE52c4A3afC6AE29536f073588d01A0564088
-- Events used:
--   BuyerPointsAccrued:  0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db
--   SellerPointsAccrued: 0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54
--   BuyerEmissionsClaimed:  0x55dbb74b8ed455500bea764ff26f8559862d6dd3e6632f82fdbb88091f68a0e8
--   SellerEmissionsClaimed: 0xcf2009d50759437c9362a19e2512aa0160296153d63c36dfb6dacd1f83857baf
--
-- Share percentages (from contract):
--   sellerSharePct=50, buyerSharePct=20, reserveSharePct=10, teamSharePct=20

WITH decoded_buyer_points AS (
  SELECT * FROM TABLE (
    decode_evm_event (
      abi => '[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":true,"internalType":"uint256","name":"epoch","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"pointsDelta","type":"uint256"}],"name":"BuyerPointsAccrued","type":"event"}]',
      input => TABLE (SELECT * FROM base.logs WHERE contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088 AND topic0 = 0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db)
    )
  )
),
decoded_seller_points AS (
  SELECT * FROM TABLE (
    decode_evm_event (
      abi => '[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":true,"internalType":"uint256","name":"epoch","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"pointsDelta","type":"uint256"}],"name":"SellerPointsAccrued","type":"event"}]',
      input => TABLE (SELECT * FROM base.logs WHERE contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088 AND topic0 = 0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54)
    )
  )
),
epoch_buyer_points AS (
  SELECT epoch, SUM(pointsDelta) AS total_buyer_points
  FROM decoded_buyer_points
  GROUP BY epoch
),
epoch_seller_points AS (
  SELECT epoch, SUM(pointsDelta) AS total_seller_points
  FROM decoded_seller_points
  GROUP BY epoch
),
-- BuyerEmissionsClaimed(caller indexed, recipient indexed, amount, reserveDeduct, epochs[])
-- data layout: amount (uint256), reserveDeduct (uint256), offset, length, epoch1, epoch2, ...
buyer_claimed AS (
  SELECT
    epoch,
    SUM(CAST(amount AS DOUBLE) / 1e18) AS buyer_claimed
  FROM (
    SELECT
      UNNEST(decoded_epochs) AS epoch,
      CAST(data_amount AS DOUBLE) / 1e18 / array_length(decoded_epochs) AS amount
    FROM (
      SELECT
        -- Extract amount from data (first 32 bytes)
        CAST(SUBSTRING(data, 1, 32) AS BYTEA) AS data_amount_raw,
        -- For simplicity, use the per-epoch aggregation from the events
        block_time,
        tx_hash
      FROM base.logs
      WHERE contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088
        AND topic0 = 0x55dbb74b8ed455500bea764ff26f8559862d6dd3e6632f82fdbb88091f68a0e8
    ) t
  ) t2
  GROUP BY epoch
)
SELECT
  bp.epoch,
  bp.total_buyer_points,
  sp.total_seller_points,
  COALESCE(bc.buyer_claimed, 0) AS buyer_claimed_ants
FROM epoch_buyer_points bp
LEFT JOIN epoch_seller_points sp ON bp.epoch = sp.epoch
LEFT JOIN buyer_claimed bc ON bp.epoch = bc.epoch
ORDER BY bp.epoch
