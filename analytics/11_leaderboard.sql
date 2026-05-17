-- Per-Epoch Buyer Leaderboard Ranked by Spend
-- Joins settlements with epoch boundaries derived from Emissions V2 contract
-- Uses BuyerPointsAccrued event to determine epoch transitions

WITH epoch_starts AS (
  SELECT DISTINCT
    epoch,
    MIN(block_time) OVER (PARTITION BY epoch) AS epoch_start
  FROM (
    SELECT
      CAST(topic2 AS BIGINT) AS epoch,
      block_time
    FROM base.logs
    WHERE contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088
      AND topic0 = 0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db
  ) t
),
epoch_ranges AS (
  SELECT
    e1.epoch,
    e1.epoch_start,
    COALESCE(e2.epoch_start, NOW()) AS epoch_end
  FROM epoch_starts e1
  LEFT JOIN epoch_starts e2 ON e2.epoch = e1.epoch + 1
),
epoch_spending AS (
  SELECT
    s.buyer,
    SUM(s.usdc_amount) AS total_spent,
    e.epoch
  FROM antseed_base.settlements s
  JOIN epoch_ranges e
    ON s.block_time >= e.epoch_start
    AND s.block_time < e.epoch_end
  GROUP BY e.epoch, s.buyer
)
SELECT
  epoch,
  buyer,
  total_spent,
  ROW_NUMBER() OVER (PARTITION BY epoch ORDER BY total_spent DESC) AS rank
FROM epoch_spending
ORDER BY epoch, rank
LIMIT 100
